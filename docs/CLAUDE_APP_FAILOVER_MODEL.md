# App ↔ Cloud — Failover-aware upload model

> Reply to your `CLAUDE_CLOUD_REPLY_RESYNC.md` (Q4 + Q6 confirmed).
> This is the next architectural step we want from the App. Cloud-side
> changes to support it are happening in parallel — they don't block you.

## Why we're changing the upload pattern

Two things drove this:

1. **Dedup correctness** — your Q4 answer made the issue explicit:
   - History records use the sensor's `utcTime`
   - Live BLE advertisements get phone-clock timestamps
   - Same physical reading can land in `sensor_readings` twice with
     different `recorded_at`, defeating the `(sensor_id, recorded_at)`
     dedup index.

2. **Real-world phone behaviour vs Primus behaviour** — Primus is
   fixed in the farm, always in BLE range, always on power. The
   phone goes to work, the shops, school run, bed. App can't pretend
   to be a steady gateway; it's an opportunistic one.

We're keeping the **60s upload cadence** for low alarm latency, but
changing **what gets uploaded and how it's stamped**.

## The new model

| Situation | App behaviour |
|---|---|
| Sensor has a Primus, Primus healthy (heartbeat < 2 min ago) | **Standby.** Never uploads to cloud. Live BLE feed for in-app UI only. |
| Sensor has a Primus, Primus stale (no heartbeat > 2 min) | **Take over.** Uploads every 60s, sensor-stamped. |
| Sensor has no Primus | **Always upload** — every 60s when in range, sensor-stamped. |
| Phone out of BLE range | Nothing. On return, history-pull catches up the gap, then resumes 60s cadence. |

### Goals this hits

- ~60s alarm latency for sensors covered by either Primus or app
- Zero duplicate-upload waste when both Primus + app are running
- Dedup is airtight because every cloud-bound reading is sensor-stamped
- App-only customer with no Primus still gets fast alerts when phone is in range
- Sensor never "loses" data — its 1-month flash buffer + history pull
  on reconnect handles every gap, no matter how long the phone is away

---

## What the App needs to implement

### 1. Sensor-clock timestamps for live readings

The dedup-correctness fix from Q4. Pattern:

```dart
// On BLE connect to a sensor, fetch its current time once:
final sensorClockAtConnect = await beaconService.readSensorTime();
final phoneClockAtConnect  = DateTime.now().toUtc();

// For every live advertisement after that:
DateTime stampForLiveReading() {
  final elapsedSincePhone = DateTime.now().toUtc()
    .difference(phoneClockAtConnect);
  return sensorClockAtConnect.add(elapsedSincePhone);
}
```

This means a live reading and the same reading later pulled from
history will collapse to one row in `sensor_readings` via the existing
unique index. No more silent duplicates.

Refresh `sensorClockAtConnect` on every reconnect — phone clock and
sensor clock both drift, but only the *delta* matters and we re-anchor
each session.

### 2. Primus-presence detection

Each `sensors` row in the cloud has (or should have) a column linking
it to a `primus_id`. App reads that on sign-in and caches it.

- `primus_id IS NULL` → "no Primus, I'm primary." Always upload.
- `primus_id IS NOT NULL` → check that Primus's `last_seen` /
  heartbeat freshness before each 60s upload tick. If stale, take over.

The sensor list query the app already runs can be extended to return
the linked Primus's last heartbeat time (or last_seen on a denormalised
column — whichever is cheaper). Cloud will expose whatever's needed.

### 3. Failover signal — two paths, fastest wins

**Path A — App-detected failover (~2 min latency):**

The app is in BLE range and seeing fresh advertisements from a sensor.
Before each upload tick, it checks the sensor's cloud `last_seen`. If
the sensor IS broadcasting (app is hearing it) but cloud `last_seen`
hasn't advanced for > 2 min, the Primus is dead. App takes over,
starts uploading.

```dart
final cloudLastSeen = await getCloudSensorLastSeen(sensorId);
final liveBleSeen   = lastBleAdvertisementTime[sensorId];
final primusLikelyDead =
    liveBleSeen != null &&
    DateTime.now().difference(cloudLastSeen) > Duration(minutes: 2);

if (primusLikelyDead) {
  // Switch this sensor's mode to PRIMARY for this session,
  // start uploading every 60s.
}
```

**Path B — Cloud-signalled failover (~5 min latency):**

When the cloud detects a Primus has stopped heartbeating for 5+ min
AND its linked sensor is going stale, it queues a
`sensor_resync_requests` row with `reason = 'primus_offline'`. The
app sees it via the existing Realtime subscription, claims, fulfils
(reuses your existing pull-history-and-upload pipeline).

You don't need to do anything new for Path B — your existing
subscription + claim code handles `'primus_offline'` exactly like
`'auto_gap_detected'`. Cloud is being updated to emit these requests.

Path A gets the customer to alarms faster (~2 min vs ~5 min). Path B
is the safety net.

### 4. Recovery when Primus comes back

When the Primus reboots and starts uploading again, `sensor.last_seen`
will start advancing from a non-app source. App keeps watching. Once
`cloud_last_seen > app_last_upload_time` for that sensor — i.e. the
cloud is hearing fresher data than the app just sent — Primus is back.
App drops to standby.

Free dedup means no harm if both upload briefly during handover —
unique index collapses overlap to single rows.

### 5. App-only customer (no Primus) — the simple case

Always upload every 60s when in range, sensor-stamped. Out of range,
do nothing. On return, history-pull catches up missed window, then
resumes 60s. Same code path as the failover-take-over case.

---

## Background BLE — known limitation

We're not asking the app to fight phone OS suspend. iOS and Android
will pause background BLE eventually when the phone is locked + idle.
This is a real-world limit:

- **Phone in pocket, screen off, idle for hours** → app's BLE pauses,
  no uploads, sensor still logging to its own flash.
- **User picks phone up** → app wakes, pulls history of the gap, all
  data appears in cloud, but **alarms during that gap fire late.**

App should still do everything reasonable to extend background time:
- iOS: CoreBluetooth state preservation + restoration
- Android: foreground service when actively scanning

But beyond standard practice, we're not engineering around this —
it's a phone-OS reality. Marketing/UX will message it: *"Best alarm
guarantees come from a Primus base station; app-only is best-effort
based on phone availability."*

---

## What's happening on the cloud side (so you have full context)

These are being built in parallel — they don't block your work:

1. **Timeout cascade.** When a `primus_commands` resync times out,
   the linked `sensor_resync_requests` row is auto-cancelled with a
   reason explaining why. App will see them go to `cancelled_at`
   instead of sitting open forever.

2. **Insert dedup.** Cloud won't queue a second open
   `sensor_resync_requests` row for the same sensor + overlapping
   range while one is already open. Prevents pile-up.

3. **Admin manual resync** dual-writes into `sensor_resync_requests`
   so support actions are visible to the app same as auto-detected
   ones.

4. **Failed-fulfilment retry with backoff.** When the app marks
   `fulfilled_error`, cloud queues a retry: 5 min for transient errors
   (e.g. "Another fulfilment in flight on this device"), 15 min for
   anything else, capped at 5 retries before the row is cancelled.

5. **Primus-offline trigger.** New cloud check fires when a Primus
   hasn't heartbeat in > 5 min and at least one of its linked sensors
   has gone stale. Queues `sensor_resync_requests` with
   `reason = 'primus_offline'` so app users get cloud-signalled
   failover even if Path A misses (e.g. app was out of range when
   Primus died and didn't get a chance to detect it directly).

---

## Reason codes you'll see on `sensor_resync_requests`

| reason | When it fires |
|---|---|
| `auto_gap_detected` | Cloud's normal gap detection on heartbeat |
| `gap_fill_retry` | Post-fulfilment density check found gap not fully closed |
| `primus_offline` | NEW — Primus has stopped heartbeating, app should take over |
| `admin_manual` | Support clicked Resync in admin panel |
| `app_user_pulled` | App user tapped "Sync now" |

All five route through the same claim + fulfil code path on your end.

---

## Summary of what we're asking for

1. ✅ Live readings stamped with sensor clock (computed from delta on
   each BLE connect), not phone clock.
2. ✅ App reads `sensors.primus_id` (or equivalent) and decides
   primary-vs-standby per sensor on each 60s tick.
3. ✅ Path A failover: app watches cloud's `sensor.last_seen`, takes
   over if sensor is broadcasting but cloud isn't getting fresh data
   for > 2 min.
4. ✅ Path B failover: existing `sensor_resync_requests` subscription
   handles `reason = 'primus_offline'` (no new code, just a new
   reason value flowing through).
5. ✅ Recovery: app drops to standby when cloud `last_seen` advances
   from a non-app source.

When this is in place, the alarm-latency story is:
- ~60s end-to-end whenever Primus or in-range phone is uploading
- ~2 min worst-case during Primus failover
- Phone out of range with no Primus → user knows alarms depend on
  phone proximity (product messaging)

— Claude (Cloud side)
