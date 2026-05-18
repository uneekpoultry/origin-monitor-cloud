# App — global per-sensor settings sync (schema + implementation brief)

> Implement the Origin Monitor app's side of the cross-device per-sensor
> settings sync. Same canonical schema as Claude Primus is implementing
> firmware-side and Claude Cloud is implementing server-side — all three
> converge on the same shape.
>
> Status when this doc was written: cloud migration 019 applied,
> `/primus/sensors` GET + PATCH endpoints deployed and live. The app
> can implement against the now-stable schema.

## Why

Per-sensor user settings (calibration offsets, alert thresholds, alert
enables) need to live somewhere central so the **Primus**, the
**Origin Monitor app**, and the **cloud-side admin/dashboard** all
agree on the same values.

Today these settings are local to whichever device the user is on —
edit thresholds on the Primus, the app doesn't see them; edit them in
the app, the Primus doesn't see them. That gap drops as soon as
all three sides honour the new sync.

## Storage model — what the cloud provides

Two new columns on the `sensors` table, accessible to the app via
Supabase (RLS-gated, owner-only):

| Column | Type | Purpose |
|---|---|---|
| `settings` | `jsonb` | The settings object. Defaults to `{}` for sensors that haven't been configured. |
| `settings_updated_at` | `timestamptz` | Set by **the cloud** to `now()` on any successful update. Drives last-writer-wins. |

The app reads/writes `settings` directly via Supabase. The cloud sets
`settings_updated_at` automatically on its `/primus/sensors` PATCH
endpoint — but the app, which writes Supabase directly, must
**explicitly set `settings_updated_at = DateTime.now().toUtc()`** on
any successful settings write. (See "PATCH semantics" below.)

## Final agreed schema (locked)

```json
{
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
}
```

### Field semantics

- **`version`** — integer, currently `1`. Always written. Future schema
  evolutions bump this and add new fields; old clients ignore unknown
  fields gracefully. Always include `version: 1` in any write.
- **`calibration_temp_offset`** — additive offset applied to raw sensor
  temperature: `corrected = raw + offset`. Range ±10°C.
- **`calibration_humid_offset`** — additive offset applied to raw
  humidity. Range ±20% RH.
- **`alert_temp_low` / `alert_temp_high`** — temperature thresholds in
  °C. Nullable (means "not set"). Range -40 to 80.
- **`alert_humid_low` / `alert_humid_high`** — humidity thresholds in
  %RH. Nullable. Range 0 to 100.
- **`alert_*_enabled`** — booleans. When `true`, the alert fires when
  the threshold is crossed. When `false` or missing, the alert is
  disabled regardless of whether a threshold value is set.

### Defaults (must match Primus + Cloud)

Locked across all three implementations:

| Field | Default if missing |
|---|---|
| `version` | (always written; never omitted) |
| `calibration_temp_offset` | `0.0` |
| `calibration_humid_offset` | `0.0` |
| `alert_temp_low` | `null` (not set) |
| `alert_temp_high` | `null` |
| `alert_humid_low` | `null` |
| `alert_humid_high` | `null` |
| `alert_temp_low_enabled` | `false` |
| `alert_temp_high_enabled` | `false` |
| `alert_humid_low_enabled` | `false` |
| `alert_humid_high_enabled` | `false` |

Threshold fields default to `null` (not numeric) because there's no
universally-correct default — different species, different stages.
Enable booleans default to `false` so a fresh sensor doesn't fire
spurious alerts before the user has configured anything.

### Validation rules

The app must validate **before sending** to give the user immediate
UI feedback. The cloud also validates server-side as a backstop.

- `calibration_temp_offset`: -10 to 10
- `calibration_humid_offset`: -20 to 20
- `alert_temp_*`: -40 to 80
- `alert_humid_*`: 0 to 100
- `alert_temp_low < alert_temp_high` (when both set)
- `alert_humid_low < alert_humid_high` (when both set)

A client trying to save `alert_temp_low: 40, alert_temp_high: 35`
should be rejected at the form level with a clear error: *"Low
threshold must be below high threshold."*

## How the app reads settings

Two paths, depending on whether the app is online or just opened the
sensor screen:

### Path 1 — Realtime subscription (preferred)

The app already subscribes to `sensors` for the user (per the
existing pattern). Extend the projection to include `settings` and
`settings_updated_at`:

```dart
supabase
  .from('sensors')
  .stream(primaryKey: ['id'])
  .eq('user_id', myUserId)
  .listen((rows) {
    for (final row in rows) {
      final sensorId = row['id'] as String;
      final settings = row['settings'] as Map<String, dynamic>? ?? {};
      final remoteUpdatedAt = row['settings_updated_at'] != null
        ? DateTime.parse(row['settings_updated_at']).toUtc()
        : null;

      // Three-way sync decision (see "Sync rules" below)
      reconcileSettings(sensorId, settings, remoteUpdatedAt);
    }
  });
```

When another device (Primus, web admin, another phone) updates a
sensor's settings, this stream pushes the change to the app within
seconds.

### Path 2 — On-demand read

When the user opens a sensor's detail screen and the realtime stream
hasn't arrived yet, do a one-shot `SELECT`:

```dart
final response = await supabase
  .from('sensors')
  .select('id, name, settings, settings_updated_at')
  .eq('id', sensorId)
  .single();
```

## How the app writes settings

The user edits settings on the sensor detail screen. On save:

```dart
Future<void> saveSettings(String sensorId, Map<String, dynamic> changes) async {
  // 1. Validate client-side first (low<high, range checks).
  final error = validateSettings(changes);
  if (error != null) throw FormValidationException(error);

  // 2. Read current local settings (from local cache or last fetched value).
  final current = currentSettingsFor(sensorId) ?? <String, dynamic>{};

  // 3. Merge incoming changes onto current. ALWAYS stamp version: 1.
  final merged = {
    ...current,
    ...changes,
    'version': 1,
  };

  // 4. Write to cloud. App MUST set settings_updated_at explicitly
  //    because the app writes Supabase directly (cloud only auto-stamps
  //    on its /primus/sensors PATCH path, which the app doesn't use).
  final now = DateTime.now().toUtc().toIso8601String();
  final { data, error } = await supabase
    .from('sensors')
    .update({
      'settings': merged,
      'settings_updated_at': now,
    })
    .eq('id', sensorId)
    .eq('user_id', myUserId)        // RLS belt-and-braces
    .select('settings, settings_updated_at')
    .single();

  if (error != null) throw error;

  // 5. Update local cache with the cloud-confirmed values.
  cacheSettings(sensorId, merged, DateTime.parse(now));
}
```

**Important:** the app explicitly sets `settings_updated_at` because
it's writing the `sensors` table directly. The cloud's
`/primus/sensors` PATCH endpoint auto-stamps it server-side, but
that's a different code path — the app doesn't use it.

## Sync rules (last-writer-wins)

When the app sees remote settings via realtime or on-demand read,
reconcile against any local pending changes:

| Situation | Action |
|---|---|
| No local changes pending | **Adopt** remote settings into local cache. Update UI. |
| Local change pending AND remote `settings_updated_at` newer than local last-write | **Adopt** remote — discard local pending. (User's other device beat them to it.) Show a brief toast: *"Settings updated from another device."* |
| Local change pending AND remote `settings_updated_at` older than local last-write | **Push** local to cloud (the local change is the newer one). |
| Local change pending AND timestamps equal | No-op — already in sync. |

Last-writer-wins is appropriately scoped for v1. Per-field timestamps
would handle concurrent-edit-on-different-fields more correctly, but
the marginal complexity isn't worth it given typical use (one user,
one device at a time, settings rarely change).

## Offline editing

If the user edits settings while offline:

1. Validate client-side as normal.
2. Save the merged object + intended `settings_updated_at` to local
   storage (SharedPreferences, SQLite, whatever you currently use for
   queued operations).
3. Mark the sensor as having a pending settings sync.
4. When connectivity returns, read the cloud's current
   `settings_updated_at` for that sensor:
   - If cloud's is **newer** than the queued local change → discard
     local (the cloud's already moved on, possibly via another
     device). Toast: *"Local changes superseded by other device."*
   - If cloud's is **older** → push local change to cloud as in the
     normal write path.

## UI requirements

Where these settings live in the app:

### Sensor detail screen

Add a **Settings** section below the existing live readings. Two
sub-sections:

#### Calibration

- Two number inputs: temperature offset (°C), humidity offset (%RH)
- Step 0.1 for both, hold-to-repeat for fast adjustment, tap-to-type
  for direct entry
- Show the **corrected reading** alongside the **raw reading** so the
  user can immediately see the offset's effect:
  *"Reading: 37.4°C  (raw 37.2°C + offset +0.2°C)"*
- Save button updates `calibration_temp_offset` and/or
  `calibration_humid_offset`

#### Alerts

- Four threshold rows: Temperature Low, Temperature High, Humidity
  Low, Humidity High
- Each row: a toggle (enable) + a number input (threshold)
- Disabled rows show greyed-out value placeholders (`--.-`)
- Save button writes all four threshold + enable pairs in one PATCH

### Validation feedback

- Inline form validation on each field (range checks)
- After both low and high are set, validate `low < high` and show an
  inline error if violated
- Disable the Save button while form is invalid

### Sync state indicators

- "Saving..." spinner on Save click
- "Saved ✓" confirmation on success
- "Sync pending" badge if offline at save time, replaced by "Saved ✓"
  on successful background sync
- "Settings updated from another device" toast when remote-newer push
  arrives via realtime

## What this replaces

Whatever local-only settings storage the app currently uses for
calibration / alerts (likely SharedPreferences or local SQLite) gets
moved to the cloud-backed `sensors.settings` JSONB. Local cache stays
as a read-through cache for offline operation, but **cloud is the
source of truth** between sessions.

If the existing local settings format differs from the canonical
schema field names, write a one-time migration on app upgrade:

```dart
// On app launch, if local has old-format settings, push to cloud
// using new schema names, then clear local-only flag.
if (localHasLegacySettings(sensorId)) {
  final legacy = readLegacySettings(sensorId);
  await saveSettings(sensorId, {
    'calibration_temp_offset': legacy.tempOffset,
    'calibration_humid_offset': legacy.humidOffset,
    'alert_temp_low': legacy.tempLow,
    'alert_temp_high': legacy.tempHigh,
    'alert_humid_low': legacy.humidLow,
    'alert_humid_high': legacy.humidHigh,
    'alert_temp_low_enabled': legacy.tempLowEnabled,
    'alert_temp_high_enabled': legacy.tempHighEnabled,
    'alert_humid_low_enabled': legacy.humidLowEnabled,
    'alert_humid_high_enabled': legacy.humidHighEnabled,
  });
  clearLegacySettings(sensorId);
}
```

## What you do NOT need to change

- Existing realtime subscription to `sensor_readings` — independent
- Existing realtime subscription to `sensor_resync_requests` —
  independent
- Auth flow / RLS — unchanged. The existing owner-update policy on
  `sensors` covers the new columns automatically.
- Sensor pairing flow — unchanged
- Sensor name editing — independent (existing path stays)

## Coordination with Primus

Primus implements the same sync against the same schema, but goes
through `POST /primus/sensors/:id` (the existing PATCH endpoint
extended). The end state on the cloud-side `sensors.settings` JSONB
is identical regardless of which device wrote it — that's the point.

If both Primus and the App write within seconds of each other:
last-writer-wins via `settings_updated_at` decides. The losing side
adopts the winning side's values via realtime or next refresh.

## Acceptance criteria

When this is shipped, the following round-trip tests should pass:

1. **App writes, Primus adopts.** Edit temperature threshold in app.
   Within ~30s, Primus's local copy reflects the new value (as Primus
   polls `/primus/sensors`).
2. **Primus writes, App adopts.** Edit calibration offset on Primus
   LVGL UI. Within seconds, app's settings UI reflects the new value
   via realtime.
3. **Conflict resolution.** Both sides edit the same threshold within
   the same minute. Whichever has the later `settings_updated_at`
   wins; the loser adopts the winner's value next sync.
4. **Offline edit.** Toggle airplane mode on the phone, edit a
   threshold, save. Threshold is stored locally with "sync pending"
   badge. Re-enable connectivity → background sync pushes change →
   badge clears.
5. **Validation rejection.** Try to set
   `alert_temp_low: 40, alert_temp_high: 35`. Form refuses to save
   with inline error.
6. **Defaults.** A sensor with no settings yet shows
   calibration as 0.0 / 0.0, all alerts disabled. Enabling an alert
   without setting a threshold also stays inactive (until threshold
   is also set).

## Reference

Cloud-side schema doc (canonical):
`CLAUDE_PRIMUS_GLOBAL_SETTINGS_SCHEMA.md` — same field names,
defaults, validation rules. The app implements the same contract,
just over direct-Supabase access instead of `/primus/*` endpoints.

— Claude (Cloud session)
