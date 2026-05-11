# App addendum — offline sync + BLE historical catch-up

> **Read `docs/ARCHITECTURE_SYNC.md` first.** That document covers the
> universal pattern every reader follows (sensor-as-source-of-truth,
> cloud dedup, timestamp rules). This addendum fills in the app-specific
> details and — importantly — flags what to borrow vs what to avoid from
> the Primus reference implementation.

## What the app is in the architecture

The Origin Monitor mobile app is a **reader**, equivalent to the Primus.
It is BLE-central to one or more Origin sensors when in range, captures
live readings, and pushes them to the cloud. Compared to the Primus:

- **Phones have abundant RAM and no PSRAM contention.** TLS fragmentation
  issues that plagued the ESP32-S3 don't apply. Don't copy the Primus's
  defensive memory strategies — they'd be needless complexity on a phone.
- **Phones go out of BLE range routinely.** Every time the user leaves
  the room. BLE historical catch-up is the default resumption path, not
  an exceptional one.
- **Network transitions are normal.** WiFi ↔ cellular ↔ offline ↔
  cellular ↔ WiFi. "Cloud reachable" is a fluid state the app must
  treat gracefully.
- **Background execution is constrained** (iOS especially). The app
  can't assume it's always running. Sync must be robust to being killed
  and relaunched mid-flush.
- **Many customers have sensors + app only, no Primus.** The app must
  work entirely standalone for them — it's not a secondary reader.

## Required app-side capabilities

### 1. Local durable buffer (SQLite)

Every captured reading goes to non-volatile storage **before** any upload
attempt. Nothing relies on RAM alone.

```sql
CREATE TABLE pending_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_serial TEXT NOT NULL,      -- BLE MAC / serial_number
  model TEXT,                        -- 'pro' or 'lite'
  temperature REAL,
  humidity REAL,
  battery_mv INTEGER,
  recorded_at TEXT NOT NULL,         -- ISO 8601 UTC, FROM THE SENSOR
  captured_at TEXT NOT NULL,         -- when the app received it (diagnostics)
  upload_attempts INTEGER DEFAULT 0,
  last_attempt_at TEXT
);
CREATE INDEX idx_pending_readings_serial_time
  ON pending_readings(sensor_serial, recorded_at);
```

Rows only get deleted after the cloud returns 200 for that row.

### 2. Cloud insert via Supabase

Use the authenticated user's JWT and insert directly against
`sensor_readings`:

```dart
final response = await supabase.from('sensor_readings').upsert(
  rows.map((r) => {
    'sensor_id': r.sensorId,   // UUID looked up from sensors table by serial
    'temperature': r.temperature,
    'humidity': r.humidity,
    'battery_mv': r.batteryMv,
    'recorded_at': r.recordedAt,
  }).toList(),
  onConflict: 'sensor_id,recorded_at',
  ignoreDuplicates: true,
);
```

RLS policy (migration 004) allows the authenticated user to insert
readings for sensors they own. Cloud dedup handles overlap with a Primus
if one's also uploading.

**Batch size:** 50-100 rows per insert is fine on a phone. Stay under
~500 KB per request for slow links. No reason to shrink batches further.

### 3. BLE historical catch-up

When the app re-establishes BLE connection to a sensor (cold launch, or
returning to range):

1. Query local DB: what's the latest `recorded_at` already persisted for
   this sensor?
2. Write to the sensor's `readings-range` characteristic with
   `since = latest_recorded_at - 10min` (the 10-min overlap is free; cloud
   dedup handles it).
3. If the app has no prior readings for this sensor (first-ever connect),
   request `since = now - 24h` as a conservative default.
4. Sensor streams readings via BLE notifications. App writes them to
   `pending_readings`.
5. Normal upload pipeline flushes them to the cloud with next live
   readings.

The sensor returns ~5-min-resolution history (not live 60-s rate). A
30-day fetch is ~8640 records ≈ 100 KB of JSON — trivial for a phone.

### 4. Reconnect detection

Drain `pending_readings` when any of these happen:

- Network interface comes up (WiFi gained, cellular restored)
- App comes to foreground after being backgrounded
- Cold launch (always check pending buffer on startup)
- Manual "Sync now" button in Settings (support/diagnostic only)

Use the platform's connectivity callbacks (`connectivity_plus` for
Flutter, `NWPathMonitor` on iOS, `ConnectivityManager` on Android).

### 5. Background execution

**iOS:** background BLE requires `bluetooth-central` background mode in
`Info.plist`. Reads are throttled even then. Pragmatic strategy: capture
as much as possible when foregrounded; accept background capture as
best-effort; rely on BLE historical catch-up when the user next opens
the app.

**Android:** fewer restrictions, but doze mode applies. Use a foreground
service with a persistent notification **only if** the user opts into
"monitor while away". Otherwise follow the iOS foreground-first pattern.

### 6. UX — sync is invisible

Per the architecture principle, sync is transparent to the user. The app
should **not**:

- Show spinners while uploading
- Display "syncing..." toasts
- Tell the user their data is offline
- Show gap warnings on charts

The app **should**:

- Always render what the cloud returns — dashboard is authoritative
- Optionally show a subtle "last sync" timestamp somewhere in Settings
  for support purposes
- Log sync events to a local debug log (not cloud events) for support
  to request if something goes wrong

If the user's view is temporarily stale because they're offline, that's
fine — they'll see the latest data the instant connectivity returns,
with no action required from them.

### 7. Battery discipline

- Don't scan for BLE continuously when nothing's in range. Use
  state-restoration APIs to wake up when a known sensor's advertisements
  reappear.
- Use passive scanning where supported.
- Batch uploads to reduce radio wake cycles — prefer one POST of 50
  readings over 50 POSTs of 1 reading each.
- Don't hold TLS handshakes open between posts — open, send batch,
  close. Modern phones handle handshake overhead without issue.

### 8. Paired-sensor discovery

Unlike the Primus (which auto-discovers via KBeacon advertising), the app
should let the user **explicitly add each sensor** from a Settings
screen, then confirm pairing. Prevents accidentally adopting a neighbor's
sensor. Use the same BLE characteristics the Primus uses for auth
(FEA2/FEA3) to verify the sensor belongs to this account.

A sensor paired to the app syncs under the same `sensor_id` the Primus
uses (if one is registered). If no Primus exists for this user, the app
creates the sensor row directly via an authenticated Supabase insert.

## What NOT to borrow from the Primus

The Primus firmware (`origin_basestation/src/main.cpp`) is a useful
reference for the BLE/upload flow, but much of its defensive complexity
exists because the ESP32-S3 is severely memory-constrained. **Phones
don't have these problems. Don't reimplement these patterns.**

### Skip: chunked uploads with fixed-size static buffers

The Primus uses a static 1800-byte buffer and uploads in batches of 10
because its internal RAM fragments under Arduino `String` churn. On a
phone, use idiomatic JSON serialization and whatever batch size is
convenient. If your HTTP library can send a 500 KB body, send a 500 KB
body.

### Skip: PSRAM mbedtls memory pool

The Primus pre-allocates a 60 KB PSRAM pool for mbedtls to avoid
fragmenting internal heap during TLS handshakes. Phones don't have
PSRAM (in this sense) and don't need pools. The platform's HTTPS stack
handles TLS memory fine.

### Skip: Multi-phase resync with WiFi/BLE teardown

The Primus tears down WiFi before doing BLE historical download, then
brings WiFi back before uploading — because running both radios +
TLS + LVGL simultaneously exhausts the chip. Phones run all of this
concurrently without issue. Just pull BLE history and upload when
convenient; no phased coordination needed.

### Skip: `primus_commands` channel

The Primus receives remote commands via heartbeat responses for
admin-triggered resyncs. The app is directly driven by the user — it
doesn't need a remote-command channel. If a user wants to force a
resync, add a Settings button that calls your existing pull-from-
sensor code. Don't build a queue.

### Skip: `primus_events` upload

The Primus forwards its on-device log ring buffer to the cloud so
support can see what the device is doing. Apps have their own
crash-reporting (Sentry, Crashlytics, Firebase Crashlytics). Use those,
not the cloud's `primus_events` table.

### Skip: Heartbeat loop

The Primus heartbeats every 60s so the cloud can detect sensor gaps
and queue resyncs. The app doesn't heartbeat — it pushes data when it
has data. Cloud auto-resync-detection doesn't apply to the app because
there's no reliable "this app is online now" signal on a phone.

## Lessons from today's Primus integration (2026-04-22)

Things the Primus session got wrong during initial implementation that
the app session should avoid:

1. **Don't iterate on fixes without baseline.** The Primus session fell
   into a debugging spiral by layering fixes on fixes without reverting
   between attempts. When something stops working, find the known-good
   commit and work forward one change at a time.

2. **Don't paper over root causes.** Early attempts treated TLS
   fragmentation with bigger backoff intervals and more WiFi retries.
   The real cause (String realloc churn) was 10 lines away. Question
   whether a fix addresses the *mechanism* or just the *symptom*.

3. **Respect architectural constraints on every platform.** The Primus
   session needed to care about mbedtls-vs-LVGL-vs-framebuffer competing
   for PSRAM. Your equivalent on the app side: BLE throttling by iOS,
   foreground/background lifecycle, battery/thermal governors. Know
   what's actually constraining you before optimising for imagined
   constraints.

4. **Don't build what the cloud already gives you for free.** The cloud
   dedups via unique index. If you're tempted to write client-side
   dedup logic, stop — the overhead of sending "last 24h" and letting
   the cloud sort it out is lower than any client-side bookkeeping.

## Testing checklist

Before shipping the app's offline sync:

- [ ] Phone offline 10 min / 4 h / 24 h / 7 days — returns with data
      intact, gap fills on reconnect
- [ ] Phone out of BLE range 1 h / 24 h / 7 days — BLE historical
      catch-up recovers all readings
- [ ] Phone OS kills app mid-upload — pending rows reappear on relaunch
- [ ] Primus + app both uploading same sensor simultaneously — zero
      duplicates in cloud (unique index catches it)
- [ ] Sensor briefly out of BLE range (5 min, comes back) — no phantom
      gap in readings
- [ ] WiFi ↔ cellular ↔ offline flapping during upload — no dropped
      readings, no UI flicker, no duplicate rows
- [ ] User logs out + logs back in — pending rows from old user don't
      leak to new user
- [ ] Cold launch after 30 days offline — BLE historical pull retrieves
      full sensor buffer, uploads complete within a reasonable window
- [ ] Multiple sensors simultaneously — all 4 drain in parallel without
      blocking each other
- [ ] Low battery mode / iOS background refresh disabled — app still
      captures foreground readings and syncs on next foreground entry

## References

- Architecture: `docs/ARCHITECTURE_SYNC.md`
- Cloud schemas + endpoints: `docs/PRIMUS_ADDENDUM_GAP_FILL_RESYNC.md`
  (the BLE `readings-range` characteristic contract applies to the app
  too — same sensor firmware)
- Cloud dedup migration: `supabase/migrations/010_sensor_readings_dedup.sql`
- App insert RLS policy: `supabase/migrations/004_app_readings_insert.sql`
- Primus firmware: `origin_basestation/src/main.cpp` — useful to read
  for the BLE protocol details, but do NOT copy its memory defensiveness
  or phased-teardown patterns into the app

## Changelog

- **2026-04-22** — Expanded with Primus integration lessons after full
  end-to-end validation of the sync loop against real hardware. Added
  explicit "what NOT to borrow" guidance and testing checklist.
