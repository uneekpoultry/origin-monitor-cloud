# Battery on cloud sensor cards — Primus + Cloud tasks

> **From the App session, 2026-05-03.** The app's home screen and
> hatch screens both show a battery indicator on every sensor card,
> but cloud-only sensors (out of BLE range, fed by Primus) currently
> show no battery — because nothing in the live cloud feed exposes
> the battery field, and Primus may not be writing it. This request
> closes that gap end-to-end.

---

## 0. Context — what the app does today

The app already writes `battery_mv` to `sensor_readings` whenever
**it** is the upload path (BLE-direct mode, no Primus, or during
Primus failover). See `lib/services/cloud_sync_service.dart:100`:

```dart
if (r.batteryMv != null) 'battery_mv': r.batteryMv,
```

The schema has had `battery_mv INTEGER` in `sensor_readings` since
day one (Master Brief §`sensor_readings`, migration line 669). What
hasn't existed end-to-end is:

1. **Primus → cloud**: confirm Primus uploads include `battery_mv`.
2. **Cloud → app**: app's live-readings stream needs to select it.

§1 is your side. §2 the app session will handle.

---

## 1. Primus: include battery in every cloud upload

When the Primus uploads a reading to `sensor_readings`, please
include the sensor's last-known battery voltage in millivolts as
`battery_mv`:

```js
await supabase.from('sensor_readings').upsert({
  sensor_id:    sensorId,
  recorded_at:  iso8601Utc,
  temperature:  tempC,
  humidity:     humidPct,
  battery_mv:   batteryMv,   // ← add this
});
```

`battery_mv` is the raw KBeacon `BAT` field (typically 2200–3300 mV
for CR2032 / AA cells). Don't pre-convert to a percentage on your
side — the app does the curve mapping in
`MessageParser.batteryToPercentage` so percentage logic stays in
one place across BLE-direct and cloud paths.

If the sensor advertisement you're parsing doesn't include a
battery byte on every packet, send the most recent value you
observed (KBeacon repeats battery on a slower cadence than temp/
humid). Stale-by-minutes is fine; missing entirely is not.

If you're upserting in batches, every row in the batch should carry
its corresponding `battery_mv`. Don't fold the freshest battery
into older readings — keep them aligned to the timestamp.

---

## 2. Cloud-side acceptance

Confirm the following on the cloud:

- `sensor_readings.battery_mv` accepts integer values from Primus
  (nullable, no range check) without RLS rejection.
- The Realtime publication on `sensor_readings` includes
  `battery_mv` in the payload (it should, since Realtime publishes
  the full row by default — this is just a sanity check).
- No view, function, or row-level policy strips `battery_mv` from
  reads issued by an authenticated user holding a `profiles` row
  for that sensor's owner.

---

## 3. App-side work (handled by app session — recorded for traceability)

For your reference so the loop closes:

1. `lib/services/cloud_live_data_service.dart` — extend the SELECT
   from `'sensor_id, recorded_at, temperature, humidity'` to
   `'sensor_id, recorded_at, temperature, humidity, battery_mv'`,
   and add `batteryMv` to `_CloudSnapshot`.
2. The Realtime INSERT handler also reads from the new payload
   and stores `batteryMv` on the snapshot.
3. Sensor cards on `enhanced_home_screen.dart` and the
   `_LinkedSensorCard` / `_RoomSensorCard` in
   `hatches/hatch_detail_screen.dart` already render battery when
   one is provided — no UI change needed once the data flows.
4. Cached snapshots in SharedPreferences (`cloud_live_snapshot_cache`)
   pick up the new field via the bumped JSON shape.

---

## 4. Acceptance test

After both sides ship:

1. With BLE off and a sensor only reachable via Primus, the app's
   home-screen sensor card should show a battery icon coloured
   green/amber/red within ~60s of the next Primus upload.
2. The hatch detail screen's incubator + room sensor cards should
   show the same battery icon for cloud-only linked sensors.
3. After a kill-and-relaunch with no network, the cached cloud
   snapshot should still render the last-known battery (the cache
   warms with the new field included).
