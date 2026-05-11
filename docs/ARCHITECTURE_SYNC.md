# Origin Monitor — Sync architecture

> **This is the canonical design for how sensor data flows from the
> environment to the cloud.** Every current and future "reader" of
> Origin sensors — Primus basestation, Origin Monitor mobile app,
> future integrations — must follow this model. Share this document with
> each session working on a new reader.

## Core principle

**The sensor is the source of truth.** Each Origin Pro / Origin Lite
sensor holds ~1 month of its own readings in on-device flash. Every
other component — Primus, app, cloud — is a *cache* or *view* of what
the sensor already knows.

This single principle produces the following guarantees:

1. **No data is ever truly lost** as long as a reader reconnects to
   the sensor within the sensor's buffer window (~1 month).
2. **Any reader can catch up** without coordination with other readers.
3. **Network outages are invisible to the user** — after a reconnect,
   data appears as though it had been flowing the whole time.
4. **Dedup is idempotent** — readers can safely overshoot on resync
   without fear of duplicate rows.
5. **The architecture scales to any number of readers** without design
   changes.
6. **Gap-fill is closed-loop**, not one-shot. After a resync completes,
   the cloud verifies actual readings density against expected (5-min
   resolution over the recovery window) and queues another resync if
   any linked sensor is below threshold. The cloud keeps chasing until
   the data is complete, up to a safety cap (5 retries/hour). Serious
   customers get genuinely gap-free history — not "we tried once, good
   luck."
7. **The cloud only records when a hatch is recording.** A sensor
   that's not linked to any active hatch is in "casual mode" — readings
   from the Primus are rebroadcast live (Realtime channel
   `sensor_live:{sensor_id}`) but **not written to `sensor_readings`**.
   When a hatch starts referencing the sensor, persistence kicks in
   automatically. This keeps cloud cost bounded for users who own
   sensors but aren't currently running a hatch, while still giving
   Primus customers always-on remote live monitoring.

## The three-layer pattern

```
┌────────────────────────────────────────────────┐
│  SENSOR (Origin Pro / Origin Lite)              │
│  — 1-month on-device flash buffer               │
│  — stamps every reading with its own recorded_at│
│  — exposes BLE GATT: live readings + history    │
│    read-by-range characteristic                 │
└────────────────────┬───────────────────────────┘
                     │ BLE
                     ▼
┌────────────────────────────────────────────────┐
│  READER (Primus, App, etc.)                     │
│  — BLE central for one or more sensors          │
│  — keeps a local ring buffer for live readings  │
│    while cloud connection is active             │
│  — persists live readings to local storage when │
│    cloud is offline                             │
│  — on cloud-reconnect: flushes local storage    │
│  — on sensor-reconnect (after BLE out-of-range):│
│    pulls historical via readings-range          │
│  — uses chunked uploads, dedup-safe overshoot   │
└────────────────────┬───────────────────────────┘
                     │ HTTPS (TLS)
                     ▼
┌────────────────────────────────────────────────┐
│  CLOUD                                          │
│  — POST /primus/readings (Primus)               │
│  — direct Supabase insert (App, via RLS)        │
│  — upsert with ignoreDuplicates on              │
│    (sensor_id, recorded_at) unique index        │
│  — silently drops duplicates                    │
│  — auto-detects gaps on heartbeat, queues       │
│    resync commands to Primus-class readers      │
│  — admin can manually queue resyncs             │
└────────────────────────────────────────────────┘
```

## When a resync fires

Three independent triggers; all produce the same pipeline:

1. **Cold boot of a reader** — on startup, the reader self-queues an
   "internal" resync to catch up anything it missed while offline. The
   Primus does this at `setup()`; the App should do this on first
   cloud-reconnect after launch.

2. **Cloud-detected gap** — on every `/primus/heartbeat`, the cloud
   checks each linked sensor's `last_seen`. If stale by > 5 minutes
   and no open resync is in flight, cloud INSERTs a row into the
   unified `sensor_resync_requests` table (see "Unified resync request
   queue" below). Both Primus (via heartbeat response) and App (via
   Realtime subscription) can claim and fulfill.

3. **Admin intervention** — admin clicks the **Resync** button in
   `/admin/primus/{id}/events`. Inserts a request row + queues a
   Primus command to bypass cooldown. Used by support for remote
   recovery.

4. **User-triggered manual resync (App)** — the user taps "Sync now"
   in the App. App inserts a `sensor_resync_requests` row directly
   (reason = `app_user_pulled`) and fulfills it via its own subscription
   loop.

## Unified resync request queue

`sensor_resync_requests` is the **reader-agnostic queue** for "the
cloud needs data from a sensor." Either the Primus or the App (or any
future reader) can claim and fulfill rows.

**Schema** (full SQL in `supabase/migrations/015_sensor_resync_requests.sql`):
- `id, sensor_id, user_id, range_start, range_end, reason`
- `claimed_at, claimed_by` — atomic claim semantics
- `fulfilled_at, fulfilled_count, fulfilled_error` — completion state
- `cancelled_at, expires_at` — abandonment

**Race resolution:** atomic `UPDATE … SET claimed_at = now() WHERE id = ?
AND claimed_at IS NULL` decides who wins. Loser gets 0 rows and skips.
The dedup unique index on `(sensor_id, recorded_at)` catches any
reading-level overlap if two readers happen to upload simultaneously.

**Primus integration:** the cloud's heartbeat handler dual-writes —
INSERTs into `sensor_resync_requests` AND queues a `primus_commands`
row for the heartbeating Primus, linked via `params.resync_request_ids`.
When the Primus completes the resync, both rows get marked together.

**App integration:** App subscribes to `sensor_resync_requests` via
Realtime, filtered by `user_id`. On INSERT, app checks BLE range, claims
atomically, pulls from sensor history, uploads, marks fulfilled.

**Reason codes:**

| reason | When |
|---|---|
| `auto_gap_detected` | Heartbeat handler saw a sensor stale > 5 min |
| `gap_fill_retry` | Post-fulfilment density check found gap not fully closed, OR a previous fulfilment errored and is being retried |
| `primus_offline` | pg_cron job (`detect_offline_primus_and_queue_app_failover`) saw a user's only Primus go silent; signals app to take over |
| `admin_manual` | Admin clicked the Resync button in `/admin/primus` |
| `app_user_pulled` | App user tapped "Sync now" |

**Retry on failure:** when a fulfilment errors (`fulfilled_error` non-null),
the cloud automatically queues a fresh request after a backoff (5 min for
transient errors like "BLE busy", 15 min otherwise), capped at 5 retries
before the row is left as-is and admin investigation is warranted.
Retry is driven by `requeue_due_failed_resyncs()` — called from the
heartbeat handler for Primus users (~60s cadence) and via pg_cron every
5 min for app-only users. The retry chain is visible via `retry_of`.

**Timeout cascade:** when a `primus_commands` resync row is auto-marked
timed-out by the heartbeat sweep (delivered but uncompleted for >30 min),
its linked `sensor_resync_requests` rows are auto-cancelled with
`fulfilled_error = 'primus_command_timed_out'`. This frees the dedup
guard and the next gap-detect or retry cycle can re-arm without sitting
behind a stale claim.

## Reader-side modes (App)

The Origin Monitor app implements **failover-aware uploads** so it
plays nice with the Primus when one is present and gracefully takes
over when it's not:

| Situation | App behaviour |
|---|---|
| User has a Primus, Primus heartbeat fresh (<2 min) | **Standby.** Live BLE feed for in-app UI; no cloud uploads. |
| User has a Primus, Primus heartbeat stale (>2 min) | **Take over.** Uploads every 60s, sensor-stamped. |
| User has no Primus | **Always upload** every 60s when in BLE range. |
| Phone out of BLE range | Nothing. On return, history-pull catches up the gap, then resumes. |

**Failover signals** (fastest wins):

- **Path A (~2 min):** App-detected. App sees fresh BLE advertisements
  but cloud `sensor.last_seen` hasn't advanced > 2 min → Primus likely
  dead, take over.
- **Path B (~5-7 min):** Cloud-signalled. pg_cron runs every 2 min and
  inserts `sensor_resync_requests` rows with `reason = 'primus_offline'`
  for any sensor whose user's Primus has been silent > 5 min and whose
  own readings are also > 5 min stale.

**Sensor-clock timestamps:** the app fetches the sensor's clock once
on each BLE connect and uses `(sensor_clock_at_connect + (now -
phone_clock_at_connect))` for live readings, so live + history readings
of the same physical event collapse to one row in `sensor_readings`
via the `(sensor_id, recorded_at)` unique index.

## Cloud-side contracts

### Dedup (migration 010)

```sql
create unique index sensor_readings_sensor_time_uniq
  on public.sensor_readings(sensor_id, recorded_at);
```

This is the **foundation of the architecture**. Two readings with the
same `(sensor_id, recorded_at)` are treated as the same reading —
whether they arrive live, via a gap-fill resync, from the Primus or
from the App, five times or once. All inserts use `upsert` with
`ignoreDuplicates: true`. Readers never have to coordinate.

### Timestamp rule

**The `recorded_at` on a reading must come from the sensor itself, not
from the reader or the cloud.** Both the live path and the buffered
path must use the sensor's timestamp. If a reader substitutes "now"
anywhere in the chain, dedup breaks — the same reading lands twice with
different timestamps.

For sensors that don't stamp their own time (rare): the reader captures
the timestamp at the moment of the BLE notification, stamps the reading
exactly once, and uses that stamp on every subsequent retransmit.

### Endpoints

| Endpoint                   | Who             | Purpose                                    |
| -------------------------- | --------------- | ------------------------------------------ |
| `POST /primus/readings`    | Primus          | Batch upload of readings (up to 100/batch) |
| `POST /primus/heartbeat`   | Primus          | Carries events, delivers commands          |
| Supabase `INSERT`          | App             | Direct insert via RLS policy (migration 004) |
| `POST /primus/email-report`| Primus          | Triggers XLSX email of current hatch       |

## Reader-side contract

Every reader must implement:

1. **Live capture** — consume sensor readings as they're advertised/notified
   via BLE, with the sensor's `recorded_at`.

2. **Local durable buffer** — persist every reading to non-volatile
   storage immediately on capture. Never rely on RAM-only buffering.
   Primus uses a PSRAM ring buffer + FS mirror; app must use SQLite or
   similar.

3. **Upload when online** — when the cloud is reachable, drain the local
   buffer in small batches (10 readings per batch works well — small
   enough to keep TLS memory modest, large enough to be efficient).

4. **Never lose on failure** — if a batch POST fails, the readings stay
   in the local buffer for the next retry. Only remove from the buffer
   when the cloud returns 200.

5. **Historical catch-up via BLE** — on reconnect to a previously-
   disconnected sensor, use the sensor's `readings-range` BLE
   characteristic to pull every reading since `last_successful_post`.
   Feed those into the same local buffer + upload pipeline.

6. **Always send `recorded_at`** — the sensor's timestamp, never "now".
   See the Timestamp rule above.

7. **Back off on persistent failures** — reasonable exponential backoff
   (e.g. 15s → 30s → 2m → 5m) when the cloud is unreachable. Clear the
   backoff immediately on cloud or network reconnect.

8. **Resource discipline** — don't hold live BLE connections open while
   running large-batch uploads; transient contention between the two
   radios + the TLS heap demand can brick constrained devices. For
   long catch-up windows, tear down BLE, upload, re-arm BLE.

## Reliability guardrails (cloud-side)

- **30-min cooldown** between auto-resyncs per device — prevents
  flap-loops if a resync itself is causing the reader to reboot.
- **Consecutive-failure cap (3)** on auto-resyncs — if three auto-fired
  resyncs fail/timeout in a row without any success between them, stop
  auto-firing (manual admin Resync still works). A single successful
  resync resets the counter. Protects against runaway reboot loops
  while still chasing persistent sensor flakiness indefinitely.
- **30-min command timeout** — any command stuck "delivered but not
  completed" for 30+ min gets auto-marked timed-out. Generous enough
  for 24-48h catch-up windows; short enough to clean up abandoned
  commands after a reader crash.
- **Post-completion gap verification** — after every successful resync,
  cloud counts actual readings for each linked sensor over the last
  72h, compared to expected 5-min-resolution density (~12 readings/hr).
  If any sensor is < 50% of expected, queue another resync with the
  full window. Capped at 5 gap-fill retries per device per hour to
  avoid runaway retries on genuine sensor faults.
- **Safeguards log as events** — cloud actions are visible in
  `/admin/primus/{id}/events` so support can see what the cloud decided.

## Scenarios

**Phone offline for 3 days but in BLE range of sensor:**
App captures live readings, buffers in SQLite. Cellular returns →
app drains SQLite in chunked batches. No Primus involved. Dedup
handles any overlap with a Primus that was also uploading. User sees
no gap.

**Farmer leaves site for a week, comes back, no Primus:**
Sensor buffers 1 week of readings on-device (~2016 readings at
5-min intervals). Phone comes into BLE range → app pulls historical
via `readings-range` characteristic → chunked upload. One week of
data appears on dashboard within ~2 minutes. User sees no gap.

**Primus loses power for 3 days:**
Sensors retain all 3 days. Primus boots → cold-boot resync → pulls
each sensor's history via BLE → 3600 readings uploaded over ~12
min via chunked POSTs. Dashboard fills retroactively. User sees no
gap.

**Phone and Primus both present, both uploading:**
Both insert with dedup. Whichever posts a given reading first wins;
the other's insert silently drops. No coordination needed between
them. Readings flow fast because both are trying; redundancy is
free.

**Sensor replaced mid-hatch:**
New sensor has its own serial number. Old sensor's readings stay
in the DB linked to their sensor row. New sensor registers, gets
linked to the hatch, starts flowing. Hatch queries span both
sensors transparently.

## Extension points

**Adding a new reader type** (future web-based dashboard, integration
with a third-party farm-management app, etc):

1. Use the same insert pattern against Supabase with the unique index.
2. Always send sensor-stamped `recorded_at`.
3. Respect the RLS policies — readers need a user JWT or service key.
4. Don't invent a new dedup key — `(sensor_id, recorded_at)` is the
   canonical one.
5. If the reader can accept remote commands, consider integrating with
   `primus_commands` so admin can trigger syncs.

**Adding a new command type** (future: `restart`, `ota_update`,
`set_flag`): see `docs/PRIMUS_ADDENDUM_COMMANDS.md` for the contract.

## References

- Migrations: `supabase/migrations/010_sensor_readings_dedup.sql`,
  `011_primus_events.sql`, `012_primus_commands.sql`
- Cloud code: `api/src/routes/primus.ts` (heartbeat, readings, commands,
  events, auto-detect, timeouts, cooldown, cap)
- Primus firmware: `origin_basestation/src/main.cpp` (reference
  implementation of a reader — full 5-phase resync, PSRAM TLS, chunked
  uploads, event ring buffer)
- Primus integration addendums:
  - `docs/PRIMUS_ADDENDUM_GAP_FILL_RESYNC.md`
  - `docs/PRIMUS_ADDENDUM_EVENTS.md`
  - `docs/PRIMUS_ADDENDUM_COMMANDS.md`
- App addendum: `docs/APP_ADDENDUM_OFFLINE_SYNC.md`

## Changelog

- **2026-04-22** — Document created after end-to-end validation of the
  full sync loop. PSRAM-backed mbedtls + chunked uploads + phased
  resync + auto-gap-detection all confirmed working against real
  sensors with a 7-hour overnight gap fully recovered.
