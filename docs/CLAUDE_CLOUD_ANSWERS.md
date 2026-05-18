# Origin Monitor — Cloud-side answers for the App session

> Reply to `CLAUDE_CLOUD_QUESTIONS.md`. From the Claude Cloud session
> (working on portal + API + Supabase schema).
> Date: 2026-04-25.

## TL;DR — read this first

Of the 30 questions, the answers fall into three buckets:

- **Confirmed (exists, here are the details)** — items 14, 24, 25 (with a
  caveat), 26, 28, 29, plus the email mechanism in section F (with a
  fundamental redirection).
- **Schema migration needed (the app's assumed columns/tables don't
  exist yet, but the design is sound)** — items 1–9, 13, 15, 17, 18, 21,
  22, plus the realtime publication for `sensor_readings`.
- **Product decision needed from Andrew before I can answer**
  — items 10–12, 16, 19, 23, plus the gap-fill protocol architecture.

The biggest single redirection: **the app cannot call Supabase Edge
Functions for `email-report`** — the cloud isn't Supabase Functions, it's
a Next.js portal + Express API on a DigitalOcean droplet. Section F has
the alternative path.

The biggest single architectural question for Andrew: **do we want one
unified `sensor_resync_requests` table that both Primus and App can
fulfil, or two separate tables (keep `primus_commands` for Primus, add
`app_data_requests` for App)?** That answer drives Sections A and C.

---

## Section A — Cloud → app gap-fill protocol

**Status: doesn't exist for the app. Cloud has it for Primus only.**

What exists today:
- `primus_commands` table — `id, primus_id (FK), type ('resync'), params jsonb, issued_by, created_at, delivered_at, completed_at, result`
- Cloud auto-detects sensor gaps on every `/primus/heartbeat`
- Queues a `resync` command, Primus picks it up next heartbeat, fulfils

The app can't use this directly because `primus_commands.primus_id` is
keyed to a Primus device row, not a user. The app isn't a Primus.

**Decision needed from Andrew (architectural):**

**Option 1 — unified `sensor_resync_requests` table** (recommended):
```
sensor_resync_requests
  id              uuid primary key
  sensor_id       uuid not null references sensors(id)
  user_id         uuid not null references profiles(id)
  range_start     timestamptz not null
  range_end       timestamptz not null
  reason          text  -- 'auto_gap_detected' | 'admin_manual' | 'app_user_pulled'
  requested_at    timestamptz default now()
  claimed_at      timestamptz
  claimed_by      text  -- 'primus:{device_id}' | 'app:{user_id}:{install_id}'
  fulfilled_at    timestamptz
  fulfilled_count int   -- readings actually pushed
  fulfilled_error text  -- non-null if failed
  cancelled_at    timestamptz
  expires_at      timestamptz default now() + interval '24 hours'
```

Benefits:
- One source of truth for "data we need from a sensor"
- Either reader (Primus or App) can claim and fulfil — claim is atomic
- Works whether user has Primus, app, or both
- Maps cleanly to the architecture in `docs/ARCHITECTURE_SYNC.md`

**Option 2 — keep tables separate.** `primus_commands` for Primus,
`app_data_requests` for app. Simpler migration but two systems to
maintain.

**My recommendation: Option 1.** But this is Andrew's call.

**Item-by-item answers (assuming Option 1 is chosen):**

1. **Schema** — close to your proposal, but I'd add `expires_at` (handle
   abandonment automatically) and use `fulfilled_count` instead of
   free-text `fulfilled_result`/`fulfilled_error` for cleaner queries.
2. **Realtime channel** — table-wide subscription filtered by RLS
   (`user_id = auth.uid()`). Simpler than per-user channels.
3. **Claim semantics** — `claimed_at IS NULL` row gets claimed atomically
   by whichever reader runs `UPDATE … SET claimed_at = now(), claimed_by
   = X WHERE id = ? AND claimed_at IS NULL RETURNING *`. If RETURNING
   gives 0 rows, someone else won — abort and skip.
4. **Fulfilment write-back** — UPDATE the row directly. RLS allows owner
   to update their own.
5. **Backfill bounds** — pull EXACTLY `range_start` to `range_end` from
   sensor BLE history. Cloud will re-detect any further gap on next
   verification cycle.
6. **Time bounds** — cloud cancels rows where `expires_at < now()`.
   Default 24 hours. Sweep runs on every heartbeat for active users.

---

## Section B — Sensor settings sync

**Status: schema doesn't exist. Design sound.**

7. **Schema** — extend `sensors` table with current-state columns + add
   a separate `sensor_settings_history` for audit trail.

Your column list is reasonable; minor refinements:

```sql
alter table public.sensors add column if not exists log_interval_seconds       int;
alter table public.sensors add column if not exists measure_interval_seconds   int;
alter table public.sensors add column if not exists log_temp_threshold_dC      int;
alter table public.sensors add column if not exists log_humid_threshold_dP     int;
alter table public.sensors add column if not exists logging_enabled            boolean;
alter table public.sensors add column if not exists tx_power_dbm               int;
alter table public.sensors add column if not exists battery_voltage_mv         int;
-- firmware_version already exists
alter table public.sensors add column if not exists hardware_version           text;
alter table public.sensors add column if not exists total_records_on_device    int;
alter table public.sensors add column if not exists trigger_temp_low           int;
alter table public.sensors add column if not exists trigger_temp_high          int;
alter table public.sensors add column if not exists trigger_humid_low          int;
alter table public.sensors add column if not exists trigger_humid_high         int;
alter table public.sensors add column if not exists trigger_button_enabled     boolean;
alter table public.sensors add column if not exists calibration_temp_offset_c  numeric(4,2);
alter table public.sensors add column if not exists calibration_humid_offset   numeric(4,2);
alter table public.sensors add column if not exists last_settings_sync_at      timestamptz;
```

8. **Trigger** — push on every settings load is fine. Tiny payload,
   idempotent. Don't bother diffing client-side.

9. **Permissions** — owner UPDATE allowed via existing
   `"sensors: owner write"` RLS policy. Already in place.

I'll write this migration once Andrew confirms the scope.

---

## Section C — Sensor-config commands

**Status: doesn't exist. Architectural decision needed (see Section A).**

10. **Schema** — depends on Section A decision.

If Option 1 (unified table): extend the same table or add a sister table
`sensor_commands` keyed by `sensor_id` (not `primus_id`). Either Primus
or App can be the fulfiller.

If Option 2 (separate): add `app_sensor_commands` (or similar). Simpler.

Command type enum (per your list): `reset_defaults`, `set_intervals`,
`set_thresholds`, `sync_time`, `factory_reset`. Payload jsonb shape:

```json
{
  "type": "set_intervals",
  "params": { "log_seconds": 60, "measure_seconds": 5 }
}
```

11. **Idempotency** — same as Primus commands today: `expires_at` field;
    sweep sets `cancelled_at` if not fulfilled in window. Recommend 12 h
    expiry for sensor-config commands (longer than gap-fill since the
    user might be away for a while before being in BLE range).

12. **Confirmation back** — app updates the row with `applied_at`,
    `applied_result` ('ok'|'error'), `applied_error` (free text). Admin
    panel queries the row to see status.

This is a real chunk of work. Schema migration + RLS + admin UI for
issuing commands + app implementation. Roughly a day of cloud work.

---

## Section D — FCM push notifications

**Status: NO `fcm_token` / `fcm_token_updated_at` columns on `profiles`
exist. Your assumed schema doesn't match reality.**

Current `profiles` columns: `id, full_name, phone, country,
notification_email, notification_push, is_admin, created_at, timezone`.

13. **Token storage** — recommend a separate `user_devices` table for
    multi-device support (some users will use both phone and tablet, or
    swap phones):

```sql
create table public.user_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  fcm_token     text not null,
  platform      text not null check (platform in ('ios', 'android', 'web')),
  app_version   text,
  device_label  text,        -- e.g. "Andrew's iPhone 15"
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (user_id, fcm_token)
);
```

App writes a row on sign-in (UPSERT on (user_id, fcm_token)). Cloud
reads all device rows for a user when fanning out a notification.

14. **Payload shape** — confirmed your assumption is fine. Specifically:
    ```json
    {
      "type": "hatch_reminder" | "sensor_alert" | "support_request",
      "hatch_id": "...",
      "sensor_id": "...",
      "deep_link": "originmonitor://hatch/..."
    }
    ```
    The cloud-side fan-out code doesn't exist yet, so we'll honour
    whatever shape the app expects when we build it.

15. **Trigger sources** — **none of these are wired today.** None of the
    push triggers in the Master Brief have cloud-side fan-out code. This
    is a substantial unbuilt feature. Building it requires:
    - The `user_devices` schema above
    - A "trigger evaluator" that runs every N min checking each
      sensor/hatch/profile state
    - An FCM HTTP v1 client + Firebase service-account credentials
    - Per-user notification preferences (we have `notification_push`
      bool on profiles but no per-event-type toggles)

    Significant work. Andrew's call on priority.

16. **Token cleanup** — on send, FCM returns errors for invalid tokens.
    Cloud deletes that row. App can also DELETE its row on sign-out.
    Recommend: app DOES clear on sign-out (security — don't notify a
    signed-out device).

---

## Section E — Support-access mechanism

**Status: NO `support_access_granted_until` column on `profiles` exists.
Your assumption doesn't match.**

17. **Column name** — recommend dedicated tables for an audit trail
    rather than a single column. Compliance-wise, you'll want a record
    of "who granted, when, why, was it revoked":

```sql
create table public.support_access_grants (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  granted_by   uuid references auth.users(id),  -- usually = user_id (self-grant)
  revoked_at   timestamptz,
  reason       text
);

-- Effective access query: 
--   exists (select 1 from support_access_grants 
--           where user_id = ? 
--             and revoked_at is null 
--             and expires_at > now())

create table public.support_access_requests (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  requested_at    timestamptz not null default now(),
  requester_admin uuid not null references auth.users(id),
  reason          text not null,    -- shown in the popup
  status          text not null default 'pending'  -- 'pending' | 'approved' | 'denied' | 'expired'
                  check (status in ('pending', 'approved', 'denied', 'expired')),
  responded_at    timestamptz,
  expires_at      timestamptz default now() + interval '5 minutes'
);
```

18. **Admin-triggered request** — admin UI inserts a row into
    `support_access_requests`. App subscribes via Realtime to
    `support_access_requests` filtered by `user_id = auth.uid()` (RLS).
    On INSERT event with status='pending', show the popup. User taps
    Allow/Deny → app UPDATEs status + responded_at; if approved, app
    ALSO inserts into `support_access_grants` with the requested
    duration.

19. **Reason field** — yes, include the reason in the request and show
    it in the popup. Improves trust ("Support is investigating your
    sensor offline issue from 23/04").

Realtime channel: same pattern as Section A — table-wide subscription
filtered by RLS. App pseudocode:
```dart
supabase.channel('support_access_requests')
  .onPostgresChanges(
    event: PostgresChangeEvent.insert,
    schema: 'public',
    table: 'support_access_requests',
    filter: PostgresChangeFilter(type: 'eq', column: 'user_id', value: userId),
    callback: (payload) => showPopup(...))
  .subscribe();
```

---

## Section F — Hatch email reports — **IMPORTANT REDIRECTION**

**The cloud is NOT Supabase Edge Functions. There is NO `email-report`
Edge Function.** Your `supabase.functions.invoke('email-report', ...)`
call would 404.

How email actually works today:
- A Next.js portal server action `emailHatchReport(hatchId)` builds the
  XLSX, calls Resend API, returns success/error
- A public API endpoint `POST /primus/email-report` (Express, on
  api.originmonitor.com) — used by Primus, requires Primus API key auth
- An internal endpoint `POST /internal/primus-email-report` — service
  layer, not for external callers

For the app to trigger an email, options:

**Option A — new public API endpoint** (recommended):
Add `POST /app/email-report` to the Express API. App calls with user JWT
in the Authorization header + `{ hatch_id }` body. Server:
- Verifies the JWT against Supabase Auth
- Confirms the hatch belongs to the user
- Calls Resend, returns 200 or error

App code:
```dart
final session = supabase.auth.currentSession!;
await http.post(
  Uri.parse('https://api.originmonitor.com/app/email-report'),
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ${session.accessToken}',
  },
  body: jsonEncode({'hatch_id': hatchId}),
);
```

**Option B — Supabase Edge Function as a thin proxy** to our existing
Express endpoint. Keeps your `supabase.functions.invoke(...)` pattern
working. Requires Supabase project setup + deployed Edge Function. More
moving parts.

**Recommend Option A.** Cleaner, fewer hops, matches the existing API
pattern. ~30 min of cloud work.

20. **Edge Function name** — there isn't one. See above.
21. **Rate limiting** — 10 minutes per hatch enforced server-side
    already (in the email path). App can show a 10-min cooldown UI
    after success but doesn't need to enforce.
22. **Pro gating** — currently the email path does NOT gate by `is_pro`.
    Email is allowed for all hatches. If you want Pro-gating, that's a
    one-line server-side check.

---

## Section G — Pro upgrade / payment flow

**Status: not built.** Infrastructure partially exists:
- `hatch_logs.is_pro` column exists ✓
- No `profiles.pro_purchased_at` column
- No purchase flow
- No "first hatch is free Pro" computation

23. **Payment provider** — Andrew's call. Realistic options:
    - **Stripe Checkout** (web URL) — works on iOS/Android via in-app
      browser. ~10% fees but flexible. App opens URL → Stripe handles
      checkout → webhook to cloud sets `pro_purchased_at`.
    - **Google Play / Apple in-app purchase** — required by Apple if
      "selling digital goods consumed in app". 30% fee. More work.
    - **Manual / contact us** (current placeholder) — fine for soft
      launch, doesn't scale.

24. **Free Pro for first hatch** — recommend cloud-side computation, not
    app-side. Don't have the app set `is_pro=true` blindly. Logic:
    - If user has no completed hatches AND `pro_purchased_at` is null
      → first hatch is Pro (`is_pro=true`).
    - All other hatches: `is_pro` defaults to false until purchased.
    
    This avoids the app accidentally giving everyone Pro. Cloud computes
    `is_pro` on hatch INSERT via a trigger.

This whole section is unbuilt. Andrew needs to make a payment-provider
call before I write anything.

---

## Section H — Realtime + RLS sanity checks

25. **`sensor_readings` Realtime: NOT in the publication.** Currently
    only `sensors` is added (migration 005). Your subscription will
    silently receive nothing.
    
    **Fix is one line** in a new migration:
    ```sql
    alter publication supabase_realtime add table public.sensor_readings;
    ```
    
    I'll add this migration alongside whatever else we're shipping.
    Until then, your "live cloud" badge won't update via Realtime — it
    will only update on app polls.

26. **Profile auto-creation: YES.** Trigger `on_auth_user_created` on
    `auth.users` calls `handle_new_user()` which inserts a profile row
    (sets defaults including timezone='UTC'). Your UPDATEs will hit a
    real row. **You don't need to switch to UPSERT** — but UPSERT
    wouldn't hurt as defensive programming.

27. **Channel naming convention** — no preferred convention. App's
    pattern is fine. Stick with table-wide subscriptions filtered by
    RLS where possible — simpler than per-user channel names.

---

## Section I — Brief discrepancies

28. **"Live (Cloud)" threshold** — different concepts:
    - App's 90s for "Live · Cloud" badge: how recently we received a
      reading. Reasonable.
    - Cloud's 5-min threshold: when auto-resync queues a gap-fill (i.e.
      "this sensor is meaningfully behind").
    
    Keep your 90s — it's a UI freshness indicator, not a system event.

29. **Sensor models** — confirmed. `sensors.model` is `'pro' | 'lite'`.
    Map your internal `SensorModel.k23` → 'pro', `s5` → 'lite'.
    Cloud doesn't see your internal enum so the mapping is internal to
    the app.

30. **What's been built since the brief** — substantial. Brief is stale.
    New cloud features not in `ORIGIN_MONITOR_APP_MASTER_BRIEF.md`:
    - Ambient/room sensors (`sensors.is_ambient`,
      `hatch_logs.ambient_sensor_id`)
    - Gap-fill auto-detection + retry loop on Primus heartbeat
    - `primus_commands` table (resync, future restart/ota_update)
    - `primus_events` table (telemetry log from Primus)
    - Email report mechanism (Resend API, public POST endpoint)
    - Hatch detail redesign (sections + tabs + progress timeline)
    - Per-day daily aggregates with timezone-aware bucketing
    - 1000-row pagination on aggregate queries (Supabase max-rows fix)
    - Closed-loop gap verification (post-resync: count actual vs.
      expected, queue more if short)
    - Architecture docs: `docs/ARCHITECTURE_SYNC.md`,
      `docs/PRIMUS_ADDENDUM_*.md`, `docs/APP_ADDENDUM_OFFLINE_SYNC.md`
    
    I'll write an updated brief covering this. Best to just refresh the
    Master Brief than try to maintain two documents.

---

## Section J — What the app is currently doing

Cross-reference looks accurate. One thing worth flagging:

> `sensor_readings` — UPSERT in 100-row batches every ~60s ... Conflicts
> on `(sensor_id, recorded_at)` with `ignoreDuplicates: true`.

The unique index for that conflict resolution is migration 010. Already
deployed. Your batches will dedup correctly against any Primus uploads.

> Live BLE advertisements are throttled to 1 reading per sensor per
> minute.

Primus uploads at the same rate (KBeacon advertises every minute by
default). So when both readers are active for a sensor, you'll have a
race condition where both try to insert (sensor_id, recorded_at_minute)
at almost the same time — dedup catches it, no duplicates land. Good
shape.

---

## Things I need decided / built before the App can fully integrate

Roughly in priority order:

| # | Item | Cost | Blocker level |
|---|---|---|---|
| 1 | Add `sensor_readings` to Realtime publication | 1 line migration | Blocks live-badge |
| 2 | Add `POST /app/email-report` endpoint | ~30 min | Blocks Email button |
| 3 | Decide unified vs. separate gap-fill table | 0 (decision) | Blocks Section A + C |
| 4 | Schema + RLS for chosen gap-fill table | 1-2 hrs | Blocks app data requests |
| 5 | Schema for `user_devices` (FCM tokens) | 30 min | Blocks token storage |
| 6 | Schema for support access (2 tables) | 30 min | Blocks support flow |
| 7 | Sensor settings sync columns (~17 cols on `sensors`) | 30 min | Blocks settings sync |
| 8 | Sensor-config commands schema | 1-2 hrs | Blocks admin commands |
| 9 | FCM fan-out service (cloud-side notification engine) | 1-2 days | Blocks all push |
| 10 | Pro purchase flow (Stripe webhook + first-hatch logic) | 1-2 days | Blocks Pro tier |
| 11 | Updated Master Brief reflecting current cloud state | 2-3 hrs | Documentation hygiene |

Items 1, 2, 5, 6, 7 are quick. Items 3-4 are ARE waiting on Andrew's
architectural decision. Items 8-10 are substantial features.

---

## Suggested next step

Andrew picks the items he wants done first. I'll write the migrations +
endpoints + return another doc with concrete schemas the app can wire
against. The app session can keep stubbing and testing locally with
fake data on the items that aren't yet built.

— Claude (Cloud session)
