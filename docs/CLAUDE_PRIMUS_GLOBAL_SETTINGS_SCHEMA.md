# Primus — review of global per-sensor settings schema

> Cloud-side review of your proposed schema for global per-sensor
> settings. Schema is solid in shape; three must-change items, two
> should-add items, otherwise green-lit. Final agreed schema captured
> at the end of this doc — implement against that.

## Schema is solid

The wrapper-object pattern (`settings: { ... }`) is the right move:
extensible without churn, single sync mechanism handles calibration
today + alert thresholds tomorrow + alert sounds + battery alerts +
anything else. Three-way sync mirroring the existing rename pattern
keeps the architecture consistent. Last-writer-wins via a timestamp
is appropriately scoped for v1.

Three things I'd push back on, two I'd add, then we ship.

---

## Must change before either side starts

### 1. Rename `calibration_temp` → `calibration_temp_offset`

`calibration_temp: 1.5` is ambiguous. Three different products in
this category use that name to mean three different things: an
additive offset, a subtractive offset, or an absolute corrected
value at a reference point. Without a suffix, an installer who's
familiar with brand X reads it the wrong way and miscalibrates.

**Use:**

```
calibration_temp_offset
calibration_humid_offset
```

And document in the schema:

```
corrected_temp = raw_temp + calibration_temp_offset
corrected_humid = raw_humid + calibration_humid_offset
```

Save us a future class of support tickets. Same value semantics, less
ambiguous name.

### 2. Cloud-side storage: JSONB column, not 11 separate columns

Do **not** add 11 individual columns to `public.sensors`. Use one
JSONB column for the settings object plus a separate timestamp:

```sql
alter table public.sensors
  add column if not exists settings jsonb not null default '{}',
  add column if not exists settings_updated_at timestamptz;
```

Why this matters:

- Adding `alert_battery_low_enabled` later: zero schema migration,
  just write the field.
- Adding `alert_sound_id` (the alarm-sound feature you mentioned):
  same, no migration, no cloud release.
- Each side (Primus, App, Cloud) ignores fields it doesn't know
  about — graceful forward compatibility.
- Per-Primus extensions (e.g. you add a Primus-only debug toggle)
  don't bloat the central cloud schema.

`is_ambient` stays as a real column (it's structural metadata, not
user-tunable). Everything user-tunable lives in `settings`.

PATCH endpoint on the cloud side does a deep-merge into the JSONB —
trivial in Postgres (`settings = settings || $patch`).

### 3. Validate `low < high` server-side

Cloud must reject obviously-wrong threshold pairs with a 400:

```json
{ "alert_temp_low": 40.0, "alert_temp_high": 35.0 }
```

Otherwise the user fat-fingers, the alert never fires, the eggs cook,
and they blame the product. Same check for humid.

Implementation on cloud — Zod refinement:

```ts
const settingsSchema = z.object({
  version: z.literal(1).optional(),
  calibration_temp_offset: z.number().min(-10).max(10).optional(),
  calibration_humid_offset: z.number().min(-20).max(20).optional(),
  alert_temp_low: z.number().min(-40).max(80).optional(),
  alert_temp_high: z.number().min(-40).max(80).optional(),
  alert_humid_low: z.number().min(0).max(100).optional(),
  alert_humid_high: z.number().min(0).max(100).optional(),
  alert_temp_low_enabled: z.boolean().optional(),
  alert_temp_high_enabled: z.boolean().optional(),
  alert_humid_low_enabled: z.boolean().optional(),
  alert_humid_high_enabled: z.boolean().optional(),
}).refine(
  (s) => s.alert_temp_low === undefined ||
         s.alert_temp_high === undefined ||
         s.alert_temp_low < s.alert_temp_high,
  { message: "alert_temp_low must be less than alert_temp_high",
    path: ["alert_temp_low"] }
).refine(
  (s) => s.alert_humid_low === undefined ||
         s.alert_humid_high === undefined ||
         s.alert_humid_low < s.alert_humid_high,
  { message: "alert_humid_low must be less than alert_humid_high",
    path: ["alert_humid_low"] }
);
```

Firmware should mirror this validation client-side too (don't let the
user *enter* an inverted range in the UI), but the cloud must
backstop it because firmware versions skew over time.

---

## Should add

### 4. Schema version field

```json
"settings": {
  "version": 1,
  "calibration_temp_offset": 1.5,
  ...
}
```

Costs essentially nothing, future-proofs the migration story. When
the schema evolves (e.g., adding alarm severity levels —
`info`/`warn`/`critical`), bump to `version: 2`. Old clients seeing
`version: 1` know to apply v1 semantics; new clients seeing
`version: 2` apply v2 semantics. No forced flag day.

### 5. Document default values explicitly

The "missing field = use default" rule is fine, but the defaults must
match across Primus, App, and Cloud or you get phantom alerts and
disagreement between devices on what's "set".

Lock these in the spec doc:

| Field | Default | Notes |
|---|---|---|
| `version` | `1` | Always written; never null. |
| `calibration_temp_offset` | `0.0` | Additive offset. |
| `calibration_humid_offset` | `0.0` | Additive offset. |
| `alert_temp_low` | `null` | "Not set" — pair with enabled=false. |
| `alert_temp_high` | `null` | |
| `alert_humid_low` | `null` | |
| `alert_humid_high` | `null` | |
| `alert_temp_low_enabled` | `false` | Disabled by default. |
| `alert_temp_high_enabled` | `false` | |
| `alert_humid_low_enabled` | `false` | |
| `alert_humid_high_enabled` | `false` | |

The thresholds default to `null` rather than a numeric default
because there's no universally-correct value (different species,
different stages). The `enabled` booleans default `false` so a fresh
sensor doesn't fire spurious alerts before the user has configured
anything.

---

## OK as-is — don't change

- **Last-writer-wins with single `settings_updated_at`** — fine for
  v1. Per-field timestamps would be more correct (two devices editing
  different fields concurrently wouldn't overwrite each other's
  unrelated changes), but adds complexity for a problem that probably
  doesn't bite in real use — one human, almost always editing on one
  device at a time.
- **Pull-on-GET sync model** — fine. These settings change rarely;
  every-60s metadata refresh is plenty.
- **Local-only field exclusions (colour, bleAdvertisedName, cloudId)**
  — correct exclusions, three-line rule of thumb: per-Primus = local,
  per-sensor-globally = synced.
- **PATCH partial / merge semantics** — correct. Send only changed
  fields, cloud merges into stored object.

---

## Sequencing — flip 2 and 3

Your proposed order:

1. Issues 1+2 (firmware UI immediate)
2. Firmware three-way sync
3. Cloud brief
4. App brief

**Better order:** put **cloud first** so the schema is locked before
either firmware or app starts implementing against it. Otherwise you
risk firmware shipping with `calibration_temp` while the cloud
expects `calibration_temp_offset`, and someone has a forced re-cut.

**Proposed sequence:**

1. **Issues 1+2** — firmware UI fixes (you do these locally, no
   cross-team dependency, ship whenever).
2. **Cloud** — migration + endpoint + validation. Cloud-side I can
   have this done in ~2 hours once you confirm the final schema (see
   below). I'll deploy + verify endpoints respond per spec.
3. **Firmware three-way sync** — implement against the now-stable
   cloud schema. Local save + queued PATCH on user change. Adopt
   cloud values on GET if cloud's `settings_updated_at` newer.
4. **App** — same as firmware against the same schema. Implements UI
   in app's Settings → Sensor → Calibration / Alerts screens.

Steps 3 and 4 can run in parallel once cloud is up. Both implement
against the same locked spec.

---

## Final agreed schema (lock this in)

```json
{
  "id": "<uuid>",
  "serial_number": "BC:57:29:1F:1E:EA",
  "name": "Brooder Box A",
  "is_ambient": false,
  "claimed_at": "...",
  "settings": {
    "version": 1,
    "calibration_temp_offset": 1.5,
    "calibration_humid_offset": -2.0,
    "alert_temp_low": 36.0,
    "alert_temp_high": 39.0,
    "alert_humid_low": 35.0,
    "alert_humid_high": 75.0,
    "alert_temp_low_enabled": true,
    "alert_temp_high_enabled": true,
    "alert_humid_low_enabled": true,
    "alert_humid_high_enabled": true
  },
  "settings_updated_at": "2026-05-08T10:30:00Z"
}
```

### Endpoints

**`GET /primus/sensors`** — each sensor object now includes
`settings` and `settings_updated_at` per the shape above.

**`PATCH /primus/sensors/:id`** — partial update. Body:

```json
{
  "settings": {
    "calibration_temp_offset": 1.7,
    "calibration_humid_offset": -1.5
  }
}
```

Or to update name + settings together (existing rename path stays):

```json
{
  "name": "Brooder Box A — moved",
  "settings": {
    "alert_temp_high": 40.0
  }
}
```

Cloud merges into the existing JSONB. `settings_updated_at` is set to
`now()` automatically by the cloud on any successful settings update
— firmware/app must not send their own value for it.

### Sync rules (unchanged from your proposal)

| Trigger | Action |
|---|---|
| User changes setting on Primus | Save locally + queue PATCH to cloud |
| User changes setting on App | App PATCHes cloud directly |
| Cloud has newer `settings_updated_at` on GET | Adopt cloud's values (cloud is authoritative) |
| Local `settings_updated_at` newer than cloud's | Push local to cloud |

### Validation rules (cloud-enforced, firmware should mirror)

- `calibration_temp_offset`: ±10°C max
- `calibration_humid_offset`: ±20% max
- `alert_temp_*`: -40 to 80°C
- `alert_humid_*`: 0 to 100%
- `alert_temp_low < alert_temp_high` (when both set)
- `alert_humid_low < alert_humid_high` (when both set)

---

## What I'll build cloud-side

1. **Migration `019_sensor_settings.sql`** — adds the two columns to
   `public.sensors`, default `'{}'::jsonb` for `settings`, NULL for
   `settings_updated_at`. Backfill: existing rows get an empty
   settings object so they're consistent.
2. **`PATCH /primus/sensors/:id`** — handler accepts the body shape
   above, validates with the Zod schema, deep-merges into
   `sensors.settings`, sets `settings_updated_at = now()`. Returns
   `{ok, settings, settings_updated_at}`.
3. **`GET /primus/sensors`** — extends the existing handler to
   include `settings` and `settings_updated_at` in each row.
4. **RLS update** — owners can update their own `sensors.settings`
   and `settings_updated_at` (already covered by existing owner
   update policy, but worth verifying no column-level restriction
   blocks it).

I'll have it deployed and tested before you start the firmware
three-way sync work, so you can verify against the live endpoints.

## Sound right?

Confirm the three must-change items + two should-add items are fine
on your end. Once you say go, I implement and deploy. After cloud
is up, you implement firmware sync, App session implements app sync,
all three sides converge on the same schema.

— Claude (Cloud session)
