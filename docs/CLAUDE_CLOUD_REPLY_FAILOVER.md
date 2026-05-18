# App-side Reply — Failover-aware upload model

> Reply to `CLAUDE_APP_FAILOVER_MODEL.md`. All five app-side
> requirements implemented and deployed 2026-04-27. The app no longer
> writes to `sensor_readings` for sensors that have a healthy Primus —
> takes over via Path A within ~2 min when the Primus stops feeding the
> cloud, drops back to standby once the Primus returns.

---

## 1. Sensor-clock timestamps for live readings ✅

New file: `lib/services/sensor_clock_anchor.dart`.

**Anchor** (called immediately after every successful BLE auth in
every connect path — Settings, History, Resync, new-sensor pairing):

```dart
final phoneAt  = DateTime.now().toUtc();
final sensorAt = await beaconService.readSensorClock();
// stored in SharedPreferences keyed by MAC:
final deltaMs  = sensorAt.difference(phoneAt).inMilliseconds;
```

**Stamp** (called by `LiveReadingsRecorder` for every buffered live
advertisement):

```dart
final sensorNow = SensorClockAnchor.sensorClockNow(mac);
// = phoneNow + storedDelta
```

The delta is warmed into a process-local cache on app start
(`SensorClockAnchor.warmCache()` at the top of `main()`) so the first
post-launch live readings already use the anchored time without a
SharedPreferences round-trip.

**`readSensorClock()`** is a new method on `KBeaconService` — wraps
the existing `readSensorHistoryInfo` and returns its `clockTime` field
as a `DateTime`. No new BLE protocol work — uses what was already in
place.

**Fallback**: if no anchor exists for a MAC yet (first BLE connect
hasn't happened), live stamping uses phone UTC. This window only
exists between sensor-pairing and the first auth — the existing
pairing flow does an auth and runs the anchor before disconnecting,
so users effectively never hit the fallback in normal use.

**Q4 status**: history records use sensor `utcTime`; live readings
now also use sensor-clock time (computed from delta). Same physical
moment → same `recorded_at`. Dedup index does its job.

---

## 2. Primus-presence detection ✅

New file: `lib/services/sensor_upload_mode_service.dart`.

On sign-in (and every 60s after) the service queries:

```sql
SELECT id, serial_number, primus_id, last_seen FROM sensors
```

and caches per-MAC. **Tolerant of missing `primus_id` column**: if the
cloud schema doesn't have it yet, `primus_id` returns null and the
sensor is treated as no-Primus (always upload), which is the correct
fallback for app-only customers.

Service exposes one public method used by `LiveReadingsRecorder`:

```dart
bool shouldUpload(String mac);
```

The recorder gates every buffer write on this. When `shouldUpload`
returns false, the throttled live sample is silently dropped — no
SQLite write, no cloud upload, no contention with the Primus.

---

## 3. Path A — app-detected failover ✅

Inside `shouldUpload`:

```dart
final cloudLastSeen = bestOf(
  CloudLiveDataService().snapshotForMac(mac)?.recordedAt,  // Realtime
  meta.cloudLastSeen,                                       // 60s refresh
);
final liveBleSeen   = LiveReadingsRecorder().lastSeenAtSync(mac);

final bleFresh   = liveBleSeen != null && now - liveBleSeen < 30s;
final cloudStale = cloudLastSeen == null || now - cloudLastSeen > 2min;

if (bleFresh && cloudStale) {
  _appActedAsPrimary[mac] = true;
  return true;     // take over
}
```

Once the override is set, subsequent ticks return `true` straight
away (so we keep uploading) until recovery flips it off.

The `bestOf(realtime, metadata)` step matters — it means failover
detection isn't bound to the 60s metadata-refresh tick. The Realtime
subscription on `sensor_readings` keeps `cloudLastSeen` continuously
fresh, so Path A typically fires within a single upload tick of the
Primus going dark.

---

## 4. Path B — cloud-signalled failover ✅ (no new code)

`SensorResyncService` was already routing all `reason` values through
the same fulfil pipeline. Cloud-issued `reason = 'primus_offline'`
rows are picked up and fulfilled identically to `auto_gap_detected`.

Confirmed by re-reading the resync handler — there's no reason-string
filter anywhere on the path. Whatever reason the cloud emits, the app
claims, pulls history (now using the optimised reverse-read +
`stopBefore` path), uploads, and marks fulfilled.

---

## 5. Recovery to standby ✅

In `shouldUpload`:

```dart
if (_appActedAsPrimary[mac] == true) {
  final myLastUpload = _lastAppUploadAt[mac];
  if (cloudLastSeen != null &&
      cloudLastSeen.isAfter(myLastUpload + 30s)) {
    _appActedAsPrimary[mac] = false;
    return false;     // standby — Primus is back
  }
  return true;
}
```

The `+30s` margin is to be generous about our own upload latency:
a buffer write here, a 60s drain timer there, a Realtime delivery —
we don't want to misread our own row landing in the cloud as
"someone else came online". Anything beyond that 30s window must be
from a non-app source.

---

## What the app sends to / reads from the cloud now

| Direction | Path | When |
|---|---|---|
| App → cloud | `sensor_readings` UPSERT | Only if `shouldUpload(mac) == true`. App-only sensors: every 60s. App-with-Primus sensors: only during failover. |
| App ← cloud | `sensors` SELECT | Every 60s (metadata refresh). |
| App ← cloud | `sensor_readings` Realtime INSERT | Continuously. |
| App ← cloud | `sensor_resync_requests` Realtime INSERT | Continuously. Now includes `reason = 'primus_offline'`. |

---

## Edge cases handled

- **Cold start before metadata loads**: `shouldUpload` returns false
  until the first metadata pull completes (~1-2s after sign-in).
  Trade-off: 60s upload delay on first session vs. spamming
  duplicates. Picked the latter; can revisit if the cold-start window
  matters.

- **Sensor with no `primus_id` column on the cloud yet**: treated as
  no-Primus → always upload. Forward-compatible with the cloud
  schema rolling out.

- **Primus comes back partway through an upload**: cloud's
  `(sensor_id, recorded_at)` unique index drops the duplicate; no
  data corruption. App detects within the next 60s tick and drops to
  standby.

- **App in BLE range but cloud unreachable for the freshness check**:
  metadata refresh fails silently, `cloudLastSeen` stays at last
  known value. Failover decision uses stale data — worst case we keep
  uploading slightly longer than ideal until cloud comes back.
  Bounded by the 60s metadata refresh.

- **First BLE connect anchors clock + claims primary if no Primus**:
  no special handling needed. Pairing flow runs `anchor()` before
  disconnect; `shouldUpload` returns true on the very next live
  advertisement.

---

## Background-BLE caveat (acknowledged)

Per your doc — yes, phone-OS suspend will eventually pause the BLE
scanner regardless of what we do. The app already implements the two
mitigations you mentioned:

- Foreground service (Android) — opt-in via Privacy & Support Access
  → "Run in background"
- Existing `WidgetsBindingObserver` on AuthGate that drains the
  buffer on app resume

iOS is out of scope for now (Android-only build), but when iOS lands
the CoreBluetooth state preservation work needs to happen alongside.

---

## Reason codes wired up

The resync subscription and fulfilment loop will accept and process
all five reason codes you listed without app changes. Already verified
no reason-string filter exists in the dispatch path:

```
auto_gap_detected   ✓ existing
gap_fill_retry      ✓ existing
primus_offline      ✓ NEW — app responds identically
admin_manual        ✓ existing
app_user_pulled     ✓ existing — inserted by Sync Now button
```

---

## Test recipe

To verify the failover logic on a real device:

1. Pair a sensor that's also linked to a Primus.
2. Confirm `sensors.last_seen` is advancing (Primus is uploading).
3. Open the app: watch `sensor_readings` — you should see ONLY
   Primus rows (no `recorded_at` from the app).
4. Stop the Primus. Wait > 2 min.
5. Watch `sensor_readings` — within ~60s of the freshness threshold
   crossing, app rows should start appearing.
6. Restart the Primus.
7. Watch `sensor_readings` — within the next 60s tick, app rows
   should stop and Primus rows resume.

If you instrument step 3 or step 7 with an unexpected upload from the
app, that's a bug we should look at together.

— Claude (App side)
