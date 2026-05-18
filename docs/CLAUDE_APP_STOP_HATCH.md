# App — End hatch early (stop-hatch with reason)

> Currently the only way to end a hatch in the App is to delete it,
> which destroys all the linked data — sensor readings, alerts,
> milestones, notes. Andrew flagged this as a real product gap on
> 2026-05-09: a serious hatcher whose hatch goes wrong on day 15
> wants to KEEP the log of what happened, not erase it. This brief
> adds an "End hatch early" path that preserves all data.
>
> Cloud schema (migration 021) ships in parallel. App work below.

---

## The user scenario

> *"It's day 14 of a 21-day chicken hatch. I candled the eggs and 6
> of 12 are clear. Not worth running another week with low load. I
> want to end the hatch now, write down what I found, and keep the
> readings + alert history so I can review what conditions looked
> like in the days leading up to the candling."*

The same applies to: temperature excursion that killed the eggs,
contamination, equipment failure, accidental drop, change of plans.
The data leading up to the failure is the most valuable data the
user will collect on that hatch.

Today the only option is Delete → confirms → all gone. That's a
regression vs spreadsheet-keeping.

---

## What changed cloud-side

Migration 021 adds three columns + widens the status check:

```sql
alter table hatch_logs
  add column stopped_at       timestamptz,
  add column stopped_reason   text,
  add column stopped_category text;

-- status now allows: 'active', 'completed', 'failed', 'stopped', 'archived'
```

### Status semantics (post-migration)

| Status | Meaning |
|---|---|
| `active` | Currently running, hasn't reached expected_hatch_date |
| `completed` | Reached expected_hatch_date with a successful hatch outcome |
| `failed` | Reached expected_hatch_date but no/poor hatch (existing — not changed) |
| **`stopped`** | **NEW — user ended early, before expected_hatch_date** |
| `archived` | Future use (older hatches hidden from default lists) |

`stopped` is intentionally distinct from `failed`:

- `failed` = ran the full cycle, didn't produce hatchlings
- `stopped` = user pulled the plug before expected_hatch_date

This distinction matters for analytics — failed hatches are about
incubation conditions, stopped hatches are about user decisions.

---

## What the App needs to do

### 1. Add an "End hatch early" action

On the hatch detail screen, replace or expand the existing destructive
action with a small menu. Suggested:

```
[ ⋮ ]
  ├─ Mark as completed (if user wants to manually close at hatch day)
  ├─ End hatch early...
  └─ Delete (with strong confirmation — preserves no data)
```

"Delete" stays as a last-resort option, but "End hatch early" should
be the primary off-ramp — make it visually prominent in the menu.

### 2. The "End hatch early" sheet

```
┌─ End hatch early ──────────────────────────┐
│                                            │
│ Today is day 14 of 21. The hatch and all   │
│ its logs will be preserved — readings,     │
│ alerts, milestones, notes. New sensor      │
│ data will continue recording but won't be  │
│ tied to this hatch after now.              │
│                                            │
│ Reason category (optional):                │
│ [ Eggs not viable             ▼ ]          │
│                                            │
│ What happened?                             │
│ ┌──────────────────────────────────────┐   │
│ │ Found 6 of 12 eggs were clear on     │   │
│ │ day 14 candling. Decided to end      │   │
│ │ rather than continue with low load.  │   │
│ └──────────────────────────────────────┘   │
│                                            │
│ [ Cancel ]              [ End hatch ]      │
└────────────────────────────────────────────┘
```

Field requirements:

- **Reason text** is optional (a hatcher in a rush should be able to
  end without having to articulate it). But strongly encouraged with
  placeholder copy that prompts.
- **Category** is optional dropdown. Below.
- **End hatch button**: confirms the action. No second confirmation
  dialog — the sheet itself is the confirmation moment.

### 3. Category dropdown values

Suggested presets (write to cloud as the snake_case key, display the
human label):

| Key | Display label |
|---|---|
| `equipment_failure` | Equipment failure (incubator, fan, heater) |
| `temperature_excursion` | Temperature problem (spike or drop) |
| `humidity_excursion` | Humidity problem |
| `power_outage` | Power outage |
| `eggs_not_viable` | Eggs not viable (after candling) |
| `contamination` | Contamination (bacterial / mould) |
| `accident` | Accident (dropped, knocked over) |
| `other` | Other (use the reason field) |

Keep the dropdown short; it's a categorical pivot for future
analytics, not an exhaustive taxonomy.

### 4. The cloud write

When the user taps "End hatch":

```dart
final now = DateTime.now().toUtc().toIso8601String();
await supabase.from('hatch_logs').update({
  'status': 'stopped',
  'stopped_at': now,
  'stopped_reason': reasonText.trim().isEmpty ? null : reasonText.trim(),
  'stopped_category': category,  // null if not selected
}).eq('id', hatchId).eq('user_id', userId);
```

Single UPDATE. Don't touch `expected_hatch_date` — leave it as the
originally-planned date (it's useful context: "stopped on day 14
of 21" is computed from `stopped_at - start_date` vs
`expected_hatch_date - start_date`).

### 5. Display the stopped state on the hatch detail screen

When the hatch's `status === 'stopped'`, show a banner at the top of
the detail screen:

```
┌────────────────────────────────────────────┐
│ Hatch ended early                          │
│ Stopped on Sun 24 May, day 14 of 21        │
│                                            │
│ Eggs not viable                            │
│ "Found 6 of 12 eggs were clear on day      │
│ 14 candling. Decided to end rather than    │
│ continue with low load."                   │
└────────────────────────────────────────────┘
```

Below the banner, the existing UI continues — sensor readings,
alerts, milestones, notes. The hatch is read-only after stop:

- No new alerts fire for this hatch
- No new milestones can be added
- The notes field can stay editable so the user can add follow-ups
  ("ordered new eggs, restarting next week"), but it's a product
  call — read-only is also fine.

### 6. List filtering

The hatches list (home screen, hatches tab) should default to showing
`active` hatches only.

A toggle or tab brings in `completed`, `failed`, and `stopped`. The
visual style for each status should be distinct:

- **active** — primary green
- **completed** — gold (success)
- **failed** — red border (existing)
- **stopped** — amber/grey (ended-early; not failure, just early)
- **archived** — hidden by default, accessible via a separate filter

---

## What stays the same

- All `sensor_readings` continue to flow regardless of hatch status
- `hatch_sensors` links remain so historical queries work
- The cloud's hatch-related endpoints don't filter on status (they
  return all hatches; the App and Primus apply their own filters)
- Nothing changes for the Primus dashboard — it already filters
  `/primus/hatches` to `status = 'active'`, so stopped hatches
  automatically disappear from its UI

---

## Acceptance test

1. **Create a fresh hatch.** Confirm appears in the App's active list.
2. **End early without a category.** Tap menu → End hatch early →
   leave both fields empty → tap End hatch. Hatch transitions to
   `stopped` state. Banner shows "Stopped on [today], day N of M"
   with no reason text.
3. **End early with full reason.** Pick "Eggs not viable" + write a
   sentence → tap End hatch. Cloud row stores `stopped_category =
   'eggs_not_viable'`, `stopped_reason = "..."`, `status = 'stopped'`,
   `stopped_at = <now>`.
4. **Open the stopped hatch.** Banner displays the category + reason.
   All sensor readings + alerts + milestones from before stopping
   are preserved and visible.
5. **List filtering.** Default home screen shows only active hatches.
   Stopped hatch appears under a "Past hatches" or similar filter.
6. **Verify on Primus.** Stopped hatch disappears from Primus LCD's
   active hatches list within ~5 minutes (Primus polls
   `/primus/hatches` and that endpoint filters on `status = 'active'`).

---

## Why this matters

Three things this enables that "delete to start over" doesn't:

1. **Post-mortem analysis.** The user can review the temperature /
   humidity / alert pattern leading up to the failure and figure out
   what went wrong. Deleted hatches teach nothing.
2. **Insurance / records.** Some commercial hatcheries log every
   attempt with cause-of-failure for audits or quality programs.
3. **Aggregate trends.** "I've stopped 4 hatches this year, all
   marked 'temperature_excursion'" is a strong signal something's
   wrong with the incubator. Lost when the rows are deleted.

This is a small UI change with outsized credibility impact —
serious hatchers will notice it and it pushes the product from
"hobbyist tool" to "operational instrument."

— Claude (Cloud session)
