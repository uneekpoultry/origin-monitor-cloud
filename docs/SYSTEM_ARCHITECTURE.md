# Origin Monitor — Master System Architecture & Technical Reference

> **Status:** v1.0 — drafted 2026-04-27 by Claude (Cloud session).
>
> **Purpose:** the single source of truth for how Origin Monitor's
> hardware, firmware, mobile app, and cloud cooperate. Used for:
> 1. Onboarding future engineers (human or AI).
> 2. Anthropic AI customer support — fed into the knowledge base so
>    the support bot can answer "why is my Primus saying X" or "how
>    do I reset Y" with context.
> 3. Engineering reviews and architectural change proposals.
>
> **Scope split:** this document covers the system as a whole. Each
> reader (Primus firmware, Origin Monitor app) has internal details
> that only its session knows. Sections marked
> **`[TO BE COMPLETED BY CLAUDE PRIMUS]`** or
> **`[TO BE COMPLETED BY CLAUDE APP]`** need the relevant session to
> fill in. After they do, this is the master.

---

## Table of contents

1. [Product overview](#1-product-overview)
2. [Component inventory](#2-component-inventory)
3. [Architecture principles](#3-architecture-principles)
4. [Data flow scenarios](#4-data-flow-scenarios)
5. [Cloud — Supabase (database)](#5-cloud--supabase-database)
6. [Cloud — API server](#6-cloud--api-server)
7. [Cloud — Web portal](#7-cloud--web-portal)
8. [Sensors (Origin Pro / Origin Lite)](#8-sensors-origin-pro--origin-lite)
9. [Primus (Origin Primus basestation)](#9-primus-origin-primus-basestation)
10. [App (Origin Monitor mobile app)](#10-app-origin-monitor-mobile-app)
11. [Inter-component contracts](#11-inter-component-contracts)
12. [Resync / gap-fill protocol](#12-resync--gap-fill-protocol)
13. [Failover model](#13-failover-model)
14. [Hatch-gated recording vs live broadcast](#14-hatch-gated-recording-vs-live-broadcast)
15. [Alarms](#15-alarms)
16. [Authentication & authorisation](#16-authentication--authorisation)
17. [Hosting & infrastructure](#17-hosting--infrastructure)
18. [Deployment processes](#18-deployment-processes)
19. [Migration history](#19-migration-history)
20. [Reference tables](#20-reference-tables)
21. [Glossary](#21-glossary)
22. [Future roadmap](#22-future-roadmap)

---

## 1. Product overview

### What it is

Origin Monitor is an Australian-built ecosystem for monitoring and
managing poultry incubation (and adjacent use cases) end-to-end:

- **Origin Pro / Origin Lite** — battery-powered BLE temperature/
  humidity sensors. Each sensor has a ~1-month on-device flash buffer
  and stamps every reading with its own clock.
- **Origin Primus** — an always-on professional gateway: ESP32-S3
  basestation with BLE central, Wi-Fi, 4.3" LCD display. Sits in the
  hatch room, scans nearby sensors, uploads readings to the cloud,
  shows live hatch dashboard on its screen.
- **Origin Monitor** — Flutter mobile app. BLE central in the user's
  pocket; live readings on the phone; takes over from a failed
  Primus or acts as the sole reader for app-only customers.
- **Origin Monitor cloud** — Next.js web portal (customer + admin) +
  Express.js API + Supabase Postgres / Auth / Realtime. Stores hatch
  history, runs the email-report pipeline, detects gaps, coordinates
  failover, exposes admin tools.

### Who it's for

Serious hobbyist and small-to-medium commercial poultry hatchers. The
~75% of users who run hatches occasionally and don't need a fixed
basestation can use the app standalone. The other ~25% (high-volume
or always-on operators) benefit from a Primus.

### What "serious" means in this product

Customers running real hatches expect:

- **Zero data loss** across power cuts, network outages, app
  backgrounding, Primus reboots
- **Alarms within a few minutes** when temp / humidity drift outside
  species targets
- **Gap-free historical records** for compliance and post-hatch
  analysis (genuine cause-and-effect tracing on hatch outcomes)
- **Long unattended operation** — the kind where you walk away for a
  week and trust the system is still recording

Every architectural decision in this document traces back to one of
those four expectations.

---

## 2. Component inventory

| Component | Form factor | Tech | BLE role | Cloud role |
|---|---|---|---|---|
| Origin Pro | Battery sensor (T/H probe) | KBeacon-protocol BLE peripheral | Peripheral | None — never connects to cloud directly |
| Origin Lite | Battery sensor (T/H) | KBeacon-protocol BLE peripheral | Peripheral | None |
| Origin Primus | Wall-mounted basestation | ESP32-S3, 8MB OPI PSRAM, 4.3" RGB LCD, NimBLE-Arduino, mbedtls | Central | Posts to `/primus/*` endpoints |
| Origin Monitor app | Flutter (Android, iOS later) | FlutterBluePlus, Supabase Dart SDK | Central | Direct Supabase INSERT (RLS-gated) + Realtime subscriber |
| Origin Calibration Kit | Reference dry-bath | n/a | n/a | n/a |
| Origin Scale | Egg / chick weighing | (TBD) | (TBD) | (TBD — not yet integrated) |
| Origin Pulse | Ultrasonic egg candler | (TBD) | (TBD) | (TBD — not yet integrated) |
| Cloud API | Express.js on DigitalOcean droplet | TypeScript, PM2, Zod | n/a | Talks to Supabase as service-role |
| Web portal | Next.js 15 App Router on droplet | TypeScript, PM2, Tailwind | n/a | Talks to Supabase as user (RLS) |
| Supabase | Hosted Postgres + Auth + Realtime | Supabase managed | n/a | Stores everything |

---

## 3. Architecture principles

These are the seven rules every component must obey. They're the
"why" behind every other decision in this doc.

1. **The sensor is the source of truth.** Each sensor holds ~1 month
   of its own readings. Every other component is a *cache* or *view*
   of what the sensor already knows.

2. **Any reader can catch up** without coordination with other
   readers. Primus, app, and any future reader pull from the same
   sensor, with the same idempotency guarantees.

3. **Network outages are invisible to the user.** After a reconnect,
   data appears as if it had been flowing the whole time.

4. **Dedup is idempotent.** Readers can safely overshoot on resync
   without duplicate rows. Foundation: unique index on
   `(sensor_id, recorded_at)` — see migration 010.

5. **The architecture scales to any number of readers** without
   design changes.

6. **Gap-fill is closed-loop**, not one-shot. The cloud verifies
   density after every resync and keeps chasing until data is
   complete (capped at 5 retries/hour to avoid runaway loops).

7. **The cloud only records when a hatch is recording.** A sensor
   that's not linked to any active hatch is in "casual mode" —
   readings are rebroadcast live but **not persisted**. When a hatch
   starts referencing the sensor, persistence kicks in automatically.

These principles produce the user-visible promise: *no data is ever
lost as long as a reader reconnects within ~1 month of the gap, and
when a hatch is running, the cloud guarantees gap-free history.*

---

## 4. Data flow scenarios

### 4.1 Active hatch + Primus + app, all online

```
Sensor ──BLE adv──▶ Primus ──HTTPS──▶ /primus/readings ──▶ sensor_readings (DB)
                                                  └──▶ migration 014 trigger ──▶ sensors.last_seen
Sensor ──BLE adv──▶ App (in BLE range) ──── shouldUpload() returns FALSE (Primus healthy, in standby)
                                       └──▶ on-screen live view only
```

### 4.2 Active hatch + app only (no Primus)

```
Sensor ──BLE adv──▶ App ──Supabase INSERT (RLS)──▶ sensor_readings ──▶ trigger bumps last_seen
                  └──▶ on-screen live view
```

### 4.3 No active hatch + Primus

```
Sensor ──BLE adv──▶ Primus ──HTTPS──▶ /primus/readings
                                        ├─ active hatch? NO → broadcast on Realtime channel "sensor_live:{sensor_id}"
                                        └─ always bump sensors.last_seen
                                                                        ▲
                                                                        │ subscribed
                                                       App / Web dashboard
```

### 4.4 No active hatch + app only

```
Sensor ──BLE adv──▶ App ──── shouldUpload() returns FALSE (no active hatch) → on-screen only
                  └──▶ no cloud activity at all
```

### 4.5 Primus dies mid-hatch, app present

```
[Primus offline, no heartbeat]
[App in BLE range, hearing live ads]

Path A (~2 min):  App detects via "BLE fresh + cloud last_seen stale" → takes over
Path B (~5–7 min): pg_cron detect_offline_primus_and_queue_app_failover()
                   → INSERTs sensor_resync_requests row, reason='primus_offline'
                   → App's Realtime subscription fires → claims → fulfills
```

### 4.6 Phone offline for 3 days, sensor in BLE range

```
[Phone has no cell signal, app captures live BLE ads, buffers locally]
[Sensor logs to its own flash continuously]

[Phone regains network]
App drains local buffer ──Supabase INSERT──▶ sensor_readings
                                            └─ dedup index drops anything Primus already uploaded
```

### 4.7 Farmer leaves for a week, no Primus

```
[Sensor logs to flash for a week ~ 2016 readings]
[Phone returns to BLE range]

App ──BLE history pull──▶ sensor (range characteristic)
       received records ──Supabase INSERT──▶ sensor_readings
       dedup catches any overlap with previous resyncs
```

### 4.8 Cloud-detected gap (closed-loop)

```
Cloud heartbeat handler: "this sensor's last_seen is > 5 min stale"
  → INSERT sensor_resync_requests (reason='auto_gap_detected')
  → INSERT primus_commands (type='resync', linked via params.resync_request_ids)

Primus next heartbeat: receives command in response
  → runs phased resync, uploads
  → reports back via command_results

Cloud: marks command + linked sensor_resync_requests rows fulfilled
  → density check across last 72h
  → if any sensor < 50% of expected density → queue another resync (gap_fill_retry)
  → keeps chasing up to 5 retries/hour
```

---

## 5. Cloud — Supabase (database)

### 5.1 Project facts

- **Provider:** Supabase (managed Postgres + Auth + Realtime).
- **Project URL / anon key / service role:** stored in env files on
  the API and portal droplets; never committed to git.
- **Extensions enabled:** `pg_cron` (in `extensions` schema),
  `pgcrypto` (for `gen_random_uuid()`).

### 5.2 Tables — at a glance

Full DDL lives in `supabase/migrations/*.sql`. This is the navigation
guide.

| Table | What it stores | Key migration |
|---|---|---|
| `auth.users` | Supabase Auth users (managed) | n/a |
| `profiles` | Per-user metadata (timezone, is_admin) | 007 |
| `sensors` | One row per physical sensor; serial, name, model, last_seen, is_ambient, claimed_at, discovered_by_primus | 003, 013 |
| `sensor_readings` | Time-series readings (sensor_id, temperature, humidity, battery_mv, recorded_at) | 010 dedup |
| `hatch_logs` | One row per hatch (name, species, dates, ambient_sensor_id, status, etc.) | 008, 009, 013 |
| `hatch_sensors` | Many-to-many: which incubator sensors belong to which hatch | 006 |
| `primus_devices` | Registered Primus units; api_key_hash, last_seen, firmware_version, wifi_ssid | 002 |
| `primus_events` | Ring buffer of warnings/errors uploaded by Primus on heartbeat | 011 |
| `primus_commands` | Command queue cloud → Primus (resync, etc.) | 012 |
| `sensor_resync_requests` | Reader-agnostic gap-fill request queue | 015, 016 |
| `cron.job` | pg_cron scheduled jobs | 016 |

### 5.3 Key triggers

| Trigger | Migration | Purpose |
|---|---|---|
| `bump_sensor_last_seen` AFTER INSERT on `sensor_readings` | 014 | Auto-update `sensors.last_seen` so any reader writing readings refreshes the freshness timestamp. Bypasses the need for the API to set it explicitly. |

### 5.4 Key functions

| Function | Migration | Purpose |
|---|---|---|
| `is_admin()` | (early) | Returns true if `auth.uid()` has `is_admin = true` on profiles; used by RLS policies. |
| `bump_sensor_last_seen()` | 014 | Trigger function above. |
| `resync_retry_backoff_minutes(error)` | 016 | Returns 5 or 15 based on error string match (transient vs other). |
| `requeue_due_failed_resyncs(user_id, max_retries)` | 016 | Admin / heartbeat-side function: scans failed `sensor_resync_requests` due for retry, queues fresh ones, cancels originals. |
| `requeue_my_failed_resyncs()` | 016 | User-callable RPC wrapper around the above; defaults to `auth.uid()`. |
| `detect_offline_primus_and_queue_app_failover()` | 016, **superseded by 017** (now hatch-gated) | pg_cron scans for users whose only Primus has gone silent and a sensor in an active hatch is going stale; queues `sensor_resync_requests` with reason `'primus_offline'`. |
| `trim_primus_events(primus_id, keep)` | 011 | Trims the per-Primus event ring to N newest. |

### 5.5 pg_cron jobs

Scheduled in migration 016:

| Job name | Cadence | What it does |
|---|---|---|
| `origin_detect_offline_primus` | every 2 min | Calls `detect_offline_primus_and_queue_app_failover()` |
| `origin_requeue_failed_resyncs` | every 5 min | Calls `requeue_due_failed_resyncs()` (no user filter — global sweep) |

Verify with: `select jobid, jobname, schedule, active from cron.job where jobname like 'origin_%';`

### 5.6 RLS policies — summary

- **`sensors`** — owner read/update, admin all
- **`sensor_readings`** — owner read; INSERT allowed if user owns the sensor (migration 004)
- **`hatch_logs`, `hatch_sensors`** — owner read/insert/update
- **`primus_devices`, `primus_commands`, `primus_events`** — admin only; not user-readable
- **`sensor_resync_requests`** — owner read/insert/update (claim + fulfil only their own); admin all (migration 015)
- **`profiles`** — owner read/update self; admin all

### 5.7 Realtime publication

Tables in `supabase_realtime` publication (Realtime watches them and
pushes INSERT/UPDATE/DELETE to subscribers):

- `sensor_readings` (migration 005)
- `sensor_resync_requests` (migration 015)

Plus **broadcast channels** (no DB table, pure pub/sub):

- `sensor_live:{sensor_id}` — broadcast event `'reading'` carrying
  live values when the sensor is in casual mode (no active hatch).
  Sent by the API's `/primus/readings` handler via `httpSend()`.
  Subscribed by app + web portal for remote live viewing.

---

## 6. Cloud — API server

### 6.1 Tech stack

- **Runtime:** Node.js, Express.js
- **Language:** TypeScript
- **Validation:** Zod schemas on every endpoint
- **DB client:** `@supabase/supabase-js` v2.47.x with service-role key
- **Hosting:** DigitalOcean droplet (170.64.219.199)
- **Process manager:** PM2 (process name `origin-api`)
- **Path on droplet:** `/srv/origin-monitor/api`
- **Code path in repo:** `api/`

### 6.2 Endpoints

All authenticated endpoints require `Authorization: Bearer <api_key>`.
The middleware `requirePrimusAuth` checks `api_key_hash` against
`primus_devices` and attaches `req.primus = { deviceId, userId }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/primus/sensors` | Primus | List sensors owned by this Primus's user. Used by Primus to pick up name / model changes. |
| PATCH | `/primus/sensors/:id` | Primus | Update a sensor name from the Primus LVGL UI. |
| GET | `/primus/hatches` | Primus | Hatches dashboard payload for the Primus 4.3" LCD. Up to 10 active hatches. |
| POST | `/primus/email-report` | Primus | Trigger XLSX hatch report email. Body: `{ hatch_id? }`. |
| POST | `/primus/heartbeat` | Primus | Carries events + command results, returns pending commands. Cadence: up to 10 min (was 60s; widened 2026-05-01 to mitigate RGB-LCD tearing caused by BLE-scan PSRAM contention — see DISPLAY_TEARING_INVESTIGATION.md). |
| POST | `/primus/readings` | Primus | Batch upload of readings (up to 100). Splits record vs broadcast based on active-hatch link. |

The API also serves a few internal/admin endpoints which are out of
scope for this overview.

### 6.3 The `/primus/heartbeat` handler — what it does, in order

The most complex single endpoint. On every Primus heartbeat:

1. Update `primus_devices.last_seen`, `firmware_version`, `wifi_ssid`.
2. Adopt Primus's reported timezone if profile is still default.
3. Ingest events into `primus_events` (deduped by primus_id+observed_at+source+message), trim to 500 newest.
4. **Process command_results**: for each, mark the matching `primus_commands` row completed; if it was a resync linked to `sensor_resync_requests`, mark those rows fulfilled with the count/error.
5. **Gap-fill density check** (post-resync): walk active-hatch-linked sensors, count last 72h of readings vs expected (12/hr); if any < 50%, queue another resync (`reason='gap_fill_retry'`). Capped at 5 retries/hour. **Insert dedup**: skip if there's already an open request for that sensor.
6. **Timeout cascade**: any `primus_commands` row delivered but not completed in > 30 min → mark timed out. Cascade to linked `sensor_resync_requests`: mark `cancelled_at = now()` with `fulfilled_error = 'primus_command_timed_out'`.
7. **Retry sweep**: call `requeue_due_failed_resyncs(userId)` to re-queue any failed `sensor_resync_requests` rows past their backoff.
8. **Auto gap-detection**: find sensors of this user with `last_seen > 5 min stale`, **filter to active-hatch sensors only** (via `sensorsInActiveHatch()`), check 30-min cooldown + consecutive-failure cap (3), then **insert dedup** (skip sensors that already have an open request) and queue one `sensor_resync_requests` row per gappy sensor + one `primus_commands` resync covering all of them.
9. **Deliver pending commands**: respond with up to 10 undelivered commands for this Primus, mark them `delivered_at`.

### 6.4 The `/primus/readings` handler — split logic

For each batch of readings:

1. Look up `sensors` rows for each serial. Auto-create pending rows for unknown serials (`discovered_by_primus = this_primus`).
2. Refresh advertised name on still-pending sensors.
3. Build the rows array (filter out sensors not owned by this user).
4. Call `sensorsInActiveHatch(userId, sensorIds)` → returns the subset that are in any active hatch (via `hatch_sensors` OR `hatch_logs.ambient_sensor_id`).
5. **Record path** (sensors in active hatch): UPSERT into `sensor_readings` with `onConflict: sensor_id,recorded_at, ignoreDuplicates: true`.
6. **Live-only path** (no active hatch): broadcast each reading on `sensor_live:{sensor_id}` channel via `httpSend('reading', payload)`.
7. **Always** bump `sensors.last_seen` for every sensor in the batch.
8. Respond `{ ok, accepted, inserted, duplicates, live_only, pending_created, skipped }`.

### 6.5 Auth middleware

`requirePrimusAuth` (`api/src/middleware/primus-auth.ts`):
- Extracts `Authorization: Bearer <token>` header
- SHA-256 hashes the token
- Looks up `primus_devices` where `api_key_hash = ?`
- Attaches `req.primus = { deviceId, userId }` and continues; else 401

API keys are issued by the admin via `/admin/primus` → "Add device";
shown once at creation, never stored in plaintext anywhere.

---

## 7. Cloud — Web portal

### 7.1 Tech stack

- **Framework:** Next.js 15, App Router, server components by default
- **Auth:** Supabase Auth via `@supabase/ssr`
- **DB access (user):** Supabase JS with user JWT (RLS-gated)
- **DB access (admin):** Supabase JS with service-role key (in server actions only)
- **Styling:** Tailwind CSS, custom design tokens
- **Hosting:** DigitalOcean droplet, PM2 process `origin-portal`
- **Path on droplet:** `/srv/origin-monitor/portal`
- **Code path in repo:** `portal/`

### 7.2 Routes

```
(public)                     marketing pages, sign-in, sign-up
  /, /signin, /signup, /forgot-password

(app) — requires authenticated user
  /dashboard                 customer dashboard (sensors, hatches at a glance)
  /dashboard/hatches/[id]    individual hatch detail page
  /dashboard/sensors/[id]    sensor history + settings
  /dashboard/settings        profile + timezone

(admin) — requires is_admin = true
  /admin                     overview
  /admin/users               user management
  /admin/primus              Primus device list + register / revoke / rotate / resync
  /admin/primus/[id]/events  per-device event log
```

### 7.3 Server actions

Located in `portal/app/(admin)/admin/primus/actions.ts` and similar:

| Action | What it does |
|---|---|
| `registerPrimus(userId, name)` | Create new `primus_devices` row, return one-time API key |
| `revokePrimus(deviceId)` | Delete device |
| `rotatePrimusKey(deviceId)` | Issue new API key |
| `requestResync(deviceId, sinceIso)` | Queue resync command + dual-write `sensor_resync_requests` (reason='admin_manual') |

---

## 8. Sensors (Origin Pro / Origin Lite)

### 8.1 Hardware

| | Origin Pro | Origin Lite |
|---|---|---|
| Probe | External T+H probe on cable | Internal T+H |
| Battery | (TBD — fill in) | (TBD) |
| BLE protocol | KBeacon | KBeacon |
| Flash buffer | ~1 month at 5-min logging | ~1 month |
| Default log interval | 5 min | 5 min |
| Adv interval | (TBD — typically ~1s) | (TBD) |

### 8.2 BLE protocol — KBeacon

Sensors implement the KBeacon protocol (third-party hardware spec).
Both Primus and App use this protocol via their respective stacks
(NimBLE-Arduino on the Primus, FlutterBluePlus on the app).

Key characteristics:

- **Advertising packets** carry the latest live reading (no timestamp;
  reader infers from sensor clock at connect time).
- **History characteristic** (read-by-range): the reader specifies
  `startRecordId, maxRecords, readOption`, and the sensor returns
  records from its on-board flash.
  - `readOption = 0`: forward read (oldest first)
  - `readOption = 1`: reverse read (newest first) — used by gap-fill
  - `readOption = 2`: "new only" — start from the most recent
  - First-request `readRecordId = 0xFFFFFFFF` for reverse and "new only" — sentinel for "newest"
- **Clock characteristic**: returns the sensor's current time (UTC seconds since epoch). Read once at connect time so the reader can compute the phone-clock-to-sensor-clock delta.

### 8.3 Timestamp rule (CRITICAL)

**`recorded_at` on every reading must come from the sensor's own
clock**, not from the phone, the Primus, or the cloud. This is the
foundation of dedup — the same physical reading produced by the
sensor must hash to the same `(sensor_id, recorded_at)` regardless
of which reader uploaded it.

For history records: use the record's stored `utcTime` directly.
For live BLE advertisements (no embedded timestamp): the reader
fetches sensor clock once on connect, computes
`delta = sensor_clock - phone_clock`, then for every live ad does
`recorded_at = phone_now + delta`.

Both Primus and App implement this rule.

### 8.4 `is_ambient` flag

Each `sensors` row has a boolean `is_ambient`. When true, the sensor
represents *room/ambient* air, not the inside of an incubator. UI
across all readers (web portal, Primus LCD, app) renders ambient
sensors with an amber/gold accent and never blends their readings
into incubator averages.

---

## 9. Primus (Origin Primus basestation)

### 9.1 Hardware

- **MCU:** ESP32-S3
- **PSRAM:** 8MB OPI PSRAM
- **Display:** 4.3" RGB LCD with bounce buffer
- **Flash:** (TBD — typical 16MB)
- **Power:** mains, 5V DC

### 9.2 Firmware stack

- **Platform:** pioarduino `54.03.21-2` — pinned in `platformio.ini`
- **Arduino-ESP32:** 3.2.1
- **IDF version:** 5.4.2
- **BLE:** NimBLE-Arduino 2.5.0
- **TLS:** mbedtls with PSRAM-routed memory pool (≥2 KB allocations land in PSRAM, smaller stay internal)
- **UI:** LVGL 8.4 (C API; not v9). Draw buffers: 8 lines × 800 px in PSRAM via `ps_malloc`
- **Watchdogs:** IWDT (TG1) extended to 2000 ms via tick-hook; TWDT (TG0) at IDF default 5 s
- **Recovery point:** git tag `pre-idf54-downgrade` (commit `2678fc8`) — rolls back to IDF 5.5.4 baseline if needed

> **Why pioarduino, not upstream:** the upstream `platformio/platform-espressif32` lags Arduino-ESP32 by months. `pioarduino` is a community fork that tracks Arduino-ESP32 closely and is the only practical way to get IDF 5.x on PlatformIO today.

> **Why IDF 5.4.2, not 5.5.x:** IDF 5.5.x has a confirmed PSRAM cache regression family ([IDFGH-17263](https://github.com/espressif/esp-idf/issues/18253) marked "Won't Do" by Espressif; IDFGH-16877 still open) that triggered `TG1WDT_SYS_RST` at PC `0x403857bd` (`cache_writeback_items_freeze`) every ~12 minutes during cloud TLS work on this stack. IDF 5.4.2 has the L1↔L2 cache writeback fix and predates the 5.5.x regressions. Free side benefit: 87 KB → 201 KB free heap at READY.

### 9.3 Architecture overview

#### Task layout

| Task | Core | Stack | Priority | Created via | Responsibility |
|---|---|---|---|---|---|
| `bleTask` | **0** | 16 KB | 2 | `xTaskCreatePinnedToCore(bleTask, "BLE_Task", 16384, NULL, 2, NULL, 0)` near end of `setup()` | NimBLE scan, KBeacon parsing, connected-mode auth/commands, TimeSync + NameSync auto-ops, cloud cycle (heartbeat / readings / sensors / hatches), resync flow, ring-buffer drain |
| Arduino `loop()` | **1** | Arduino main | Default | n/a (Arduino runtime) | `lv_timer_handler()`, sidebar nav, settings overlays, WiFi reconnect watchdog (60 s), serial command parser, deferred `WiFi.begin()` (~30 s after boot) |
| WiFi event task | sys | sys | sys | `WiFi.onEvent(onWiFiEvent)` in `setup()` | DHCP / IP / disconnect callbacks; resets cloud backoff on `STA_GOT_IP`; tears down HTTP keep-alive on `STA_DISCONNECTED` |
| RGB-panel bounce-buffer ISR | n/a | n/a | ISR | RGB panel driver (Arduino_GFX) | Fills 10-line bounce-buffer staging buffer (~16 KB internal RAM) from PSRAM framebuffer for LCD DMA |
| FreeRTOS tick hook | both cores | n/a | tick context | `esp_register_freertos_tick_hook_for_cpu(iwdt_bump_tick_hook, 0)` first thing in `setup()` | Re-extends IWDT stage 0/1 timeouts to 2000 ms on every tick; defeats IDF's own `tick_hook` that resets to `CONFIG_ESP_INT_WDT_TIMEOUT_MS` |

**Mutex pattern.** A single `sensorMutex` (FreeRTOS semaphore) protects the 4-slot `sensors[]` array. Producer side (Core 0): take, write, release. Consumer side (Core 1, LVGL): take, snapshot to a local struct, release immediately, then call LVGL using the snapshot. **LVGL is never held under the mutex** — LVGL calls can take 10s of ms and would block sensor updates if held.

#### Boot sequence

`setup()` runs on Core 1 with explicit `BOOT_MARK("[BOOT] stage N: ...")` checkpoints. Order is constrained by hardware dependencies — each stage assumes the previous is fully done.

| Stage | What runs | Why this order |
|---|---|---|
| 0 | `Serial.begin(115200)`, `setTimeout(0)`, 5 s wait for USB CDC enumerate | Must precede any printf |
| 0a | IWDT tick-hook install (`esp_register_freertos_tick_hook_for_cpu`) | Must run BEFORE any TLS / large-PSRAM allocation to absorb cache stalls |
| 1 | `Wire.begin(8, 9)` + GT911 touch probe (try 0x14, fall back to 0x5D) | Touch + IO-expander share I²C bus; bus must come up first |
| 2 | CH422G IO expander init: write Mode reg (0x24) = 0x01, write Output reg (0x38) = 0x1E (BL on, RSTs high, SD CS high) | Must precede LCD because backlight is on EXIO2 |
| 3 | `gfx->begin()` — RGB panel init at 14 MHz PCLK with `bounce_buffer_size_px = 10*800` | LCD scanout configured before any framebuffer write |
| 4 | `gfx->fillScreen(BLACK)` — first PSRAM write | Validates PSRAM bus + framebuffer alloc; failure here means OPI PSRAM init didn't take |
| 5 | `lv_init()` + draw buffer alloc (8 lines × 800 px in PSRAM via `ps_malloc`) + `lv_disp_drv_register` + `lv_indev_drv_register(touchpad_read_cb)` | LVGL needs the panel ready; touch indev needs GT911 ready |
| 6 | `nvs_load_all()` — restore sensor MACs, names, colours, ambient flags, calibration offsets, alert thresholds, timezone (POSIX TZ + IANA name), WiFi creds, API key, `last_cloud_ok_epoch` | NVS state drives everything afterwards |
| 7 | `SPIFFS.begin(true)` + restore per-sensor history (`/hist_0.bin` … `/hist_3.bin`) into `bleHistoryBufs[]` | History is rendered on the chart screens |
| 8 | Pre-build all LVGL screens (Dashboard, Sensor Detail, Settings, About, Hatches, Compare) | Pre-build keeps screen switches instant |
| 9 | RTC init: apply POSIX TZ via `setenv("TZ", ...)` + `configTzTime(...)` (NTP starts after WiFi connects, see WiFi event handler) | |
| 10 | `WiFi.onEvent(onWiFiEvent)` registered, but `WiFi.begin()` NOT called yet — deferred ~30 s into `loop()` so BLE + sensors come up first | User wants sensors visible immediately on boot |
| 11 | `xTaskCreatePinnedToCore(bleTask, "BLE_Task", 16384, NULL, 2, NULL, 0)` — bleTask starts NimBLE scan | |
| 12 | `[READY] Free heap: ... PSRAM: ...` — `setup()` returns, `loop()` takes over on Core 1 | |

Steady-state on IDF 5.4.2: `[READY] Free heap: ~201 KB | PSRAM: ~7.20 MB`.

#### BLE scan + filter logic

- Stack: NimBLE-Arduino 2.5.0 (replaces Bluedroid; ~60 KB lighter on internal RAM).
- **Active scan, ~25 % duty cycle.** 2 s scan window then ~6 s gap. Leaves radio time for WiFi co-existence.
- Scan callback checks `getServiceDataUUID() == 0xFEAA` (Eddystone) and frame type byte `0x21` (KSensor). 2-byte sensor mask (big-endian) selects which fields follow:
  - bit `0x01` → battery (2 bytes mV, big-endian)
  - bit `0x02` → temperature (2 bytes, signed 8.8 fixed-point — `value / 256.0`)
  - bit `0x04` → humidity (2 bytes, signed 8.8 fixed-point)
- MAC matched against `sensors[].macAddress`. Auto-pairs into next free slot when an unsaved KBeacon MAC is seen.
- **Connected mode** (KBeacon protocol over GATT) used only for: TimeSync (push current UTC), NameSync (push user-given name down to the physical KBeacon), history download (resync), config writes (Settings → Send to Sensor). All connected-mode work goes through a state machine (`g_conn_state`: `IDLE` → `REQUESTED` → `RUNNING` → `DONE`/`FAILED`).

#### PSRAM ring buffer for offline readings

- 1000 entries, ~74 KB allocated in PSRAM at boot (`ps_malloc`).
- Entry: `{ uint8_t sensor_idx, float temperature, float humidity, uint16_t battery_mv, uint32_t timestamp_epoch }`.
- Single-threaded — only `bleTask` writes (push) and reads (drain).
- **Push** path: every BLE advertisement that produced fresh values (≥1 s since last save for that sensor).
- **Drain** path: cloud cycle's `cloud_do_readings()` peels off batches via `POST /primus/readings`.
- **Cleared on 401** (cloud-initiated session invalidation — drives the user to re-enter API key in Settings).
- **Wraparound on overflow** (oldest reading lost). At 5-min sampling × 4 sensors that's ~3 days of buffering before loss.

There is also a per-sensor **filesystem mirror** for BLE history records (the deeper backstop, populated by Phase 1 of resync — see below). `/hist_X.bin` files on SPIFFS, ~3.4 MB partition, each record 8 bytes (UTC + signed 8.8 temp + signed 8.8 humid).

#### Five-phase resync flow

Triggered by (a) cloud-issued `resync` command in heartbeat response, or (b) cold-boot gap-fill (NTP-derived gap > 10 min, deferred until screen-off OR after 15 min of screen-on, whichever first).

| Phase | What happens | Heap state |
|---|---|---|
| 1 | `WiFi.disconnect(true)` (single-call teardown — **not** followed by `WiFi.mode(WIFI_OFF)`; that pattern races NetworkEvents on Arduino-ESP32 3.x and triggers a `__throw_bad_function_call` abort). Tear down HTTP client. For each online sensor: BLE connect → MD5 auth via FEA0 service (FEA2 notify, FEA3 indicate) → request count via `[0x03,0x00,0x00,0x01,0x02,0x00,0x00,0x00,0x00]` → request records `[0x03,0x00,0x00,0x02,0x02, recordId(4), maxCnt(2), readOpt, connItvl]` with `readOpt=0x01` (reverse, newest first). Records (8 bytes each: UTC + signed 8.8 temp + signed 8.8 humid) saved to `/hist_X.bin` on SPIFFS. | ~68 KB internal free (WiFi off frees ~25 KB) |
| 2 | `pNimBLEScan->stop()` — pause scan for upload run. | High |
| 3 | `WiFi.mode(WIFI_STA)` + `WiFi.begin(g_wifi_ssid, g_wifi_pass)`. Wait for `STA_GOT_IP` event (`g_wifi_connected = true`). | Drops back to ~91 KB after WiFi/lwIP re-init |
| 4 | Drain offline ring buffer + history files in `POST /primus/readings` batches. **75 ms `vTaskDelay` between batches** to let cache writeback / lwIP catch up. **Every 5 batches: `cloud_http_teardown()`** to clear mbedtls / lwIP / PSRAM-cache state that accumulates under back-to-back POSTs (this prevented `cache_writeback_items_freeze` crashes on 5.5.x; kept on 5.4.2 as belt-and-braces). | ~28 KB free during TLS, recovers to 91 KB after |
| 5 | `g_resync_pending = false`. BLE scan resumes naturally on next `bleTask` iteration. Log line: `[Resync] resync: pushed=N uploaded=M sensors=K win=<minutes>`. | Steady-state |

`cmd_execute_resync` also clears `g_cold_boot_resync_deferred` so a cmd-resync supersedes a still-pending deferred one. This prevents redundant Phase 1 chains and the resulting NetworkEvents `bad_function_call` abort observed on 2026-04-25.

#### Watchdog tick-hook pattern

The challenge: ESP-IDF's IWDT (TG1 on ESP32-S3) defaults to 300 ms. PSRAM cache writeback during TLS handshake can stall past that under bus contention with the bounce-buffer ISR, tripping `TG1WDT_SYS_RST` at PC `0x403857bd` (`cache_writeback_items_freeze`).

Setting `CONFIG_ESP_INT_WDT_TIMEOUT_MS` in `custom_sdkconfig` doesn't stick on its own — IDF's own `tick_hook` in `int_wdt.c` rewrites the IWDT stage timeouts back to that compile-time constant **on every FreeRTOS tick**. We register a SECOND tick hook AFTER IDF's, marked `IRAM_ATTR` (tick hooks run from ISR context with cache disabled during flash ops; non-IRAM code panics with "Cache error: Cache disabled but cached memory region accessed"):

```c
#define IWDT_EXTENDED_MS  2000
#define IWDT_TICKS_PER_US 500   // MWDT_LL_DEFAULT_CLK_PRESCALER at 80 MHz APB

static void IRAM_ATTR iwdt_bump_tick_hook(void) {
  wdt_hal_write_protect_disable(&s_iwdt_bump_ctx);
  wdt_hal_config_stage(&s_iwdt_bump_ctx, WDT_STAGE0,
      IWDT_EXTENDED_MS * 1000 / IWDT_TICKS_PER_US, WDT_STAGE_ACTION_INT);
  wdt_hal_config_stage(&s_iwdt_bump_ctx, WDT_STAGE1,
      2 * IWDT_EXTENDED_MS * 1000 / IWDT_TICKS_PER_US, WDT_STAGE_ACTION_RESET_SYSTEM);
  wdt_hal_write_protect_enable(&s_iwdt_bump_ctx);
}
```

`s_iwdt_bump_ctx` is configured to `WDT_MWDT1` / `&TIMERG1`. Hook registered as the very first thing in `setup()`, before any TLS or large-PSRAM work runs.

The TWDT (TG0, task watchdog) runs at IDF default 5 s — sufficient on 5.4.2 (was insufficient on 5.5.4 where `cache_writeback_items_freeze` could stall longer than 5 s).

#### The `cache_writeback_items_freeze` stall

`PC=0x403857bd` traced to `cache_writeback_items_freeze` — an internal ESP-IDF cache management function that drains pending dirty cache lines before allowing DMA reads of PSRAM. On the IDF 5.5.x line, this can stall over 2 seconds under PSRAM bus contention (TLS handshake + bounce-buffer ISR + mbedtls allocations all hitting OPI PSRAM simultaneously).

We hit this every ~12 minutes during cloud cycles on IDF 5.5.4. Espressif marked the related issue ([IDFGH-17263](https://github.com/espressif/esp-idf/issues/18253)) as "Won't Do" — confirmed regression on the 5.5.x line, declined to fix.

**Fix:** stay on IDF 5.4.2 (see section 9.2 above). 5.4.2 has the L1↔L2 cache writeback fix and predates the 5.5.x PSRAM regressions. The IWDT tick-hook is still in place as belt-and-braces; on 5.4.2 we don't actually trip it.

#### Tearing reduction (active mitigation)

Sidebar tearing under PSRAM bus contention is mitigated by `g_lvgl_pause_until_ms` — a time-based gate in `loop()` that skips `lv_timer_handler()` during the cloud cycle window:

```c
volatile uint32_t g_lvgl_pause_until_ms = 0;
// Set in bleTask cloud cycle: g_lvgl_pause_until_ms = millis() + 3000;  // safety cap
// Cleared after cycle: g_lvgl_pause_until_ms = 0;
// Gate in loop():
//   if (g_lvgl_pause_until_ms == 0 || (int32_t)(millis() - g_lvgl_pause_until_ms) >= 0) lv_timer_handler();
```

Reduces tearing from "continuous during cycle" to "~1 second per minute" (single cycle worth of TLS contention). Full elimination is queued: `fb_num=2` double-frame-buffer experiment will give the LCD a buffer to scan from while LVGL writes to the other one — zero contention by design.

### 9.4 Heartbeat protocol (cloud-facing)

- **Cadence:** up to 10 min (was 60s — widened 2026-05-01 to mitigate
  RGB-LCD tearing caused by BLE-scan PSRAM-bus contention. Each cloud
  cycle pauses BLE while it runs; less-frequent cycles = fewer visible
  tearing windows per hour. See `DISPLAY_TEARING_INVESTIGATION.md`.)
- **Endpoint:** `POST /primus/heartbeat`
- **Body:**
  ```json
  {
    "firmware_version": "x.y.z",
    "wifi_ssid": "<current SSID>",
    "timezone": "Australia/Perth",
    "events": [
      { "observed_at": "...", "severity": "warn", "source": "...", "message": "..." }
    ],
    "command_results": [
      { "id": "<cmd_id>", "status": "ok|error", "result": { ... } }
    ]
  }
  ```
- **Response:**
  ```json
  {
    "ok": true,
    "events_acked": [...],
    "commands": [
      { "id": "<uuid>", "type": "resync", "params": {...} }
    ]
  }
  ```

### 9.5 Readings upload

- **Cadence:** up to 10 min (was 60s — same widening as heartbeat).
  Each batch can carry up to 10 minutes worth of accumulated readings.
- **Endpoint:** `POST /primus/readings`
- **Behaviour:** uploads ALL sensors regardless of hatch state — the
  cloud decides whether to record or just broadcast. The Primus is
  the always-on professional gateway; it doesn't optimise based on
  hatch state.

### 9.6 Commands the Primus must handle

See `docs/PRIMUS_ADDENDUM_COMMANDS.md`. Today only `resync` is
implemented; future: `restart`, `ota_update`, `set_flag`, etc.

### 9.7 LCD UI

#### Layout primitives

- **Sidebar:** 140 px wide, `#1E5631` (sidebar green). Origin logo + "ORIGIN BASE STATION" text + four nav buttons (Dashboard, Compare, Hatches, Settings). About is reachable from Settings.
- **Header:** 64 px tall, `#3B924B` (primary green). Left: device name. Centre: live time + date. Right: WiFi icon (white) + cloud icon, colour-coded:
  - **grey** = WiFi off / disconnected
  - **yellow / amber** = WiFi up but cloud failing (≥ 2 consecutive heartbeat fails)
  - **green** = cloud current
  - **red** = cloud error (401 / persistent failure)
- **Content area:** 660 × 416 px (below the 64 px header, right of the 140 px sidebar).
- **LVGL:** v8.4 C API (NOT v9 — the API changed significantly). Custom 72-pt fonts (Bebas Shadow, DSEG7, Roboto Cond, Montserrat) generated via `lv_font_conv` with `--no-compress --no-prefilter`; `lv_conf.h` has `LV_USE_FONT_COMPRESSED 0` so compressed fonts render blank with no error.
- **Display quirks:** RGB panel scans pixels right-to-left at the hardware level; touch coordinates are pre-corrected via `ts.setRotation(ROTATION_INVERTED)`. PCLK fixed at 14 MHz (12 MHz causes panel sync loss; 16 MHz produces flicker).

#### Screens

**Screen 1 — Dashboard.** 2 × 2 sensor card grid. Each card: 4 px coloured left edge (per-sensor identity colour: blue / green / purple / orange), name (Montserrat 16), online/offline pill (top-right), temperature (Bebas Shadow 72 pt, red `#E53935`) + °C unit, humidity (Bebas Shadow 72 pt, blue `#1E88E5`) + % unit, battery icon. **Ambient flag:** sensors with `is_ambient = true` show an amber `Room Temp` pill (94 × 22 px, soft amber `#FEF3C7` bg, `#F59E0B` border) top-right, left of the online status. Tap a card → Sensor Detail screen.

**Screen 2 — Sensor Detail.** Full-screen single-sensor view from a card tap. Same big values, plus battery voltage (mV), RSSI, last-updated relative time. Header carries the room-temp amber pill if applicable. Back button returns to Dashboard.

**Screen 3 — Settings.** Scrollable tile grid (`LV_DIR_VER`):
- **Date & Time** — ± pickers for HH/MM/DD/MM/YYYY, Apply writes via `settimeofday()`. NTP overrides this when WiFi connects.
- **Time Zone** — POSIX TZ string stored in NVS, applied via `setenv("TZ", ...)` + `configTzTime(...)`. Selectable IANA name (e.g. `Australia/Melbourne`) for display + cloud heartbeat.
- **WiFi** — SSID + password entry (LVGL keyboard overlay). Save triggers `WiFi.reconnect()`; disconnect reason code logged on failure.
- **Send to Cloud** — API key entry (one-time) + manual `Resync now` button.
- **Device Info** — firmware version, uptime, free heap, free PSRAM, WiFi RSSI, cloud `last_seen` epoch.
- **Sensor Management** — one row per sensor slot (4): coloured dot + name + Rename + Send to Sensor buttons. Rename uses LVGL keyboard; the rename propagates Primus → app (cloud) → physical KBeacon via the NameSync auto-op (closes the three-way rename loop within ~30 s).
- **Send to Sensor** overlay — Save Name + Sync Time buttons + live status label (`Connecting...` → `Authenticated` → `Saving...` → `Done`). Backed by the connected-mode state machine.

**Screen 4 — About.** Static: app name, firmware version, Uneek Poultry credit, related Origin projects.

**Screen 5 — Hatches.** Renders up to 10 active hatches from `GET /primus/hatches`. Each hatch is a 4-card layout:

- **Card 1 — Day count.** Day X / N (Montserrat 36 pt, left-aligned). Progress bar (gold `#D4A017`). Species + phase line ("Chicken — turning"). Ambient/Room block at the bottom: amber-tinted box (`#FEF3C7` bg, `#F59E0B` border) showing room temp + humidity + sensor name. Hidden if `ambient_sensor_id == null`.
- **Card 2 — Incubator Temperature.** Big value (Bebas Shadow 72 pt) + °C unit. Subtitle: "Avg of N sensors" or "Single sensor" (driven by `hatch_sensors` count, ambient excluded). Target line + Today's high/low. Card tinted green when in-range, amber when drifting, red when alarm-territory.
- **Card 3 — Incubator Humidity.** Same layout as Card 2.
- **Card 4 — Up Next.** Big day count ("14") + "days to lockdown" / "days to hatch" depending on phase. Date the milestone falls on ("Mon 27 Apr"). Sensors-online line ("3 / 4 sensors online"). Email button — sends current hatch report via `POST /primus/email-report`.

**Screen 6 — Compare.** Multi-sensor overlaid temp + humidity chart over time. Each sensor's series colored by its identity colour, with an amber colour dot for ambient sensors in the legend. Sidebar Compare button is dimmed when fewer than 2 sensors are online.

**Screen 7 — Alert Overlay (TODO).** Full-screen modal, flashing red border, sensor + reading + threshold breached, dismiss button, 30 s auto-dismiss, 2 min cooldown per sensor per alert type. Audible buzzer on a TBD GPIO. Default thresholds (incubator): Temp 36–39 °C, Humidity 35–75 % — all OFF by default. **Ambient sensors are excluded from alarms** (different target range than incubator).

**Screen 8 — History & Graphs (TODO).** Per-sensor history download (30 K – 37 K records via BLE connected mode), line chart, CSV export.

#### Ambient sensor styling — convention

Amber/gold (`#F59E0B` border, `#FEF3C7` soft fill) is reserved for sensors with `is_ambient = true`. Used consistently across:
- Dashboard card (Room Temp pill)
- Sensor Detail header (Room Temp pill)
- Settings sensor row (left of online status)
- Compare colour-key (amber dot)
- Hatches Card 1 (full ambient block at bottom)

This matches the web portal convention. Ambient is never blended into incubator averages; the "Avg of N sensors" subtitle on Hatches Cards 2/3 reflects only `hatch_sensors`-linked (incubator) sensors.

#### Alarm rendering (planned)

Card 7 above describes the full overlay. Until then, alarm conditions trigger a red border on the offending Dashboard card and a red badge in the Compare legend. Audible buzzer wiring is in the TODO list.

#### Tearing mitigation

Sidebar tearing under PSRAM bus contention is mitigated by `g_lvgl_pause_until_ms` — see section 9.3 above. Reduces tearing from "continuous during cycle" to "~1 second per minute". Full elimination via `fb_num = 2` queued.

### 9.8 Product line — Display / Mini / Connect (hardware split + upgrade model)

> **Status:** decided 2026-05-18 (Andrew + Cloud session). Canonical
> decision record. Firmware split + serial protocol briefed to Claude
> Primus separately (`CLAUDE_PRIMUS_MINI_DISPLAY_SPLIT.md`).

#### The problem this solves

Effectively every hard reliability failure in the programme traces to
**one ESP32-S3 doing WiFi + BLE-scan + LVGL at once**: display tearing
(BLE scan starving LVGL / PSRAM bus contention, §9.3), resync stalls,
the C3-comms history rework, the TLS-warmup and deferred-heartbeat
workarounds. The hardware fix — a custom dual-ESP board — was quoted at
a price that's unreasonable to commit before the ecosystem is
revenue-validated.

**Decision:** instead of one expensive custom board, split the function
across single-responsibility units. Each radio job lives on exactly one
chip. This *is* the dual-ESP design, delivered as modular products
rather than one NRE-heavy PCB.

#### The three units

| SKU | Contains | Radios | Cloud? | Standalone? |
|---|---|---|---|---|
| **Origin Primus Display** | Screen, graph/UI smarts, BLE, cable port | BLE only (never WiFi) | No | Yes — live values + local short history |
| **Origin Primus Mini** | MCU, BLE + WiFi, cable port, small clip-in enclosure | BLE + WiFi | Yes | Yes — sensors → cloud → app, no screen |
| **Origin Primus Connect** | Display + Mini joined by the cable | (per part) | Yes | n/a — it *is* the pair |

`Origin Primus` is the **family name**, never a checkout SKU on its
own — every purchasable item carries a suffix (Display / Mini /
Connect) so a customer never has to disambiguate "Primus" vs "Primus
Connect". Consistent with the locked Origin family (Origin Pro/Lite,
Origin Monitor, Origin Primus).

There is **one Display hardware design**. It is simultaneously the
standalone "Display" SKU and the display half of "Connect". "Connect"
is a bundle/packaging decision (Mini clips into a 3D-printed enclosure
on the back of the Display; the Display ships with the cable captive
and ready) — **not a third board**. Its unit cost ≈ Display BOM + Mini
BOM + assembly/packaging of the pair.

#### The link: wired serial, in-enclosure

Display ↔ Mini communicate over a **wired UART** inside the enclosure.
Rationale: zero RF contention (the entire point of the split), trivial
and cheap, bulletproof over a short captive cable. The cable should
also carry power so a wall-mounted Connect presents a single cord
(industrial-design detail; doesn't affect firmware/cloud).

#### Mode-detection state machine (Display firmware)

The Display detects whether a Mini is present on the serial link and
runs in one of two modes. **The cable is the unlock** — there is no
licence, feature flag, or cloud check; capability is emergent from the
data source, so it degrades gracefully (unplug Mini → falls back to
live BLE, never bricks or nags):

- **No Mini → Standalone mode.** Display listens to sensor BLE
  advertisements directly. Shows live values + whatever short history
  it holds locally. No cloud, no calibration offsets, no
  config-to-cloud. Cloud-dependent features are shown **greyed-out with
  a lock badge** (see upgrade UX below).
- **Mini on cable → Connected mode.** Display **parks its own BLE** and
  takes the Mini's serial feed as the single source of truth:
  calibrated values, full cloud-backed history/graphs, alert state,
  and config changes that sync back through the Mini to the cloud.

> **The one invariant:** if a Mini is present, the Display uses the
> cable as its *only* data source and does not also read sensors over
> its own BLE. Never two readers at once — same reader-arbitration
> principle as the cloud-side circuit breaker (§12.7). Deterministic,
> no "two listeners, slightly different numbers" confusion.

#### Upgrade UX — locked-but-visible (deliberate upsell)

The Display deliberately shows cloud-dependent features **greyed-out
with a small lock** when no Mini is present. This is the primary
upgrade-conversion mechanic: the customer sees what they're missing
every time they look at the screen. Done well (and the architecture
makes "well" the easy path):

- **The locks are honest.** Only things that *genuinely require the
  Mini* are locked (cloud history, phone access, remote alerts,
  anywhere-monitoring). Nothing the screen could do alone is
  artificially crippled — that's the line between a respected upsell
  and a resented paywall, and it's free because it matches the
  hardware reality.
- **Basics are never locked.** Live readings, on-device alarms, basic
  local trend work fully standalone. The Display must feel complete on
  its own.
- **Show, don't nag.** Greyed control + one calm line ("Add a Primus
  Mini to unlock cloud history & phone alerts") + one discoverable
  "Unlock with Primus Mini" screen. No popups ambushing every tap.
- **The unlock is a payoff moment.** Clip in the Mini → Display
  detects it → greyed features light up with a brief "Connected —
  cloud history & alerts unlocked" confirmation. This kills buyer's
  remorse and drives word-of-mouth.
- **The empty clip-in bay** labelled "Add Primus Mini here" is a
  silent, zero-annoyance passive upsell.

#### Sourcing — Year 1 (Waveshare off-the-shelf) → Phase 2 (own/OEM at volume)

> **Decided 2026-05-18.** Year 1 is priced and built on Waveshare
> off-the-shelf boards (zero PCB/PCBA NRE, fastest to market, validates
> volume). Custom/OEM boards only once sales justify the NRE.

**Year 1 hardware targets** (each has a *prototype* board to build on
now + a *target* board when stock arrives; all board deltas behind a
thin board-config/HAL layer so the swap is a config change, not a
rewrite):

- **Mini** — target **Waveshare ESP32-S3-DEV-KIT-N16R8-U** (SKU 34549):
  16 MB flash, **8 MB PSRAM** (R8 deliberate — screenless Mini barely
  uses PSRAM; don't pay for 16 MB), **external antenna (`-U`)** (the
  one premium worth buying — it's the shed-mounted WiFi+BLE workhorse;
  better radio = fewer of the offline/backfill/resync failures).
  *Prototype on:* **LilyGo T-Display S3** (headless build doesn't need
  its screen) — but its onboard antenna ≠ target's external, so **no
  RF-range conclusions from the prototype**.
- **Display** — target **Waveshare ESP32-S3-LCD-5** (SKU 30321). Same
  Waveshare family as the current 4.3" board (same S3, RGB panel, GT911
  touch, toolchain), just larger → *incremental* port, low risk.
  *Prototype on:* the **current 4.3" Waveshare** board. **Order-time
  check: take the 800×480 variant, not 1024×600** — pixel count (not
  the board) drives the PSRAM-bus bandwidth behind the §9.3 tearing;
  also confirm the SKU 30321 variant includes touch.

Both modules at 8 MB PSRAM → one build target / one procurement line.

**Compliance is NOT waived by using Waveshare boards.** The
pre-certified WROOM-1 module reduces the *radio* test burden, but the
**finished product as sold** (in enclosure, with power + cable) still
requires **RCM** before legal sale in Australia. A dev board is not a
compliant end-product. RCM/EMC remains a real cost line and a hard
pre-launch gate in Year 1.

**Phase 2 (volume-triggered):** migrate to own/OEM boards — strip
unused Waveshare peripherals (CAN, RS485, RTC, wide-range regulator),
integrate enclosure mounting + chosen antenna, bare WROOM-1U on a
custom PCB (LCSC/JLCPCB module+PCBA in one house) **or** a Waveshare
OEM/ODM board. Phase 2 reuses the granular bare-module cost build-up;
Year 1 collapses the board into a single landed line (see worksheet).

#### Pricing basis + cost worksheet

**Confirmed pricing rule: retail price = unit cost × 1.60** (60% markup
on cost; ≈37.5% gross margin).

> **Live numbers live in the spreadsheet `Origin_Primus_Pricing.xlsx`
> (in `docs/`) — the single source of truth for the cost worksheet,
> volume tiers, and Pro pricing; Andrew enters quotes there.**
> `PRICING_AND_COST_MODEL.md` holds the same structure as
> reasoning/rationale for Claude sessions. This section keeps only the
> *why*; do not maintain a third worksheet here (divergence risk).

**Two cost factors that bite if missed:**

1. **Recurring cloud opex.** Only Mini/Connect touch the cloud
   (Supabase + droplet + Resend + domain) — *per active unit, forever*.
   A one-time ×1.60 markup does not fund perpetual hosting. **Decision
   required:** either a small subscription on the connected tier, or
   add "N years of cloud opex per unit" into the Mini/Connect *cost*
   line **before** applying ×1.60. This decision falls exactly on the
   Display↔Connect line and must be explicit, not buried. Display is
   clean (never connects).
2. **RCM/EMC compliance (Australia).** The **Mini has a WiFi radio** →
   likely needs RCM marking / EMC testing before sale. Real NRE that
   lands on Mini/Connect, not Display (BLE-only is typically lighter).
   Get a quote into the amortised-NRE line.

#### Dev-time / NRE-at-risk

The split **minimises NRE-at-risk** (the original driver):

- **Mini** reuses **100% of the already-built, hardened cloud stack** —
  heartbeat, readings, resync, settings sync, fine_status, circuit
  breaker are all screen-agnostic. Near-zero incremental cloud dev. The
  Mini is the lowest-risk, fastest-to-ship, highest-value unit (it
  alone unlocks the entire Origin Monitor app value). **Ship it first.**
- **Display** firmware is greenfield UI but has **no networking stack**
  — moderate, well-scoped, far simpler than today's tri-duty Primus.
- **Serial protocol** is small and self-contained.
- The riskiest, most expensive thing (dual-radio Primus / custom board)
  is now **avoided, not deferred**.

#### Cloud impact

**None.** The cloud only ever talks to the Mini, which presents
exactly as today's Primus does. The Display is invisible to the cloud.
(Optional future nicety: the Mini could report "display attached" as
support telemetry — not required.)

### 9.9 Mini self-serve provisioning

> Decided 2026-05-18: full self-serve, professional UX, no shortcuts.
> RGB status LED + enclosure light-pipe approved.

The screenless Mini replaces the 4.3" Primus's on-LCD WiFi/API-key
entry with a **unified claim-code model**. Two credentials: a factory
**bootstrap secret** = `HMAC(MASTER_KEY, mac)` (flashed to NVS +
printed in the unit QR; cloud verifies by recompute — no per-device
secret DB), and the **operational API key** minted on claim. WiFi is
decoupled and local (BLE for bare Mini, Display touchscreen→UART for
Connect); the device checks in via `POST /provision/checkin`
(bootstrap-auth), the user claims it from the logged-in App/portal via
`POST /app/primus/claim` (JWT-auth, scanning the unit QR or a
Display-shown pairing code), and the device pulls its key over TLS.
**No key on BLE; no human sees a key.** Full state machine, BLE/UART
contract, endpoints (`/provision/checkin`, `/app/primus/claim|:id|GET`)
and threat model: **canonical
[`PROVISIONING_CONTRACT.md`](./PROVISIONING_CONTRACT.md)**; slices in
`CLAUDE_PRIMUS_MINI_PROVISIONING.md` / `CLAUDE_APP_MINI_PROVISIONING.md`.

**Deliberately net-new cloud scope** (unlike the split): a
bootstrap-auth checkin endpoint + JWT claim endpoints + one
backward-compatible migration (`device_mac` / `claimed_via` /
`claim_state` / `claimed_at` / `unbound_at` on `primus_devices`;
existing admin rows keep `device_mac NULL`, `claimed_via='admin'`). A
new `MASTER_KEY` secret lives in cloud env + the flashing tool only.
Spec only — not yet implemented (standing hold).

---

## 10. App (Origin Monitor mobile app)

### 10.1 Tech stack

- **Framework:** Flutter
- **Platforms:** Android shipping; iOS scoped for later
- **BLE:** FlutterBluePlus
- **DB:** Supabase Dart SDK (Realtime + INSERT)
- **Local storage:** SharedPreferences for small things; SQLite for the offline buffer

### 10.2 Architecture overview

#### Service layout

The runtime is a set of long-lived singletons (most owned by
`AuthGate`'s lifecycle so they share the user-session boundary) plus
short-lived screen state.

| Service | File | Responsibility |
|---|---|---|
| `AuthGate` | `lib/screens/auth/auth_gate.dart` | Owns the user-session lifecycle; starts/stops every other service on auth state changes; drains the offline buffer on app resume. |
| `KBeaconService` | `lib/services/kbeacon_service.dart` | BLE central. Handles connect, MD5 auth, parameter R/W, history pull (forward + reverse paginated with `stopBefore` early-exit), set-time, sensor-clock read. |
| `LiveReadingsRecorder` | `lib/services/live_readings_recorder.dart` | Listens to `FlutterBluePlus.onScanResults`, parses KBeacon advertisements, writes a throttled (1/sensor/60s) sample to the offline buffer when `SensorUploadModeService.shouldUpload(mac)` returns true. Exposes `lastSeenAtSync(mac)` and `isWarmup` for live UI. |
| `SensorUploadModeService` | `lib/services/sensor_upload_mode_service.dart` | The two-gate decision in §10.4 — hatch-gated + failover-aware. Refreshes `sensors`, `primus_devices`, and active-hatch membership every 60s. Also exposes the Primus pool list to the Primus tab. |
| `SensorClockAnchor` | `lib/services/sensor_clock_anchor.dart` | Per-MAC delta of `sensor_clock - phone_clock` cached in SharedPreferences; warmed on app start. |
| `OfflineBufferService` | `lib/services/offline_buffer_service.dart` | SQLite buffer for `pending_readings`. Dedupes by `(sensor_serial, recorded_at)`. |
| `CloudSyncService` | `lib/services/cloud_sync_service.dart` | Drains `pending_readings` → `sensor_readings` (Supabase). Resolves cloud `sensor_id` lazily via `CloudSensorService.lookupSensorId`. |
| `CloudSensorService` | `lib/services/cloud_sensor_service.dart` | CRUD on the `sensors` table — `claimSensor`, `renameSensor`, `setIsAmbient`, `lookupSensorId`. |
| `CloudLiveDataService` | `lib/services/cloud_live_data_service.dart` | Tracks freshest `sensor_readings` row per sensor via Realtime + 60s safety-net pull. Drives the home-screen's 4-state `LiveIndicator`. |
| `SensorLiveBroadcastService` | `lib/services/sensor_live_broadcast_service.dart` | Subscribes to `sensor_live:{sensor_id}` broadcast channels, one per user-owned sensor; surfaces ephemeral readings for casual-mode sensors when the app is out of BLE range. |
| `SensorMetadataSyncService` | `lib/services/sensor_metadata_sync_service.dart` | Pulls cloud-authoritative `sensors.is_ambient` onto local `SavedSensor` rows every 60s; emits `revision` so the home screen rebuilds when the flag flips. |
| `SensorResyncService` | `lib/services/sensor_resync_service.dart` | Subscribes to `sensor_resync_requests` Realtime; atomically claims, pulls history, uploads, marks fulfilled. Honours all five reason codes uniformly. |
| `AlertService` | `lib/services/alert_service.dart` | Per-sensor threshold alarms; fires `flutter_local_notifications` and a streaming `AlertEvent` for in-app dialogs. |
| `FcmService` | `lib/services/fcm_service.dart` | Firebase Cloud Messaging token init + cloud sync (currently degraded — `profiles.fcm_token` column not in cloud schema yet). |
| `BackgroundMonitorService` | `lib/services/background_monitor_service.dart` | `flutter_foreground_task` integration so BLE scanning continues when the app is backgrounded. User opts in via Privacy & Support Access → "Run in background". |
| `SensorStorageService` | `lib/services/sensor_storage_service.dart` | SharedPreferences-backed store of `SavedSensor` (the user's paired sensors, keyed by MAC). |
| `HatchService` | `lib/services/hatch_service.dart` | CRUD on `hatch_logs`, `hatch_sensors`, `hatch_milestones`. |
| `CalibrationService` | `lib/services/calibration_service.dart` | Per-sensor temp/humidity offsets stored locally and applied to displayed readings. |
| `AdvertisementParser` | `lib/services/advertisement_parser.dart` | Decodes KBeacon and TLM service-data frames into temperature/humidity/battery. |

#### Lifecycle

```
main()
  ├── initSupabase()
  ├── SensorClockAnchor.warmCache()   // pre-fill per-MAC clock deltas
  ├── FcmService().init()             // permissions + handler
  └── runApp(MaterialApp → SplashScreen → AuthGate)

AuthGate (WidgetsBindingObserver)
  ├── _onSignedIn():
  │     ├── CloudSyncService.start()
  │     ├── LiveReadingsRecorder.start()
  │     ├── CloudLiveDataService.start()
  │     ├── SensorResyncService.start()
  │     ├── SensorUploadModeService.start()
  │     ├── SensorMetadataSyncService.start()
  │     ├── SensorLiveBroadcastService.start()
  │     └── _syncTimezone() + FcmService.resyncToken()
  ├── _onSignedOut():  stop() each of the above
  └── didChangeAppLifecycleState(resumed): CloudSyncService.drain()
```

#### BLE central role + scan strategy

- The app is a BLE central; sensors are peripherals. Most data flows
  from advertising-only — connections are reserved for actions that
  require GATT (pair-time auth, settings R/W, history pull, set-time,
  resync claims).
- Scanning is continuous while the app is foregrounded.
  `_scanRestartTimer` re-issues `FlutterBluePlus.startScan` every 4 s
  to defeat Android's duplicate-advertisement filter so the same
  sensor's recurring ads keep appearing in `onScanResults`.
- Permissions requested at first launch: `location`, `bluetoothScan`,
  `bluetoothConnect`, `notification`.
- During an active connection the scanner is paused; the active
  screen calls `LiveReadingsRecorder.markSensorActive(mac)` so the
  diagnostic "last seen" timestamp doesn't drift to "offline" while
  the radio is in use.
- Background BLE: see §10.6.

#### Local SQLite schema

`origin_monitor_buffer.db`, version 1, owned by `OfflineBufferService`:

```sql
CREATE TABLE pending_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sensor_serial   TEXT NOT NULL,    -- BLE MAC
  model           TEXT,
  temperature     REAL,
  humidity        REAL,
  battery_mv      INTEGER,
  recorded_at     TEXT NOT NULL,    -- ISO 8601 UTC, sensor-clock-derived
  captured_at     TEXT NOT NULL,    -- when app received it
  upload_attempts INTEGER DEFAULT 0,
  last_attempt_at TEXT
);
CREATE INDEX idx_pending_sensor_time
  ON pending_readings(sensor_serial, recorded_at);
```

INSERTs use `ConflictAlgorithm.ignore`, so repeated captures of the
same throttled sample are silently dropped — the offline buffer's own
dedup is the local mirror of the cloud's `(sensor_id, recorded_at)`
unique index.

Other persisted state lives in SharedPreferences (not SQLite):

- `savedSensors` — JSON list of `SavedSensor` (user's paired sensors)
- `live_recorder_last_seen_*`, `..._last_captured_*`, `..._last_rssi_*` per MAC
- per-MAC `sensor_clock_delta_ms_*` (anchored deltas)
- per-sensor calibration offsets
- alert preferences (`alertsEnabled`, `alarmSoundEnabled`, `vibrationEnabled`)

#### Realtime subscription registry

| Subscriber | Channel / table | Filter | Lifetime |
|---|---|---|---|
| `CloudLiveDataService` | `sensor_readings` (postgres_changes INSERT) | RLS-restricted to user | sign-in → sign-out |
| `SensorResyncService` | `sensor_resync_requests` (postgres_changes INSERT, UPDATE) | `user_id = auth.uid()` | sign-in → sign-out |
| `SensorLiveBroadcastService` | `sensor_live:{sensor_id}` (broadcast `event=reading`) | one channel per user-owned sensor | sign-in → sign-out; reconciled every 60 s as the sensor list changes |
| `HatchDetailScreen` | `hatch_milestones` (postgres_changes INSERT/UPDATE/DELETE) | `hatch_id` | screen mount → unmount |
| `HatchDetailScreen` | `hatch_logs` (postgres_changes UPDATE) | `id` | screen mount → unmount |

#### Screen / navigation tree

```
SplashScreen
  └── AuthGate
        ├── (signed out) LoginScreen
        └── (signed in)  MainShell
                         └── IndexedStack [
                               ├── EnhancedHomeScreen     (tab: Sensors)
                               │     ├── My Sensors tab → SensorDetailScreen
                               │     │                        └── DeviceSettingsScreen
                               │     │                              ├── AlertSettingsScreen
                               │     │                              ├── AdvancedSettingsScreen
                               │     │                              └── SensorLogScreen
                               │     ├── Add Sensor tab → _AddSensorSheet (modal)
                               │     └── overflow menu  → Alerts / Privacy / Help / About
                               ├── HatchesScreen          (tab: Hatches)
                               │     ├── + button       → NewHatchWizard (6-page)
                               │     └── card tap       → HatchDetailScreen
                               │                              (4 tabs: Overview / Daily Log / Milestones / Results)
                               │                                ├── _AmbientSensorPickerSheet (modal)
                               │                                └── milestone edit/delete sheets
                               └── PrimusScreen           (tab: Primus)
                             ]
```

`MainShell` keeps all three tab children mounted via `IndexedStack`
so BLE scanning, Realtime subscriptions, and live-readings recording
continue uninterrupted as the user switches tabs.

### 10.3 Sensor clock anchor (for sensor-stamped live readings)

Per the timestamp rule. App fetches sensor clock once per BLE connect,
stores `delta = sensor_clock_at_connect - phone_clock_at_connect` in
SharedPreferences keyed by MAC. Live readings stamped with
`phone_now + delta`. Re-anchored on every reconnect.

Implementation file: `lib/services/sensor_clock_anchor.dart`.

### 10.4 Upload mode service (failover-aware)

Implementation: `lib/services/sensor_upload_mode_service.dart`.

Decision tree for `shouldUpload(mac)`:

```
1. Is this sensor in an active hatch (via hatch_sensors OR ambient_sensor_id)?
   NO  → return false (casual-mode, no cloud writes)

2. Is the user's Primus healthy (any primus_devices row with last_seen < 2 min)?
   NO  → return true (take over — Primus dead or no Primus)

3. Path A override active (we previously detected take-over)?
   YES → check recovery: cloud last_seen advancing without our help → drop override, return false
       (otherwise return true — keep uploading)

4. BLE-fresh + cloud-stale > 2 min?
   YES → set Path A override, return true

5. Default: return false (Primus has it, stay silent)
```

### 10.5 Resync service

Implementation: `lib/services/sensor_resync_service.dart`.

Subscribes to `sensor_resync_requests` filtered by `user_id`. On
INSERT: checks BLE range, atomically claims (`UPDATE ... WHERE
claimed_at IS NULL`), pulls from sensor history (reverse-read with
`stopBefore` early-exit), uploads, marks fulfilled. Handles all five
reason codes uniformly.

Politeness guard: skip claiming if any active BLE session (Settings,
History download, etc.) is running — wait for the radio to free.

### 10.6 Background BLE limitations

iOS / Android will eventually pause background BLE when the app is
not foreground. Mitigations:

- Android: foreground service when actively scanning
- iOS: CoreBluetooth state preservation + restoration — **not
  implemented**. The app is Android-only today (`com.originmonitor.app`).
  The `ios/` Flutter scaffold exists from project creation but no
  iOS shipping work has started; tracked in §22 roadmap.

User messaging: "Best alarm guarantees come from a Primus base
station; app-only is best-effort based on phone availability."

---

## 11. Inter-component contracts

### 11.1 Reading shape (canonical)

```typescript
{
  sensor_id: uuid,
  temperature: number | null,   // °C
  humidity: number | null,      // %RH
  battery_mv: number | null,    // mV
  recorded_at: string           // ISO 8601, sensor-clock-derived
}
```

### 11.2 Primus → cloud (HTTP)

| Direction | Endpoint | Use |
|---|---|---|
| Primus → cloud | `POST /primus/heartbeat` | up to every 10 min (post-2026-05-01) |
| Primus → cloud | `POST /primus/readings` | up to every 10 min, batched |
| Primus → cloud | `GET /primus/sensors` | poll for name/model changes |
| Primus → cloud | `POST /primus/email-report` | user button press |
| Primus ← cloud | heartbeat response | commands queue (resync etc.) |

### 11.3 App → cloud (Supabase)

| Direction | Channel | Use |
|---|---|---|
| App → cloud | direct INSERT into `sensor_readings` (RLS) | upload readings (when `shouldUpload` true) |
| App → cloud | INSERT into `sensor_resync_requests` (RLS) | user "Sync now" button |
| App → cloud | UPDATE on `sensor_resync_requests` | claim + fulfil |
| App ← cloud | Realtime subscription on `sensor_readings` (filter by user) | live cross-device readings |
| App ← cloud | Realtime subscription on `sensor_resync_requests` (filter by user_id) | gap-fill instructions |
| App ← cloud | Realtime broadcast `sensor_live:{sensor_id}` | live readings for casual-mode sensors |

### 11.4 Cloud-internal contracts

- `primus_commands` linked to `sensor_resync_requests` via
  `params.resync_request_id` (single) or `params.resync_request_ids`
  (array) — when the command completes, all linked rows get marked
  together.
- `sensors.last_seen` is bumped by both the migration-014 trigger
  (on `sensor_readings` INSERT) AND explicitly by the API
  (`/primus/readings`) so live-only / casual-mode sensors also stay
  fresh.

---

## 12. Resync / gap-fill protocol

Detailed in [`ARCHITECTURE_SYNC.md`](ARCHITECTURE_SYNC.md). Quick reference here.

### 12.1 The unified queue

Table `sensor_resync_requests`. One row = "the cloud wants data from
a sensor for a given range." Either Primus or app can claim and
fulfil. Race resolved by atomic
`UPDATE ... SET claimed_at = now() WHERE claimed_at IS NULL`.

### 12.2 Reason codes

| Reason | When it fires |
|---|---|
| `auto_gap_detected` | Heartbeat handler saw sensor stale > 5 min |
| `gap_fill_retry` | Post-resync density check, OR retry of a failed fulfilment |
| `primus_offline` | pg_cron detected Primus stale > 5 min and a sensor in active hatch is also stale |
| `admin_manual` | Admin clicked Resync in `/admin/primus` |
| `app_user_pulled` | User tapped "Sync now" in the app |

### 12.3 Lifecycle of a request

```
INSERT → open
  ↓
UPDATE claimed_at (atomic, by claiming reader)
  ↓
[reader pulls from sensor, uploads]
  ↓
UPDATE fulfilled_at + fulfilled_count (success)
  OR
UPDATE fulfilled_at + fulfilled_error (failure)
  ↓
[on failure] retry with backoff (5 min transient / 15 min other), max 5 retries
  ↓
[on timeout] cancelled_at set if linked primus_command times out
  ↓
expires_at = 24h after creation — automatic abandonment
```

### 12.4 Insert dedup

Two layers prevent pile-up:

- Heartbeat handler's gap-detection paths skip sensors with an
  already-open request.
- Admin manual-resync supersedes (cancels) older auto-detected
  requests for the same sensor before inserting the manual one.

### 12.5 Opportunistic Primus backlog pickup

Added 2026-04-28 to close the architectural hole exposed when a Primus
outage queued `primus_offline` requests that the App couldn't claim
(BLE interrupted by phone calls, OS suspended, phone moved out of
range). Once the Primus came back online, no chain re-queued the work
for it — gap-detection only fires on currently-stale sensors.

**The fix:** on every Primus heartbeat, the handler scans for
`sensor_resync_requests` rows that are:

- `user_id = req.primus.userId`
- `claimed_at IS NULL`, `fulfilled_at IS NULL`, `cancelled_at IS NULL`
- `expires_at > now()`
- `requested_at < now() - 2 min` (gives the App a fair window to claim
  via Realtime first; only takes over if it didn't)
- The sensor is in an active hatch

If any are found and there isn't already an open `primus_commands`
resync in flight, the cloud claims them all atomically as
`primus:{deviceId}`, computes the union range (earliest start to
latest end), and queues a single `primus_commands` resync covering
all of them, with `params.reason = 'opportunistic_backlog'` and
`params.resync_request_ids` linking back to the rows so they all get
marked fulfilled together when the Primus completes.

This makes the Primus the safety net: as long as it's alive and
heartbeating, every queued request gets fulfilled within minutes
regardless of App reliability. The App is best-effort; the Primus is
the workhorse — *unless the circuit breaker trips* (§12.7).

### 12.6 fine_status — honest resync outcomes

Added 2026-05-17 alongside the Primus Priority-1 firmware fix
(`CLAUDE_PRIMUS_RESYNC_FIXES.md`). The heartbeat wire `status` stays a
binary `ok | error` (schema contract unchanged), but the Primus now
reports a richer `fine_status` *inside* the command result JSON. Old
firmware that doesn't send it falls back to the binary status (a bare
`error` maps to `skipped`, preserving the pre-fine_status behaviour
where any non-ok set `fulfilled_error`).

Cloud reaction per `fine_status`, applied to the linked
`sensor_resync_requests` rows:

| fine_status | `fulfilled_error` | `fulfilled_count` | Density check | Notes |
|---|---|---|---|---|
| `ok` | `null` | inserted ?? posted ?? uploaded | yes (72h closed loop) | success |
| `partial` | `primus_partial_drain` | stored count | no | retry sweep re-queues |
| `no_data` | `null` | `0` | no | empty sensor buffer — *not* a failure |
| `skipped` | `primus_skipped:{reason}` | stored count | no | retry sweep re-queues; also raises a `primus_events` warn for support visibility |

`fulfilled_count` prefers cloud-confirmed `readings_inserted`
(Priority 2), then `readings_posted`, then the legacy
`readings_uploaded` alias — the *actual stored* count, not the
*attempted* count.

### 12.7 Circuit breaker — adaptive Primus/App arbitration

Added 2026-05-17. The opportunistic pickup (§12.5) makes a *healthy*
Primus the workhorse — but a Primus with a firmware fault (BLE/PSRAM
contention, TLS warm-up failure, empty API key) can claim a sensor's
backlog every heartbeat, fail it, re-claim, and monopolise the sensor
so an able App never gets an uncontested Realtime window. Observed in
the field: 3 sensors stuck `IN_FLIGHT` claimed by a Primus for 22h
while the App sat idle, because the 2-min floor always elapsed before
the App's next foreground tick.

**The breaker** (`primusBreakerTrippedSensors` in `primus.ts`) watches
per-sensor Primus resync outcomes. A sensor's breaker trips when the
Primus has accrued ≥ `CIRCUIT_BREAKER_FAILURE_THRESHOLD` (3) failures
within `CIRCUIT_BREAKER_WINDOW_MS` (60 min) **since its last success on
that sensor**. While tripped, the opportunistic pickup floor for that
sensor stretches from 2 min to **30 min**
(`OPPORTUNISTIC_PICKUP_DELAY_TRIPPED_MS`), handing the App a long
uncontested window. A single successful Primus resync
(`fine_status` `ok` or `no_data`) on the sensor clears it.

The failure signal is exactly the §12.6 wiring: `sensor_resync_requests`
rows with `claimed_by LIKE 'primus:%'` and `fulfilled_error` set —
covering `primus_partial_drain`, `primus_skipped:*`,
`primus_reported_error` and `primus_command_timed_out`. Because
`no_data` deliberately sets *no* error, a genuinely-empty sensor
buffer never trips the breaker; only real faults do. The design is
symmetric in principle (an unreliable App could be throttled the same
way), but the App claims directly via Supabase with no API round-trip,
so only the Primus side is arbitrated here. Auto gap-detection
(separate path) keeps its own existing 30-min cooldown +
3-per-24h consecutive-failure cap as an independent safeguard.

---

## 13. Failover model

Detailed in `CLAUDE_APP_FAILOVER_MODEL.md` (App-session paste-relay)
and reflected in `ARCHITECTURE_SYNC.md`.

Two failover paths run concurrently; whichever fires first wins:

- **Path A — App-detected** (~2 min): app sees BLE-fresh ads but
  cloud `sensor.last_seen` hasn't advanced > 2 min → take over.
- **Path B — Cloud-signalled** (~5–7 min): pg_cron detects offline
  Primus + stale active-hatch sensor → INSERTs
  `sensor_resync_requests` with reason `'primus_offline'` → app's
  Realtime subscription picks it up.

Recovery: app drops to standby when `sensor.last_seen` advances from
a non-app source (Primus is back).

---

## 14. Hatch-gated recording vs live broadcast

**Rule: the cloud only persists readings for sensors linked to an
active hatch. Sensors not in any active hatch are casual-mode —
readings are rebroadcast live but not stored.**

### 14.1 Active-hatch determination

A sensor is "in an active hatch" if either:

- It has an `hatch_sensors` row whose hatch's `status = 'active'`, OR
- It is the `ambient_sensor_id` of a hatch whose `status = 'active'`

Implementation: `sensorsInActiveHatch(userId, sensorIds)` in
`api/src/routes/primus.ts`.

### 14.2 What changes per state

| State | App `shouldUpload()` | Primus `/primus/readings` cloud behaviour |
|---|---|---|
| Active hatch | Honours failover rules (returns false in standby; true on take-over / app-only) | UPSERT into `sensor_readings` (existing path) |
| No active hatch | **Always false** | Broadcast on `sensor_live:{sensor_id}` channel; no DB write |

In both states, `sensors.last_seen` is bumped so casual-mode sensors
aren't flagged offline by gap-detection.

### 14.3 Implications

- pg_cron's `detect_offline_primus_and_queue_app_failover()`
  (migration 017) only flags sensors in active hatches.
- Heartbeat handler's gap-detection only fires for sensors in active
  hatches.
- Web dashboard for casual-mode sensors shows "Live — not recording"
  with values streaming via the broadcast channel.
- Storage cost is bounded — no row growth for casual-mode sensors.

---

## 15. Alarms

Three categories, each with different triggers:

| Category | Trigger | Active when no hatch? | Where it fires |
|---|---|---|---|
| **Hatch alarms** | Reading outside species temp/humidity target during active hatch | No — requires active hatch + recorded reading | App push, web banner, Primus LCD; potentially email/SMS (future) |
| **System alarms** | Primus offline > 5 min, sensor low battery, BLE stack errors | Yes — these come from heartbeat events and `sensors.last_seen` independent of readings | Web banner, Primus events page, app notification |
| **User-set thresholds** | (Future) per-sensor "alert me if X" outside of any hatch context | Yes (when implemented) | TBD |

### 15.1 Species targets

`[TO BE COMPLETED — list current species options + temp/humidity ranges per phase]`

Defined in `api/src/lib/species-targets.ts`. Used by Primus dashboard
endpoint and (TBD) by alarm logic.

### 15.2 Notification channels

`[TO BE COMPLETED — current state of email/SMS/push]`

Email is via Resend API for transactional + Zoho SMTP for hatch
reports. Push notifications are TBD.

---

## 16. Authentication & authorisation

### 16.1 Primus auth

- One API key per Primus, generated at `/admin/primus` registration time
- Key shown once; SHA-256 hash stored in `primus_devices.api_key_hash`
- `Authorization: Bearer <key>` on every Primus → cloud request
- `requirePrimusAuth` middleware verifies and attaches `req.primus`

### 16.2 User auth (web + app)

- Supabase Auth (email + password; magic-link fallback)
- Email verification required before sign-in
- Profile row auto-created on first sign-in via Supabase trigger
- `is_admin` flag on `profiles` gates admin routes

### 16.3 Service role

- Used only by cloud API server for operations that bypass RLS
  (heartbeat handler updating any user's sensors, etc.)
- Stored in env file on droplet; never sent to client
- Credentials rotated by regenerating in Supabase dashboard

### 16.4 RLS in summary

User can read/write only rows where `user_id = auth.uid()`. Admin
(`is_admin() = true`) bypasses RLS via separate "admin all" policies.
Service role bypasses RLS entirely.

---

## 17. Hosting & infrastructure

### 17.1 DigitalOcean droplet

- **IP:** 170.64.219.199
- **Region:** Sydney
- **Spec:** (TBD — fill in droplet size)
- **OS:** Ubuntu LTS
- **Processes (PM2):** `origin-portal` (Next.js), `origin-api` (Express)
- **Reverse proxy:** Nginx (TBD config)
- **Paths:**
  - `/srv/origin-monitor/portal` — Next.js portal
  - `/srv/origin-monitor/api` — API server
  - PM2 logs in `~/.pm2/logs/`

### 17.2 DNS & TLS

- DNS via Cloudflare
- TLS termination at Nginx with Let's Encrypt certs (or via
  Cloudflare proxy — TBD which mode is current)

### 17.3 Supabase

- Project name: Origin Monitor (production)
- Region: (TBD)
- Plan: (TBD — need pg_cron which requires paid plan)

### 17.4 Email

- **Transactional (auth confirmations etc):** Resend API
- **Hatch reports + customer-facing:** Zoho SMTP via
  `andrew@uneekleds.com.au` (the SMTP auth user); from-aliases
  `info@originmonitor.com`, `hatch@originmonitor.com`

### 17.5 Backups

`[TO BE COMPLETED — Supabase auto-backup retention, manual export
cadence, droplet snapshots]`

---

## 18. Deployment processes

### 18.1 Git / GitHub (version control)

The cloud codebase (`origin-monitor`) lives on GitHub as a **private
repository**:

```
https://github.com/uneekpoultry/origin-monitor-cloud
```

The local working tree at
`C:\Users\Victus\Documents\ClaudeCode\origin-monitor` is connected to
this remote as `origin`. The Primus firmware and Origin Monitor app
each have their own GitHub repositories (see the Primus and App
session docs for those URLs).

#### Session workflow (every Claude Code session)

At the start of any work session in this repo:

```bash
git pull origin main
```

This ensures you're working against the latest tree — including any
changes pushed by the human operator (Andrew) or by other Claude
sessions that have access to the repo.

As you make meaningful changes, commit locally with descriptive
messages:

```bash
git add <files>
git commit -m "brief description of the change"
```

At stable checkpoints — anything you'd want a future session to be
able to roll back to or build on — push to GitHub:

```bash
git push origin main
```

Don't push half-finished work that breaks the type-check or fails to
build. The remote tree should always be deployable.

#### Secrets — never commit

The following file patterns are **gitignored** and must never be
committed:

```
.env
.env.local
.env.*.local
.env.development
.env.production
**/.env
**/.env.local
```

These contain Supabase service-role keys, API tokens, and other
credentials. A single accidental commit can leak the keys to the
entire git history — recovery requires rotating every secret in the
file. **Before every push, glance at the diff to be sure.**

#### `.env.example` IS in the repo

`api/.env.example` is tracked. It documents which environment
variables the API expects, with placeholder values. **Whenever you
add a new env var that the API server reads at runtime, update
`api/.env.example` in the same commit** so future sessions and
deployments know what config is required.

Same convention applies for any future workspace that picks up env
vars: ship a `*/.env.example` next to its `.gitignore` rule.

#### What's in the repo vs what's elsewhere

| In this repo | Not in this repo |
|---|---|
| Cloud API source (`api/`) | Primus firmware (separate repo) |
| Web portal source (`portal/`) | Origin Monitor app source (separate repo) |
| Supabase migrations (`supabase/migrations/`) | Database state (lives in Supabase) |
| Architecture + ops docs (`docs/`) | Compiled binaries / artefacts |
| `api/.env.example` | Actual `.env` files (gitignored, machine-local) |
| Shipping / handoff scripts (`api/scripts/`) | PM2 process state (lives on the droplet) |

If a thing is **derived** from something already in the repo (build
output, generated SDK, compiled binary), don't commit it — gitignore
it and rebuild on demand. If a thing is **source of truth** (a
config, a migration, a doc), it belongs in the repo.

#### Deployment vs version control

Pushing to GitHub does NOT deploy to the droplet automatically. The
deployment pipeline is described in §18.2 below (tar + scp + build +
PM2 reload). Git is for version control + auditability + cross-
session coordination. Deployment is a separate, deliberate step.

#### Commit message convention

Brief, imperative-mood, scope-prefixed where helpful:

- `cloud: add /primus/ping warmup endpoint`
- `migration 020: hatch_logs.lockdown_date`
- `docs: add Git/GitHub workflow section`
- `fix: type error in heartbeat handler`

One sentence per commit is enough. The diff carries the detail.

#### Branching policy

Solo-developer + AI-assistant scale doesn't yet need branches. **All
commits go to `main` directly.** When the team grows or the work
involves an experimental refactor, switch to feature branches +
pull requests. Until then, the linear-history pattern is simpler.

#### Rollback

If a push breaks something on the droplet, options are:

1. **Revert the offending commit:** `git revert <sha>`, push, redeploy.
2. **Reset main to the last known good:** `git reset --hard <sha>` +
   `git push --force origin main` — destructive, only do this if no
   other session has pulled.
3. **Roll back the droplet only:** Keep the bad commit in git but
   re-deploy from a previous tarball. Useful when the bug is in
   deploy-time config rather than source.

In practice (1) is overwhelmingly the right answer.

### 18.2 Cloud (portal + API)

Pattern: tar source → scp to droplet → build on droplet → PM2 reload.

`[TO BE COMPLETED — exact commands, branching policy, rollback]`

Quick reference (typical):

```bash
# from repo root
tar -czf /tmp/portal.tgz portal/
scp /tmp/portal.tgz user@170.64.219.199:/tmp/
ssh user@170.64.219.199 "
  cd /srv/origin-monitor &&
  tar -xzf /tmp/portal.tgz &&
  cd portal && npm ci && npm run build &&
  pm2 reload origin-portal
"
```

### 18.3 Database migrations

1. Author SQL in `supabase/migrations/NNN_description.sql`
2. Open Supabase Dashboard → SQL Editor
3. Paste the migration, run
4. Verify with the migration's "verify" query (each migration should
   include one)
5. Commit the file to the repo

Migrations are append-only — never edit a migration that's been run
in production. Make a follow-up migration instead.

### 18.4 Primus firmware

#### Build

```bash
# From project root: C:\Users\Victus\Documents\Arduino\origin_basestation
"C:/Users/Victus/.platformio/penv/Scripts/pio.exe" run
```

Bash works fine for compile-only. **First-ever build on a new machine** must run from PowerShell or `cmd` once — `idf_tools.py` (Espressif's tool installer that pioarduino delegates to) refuses to install under MSys/Mingw with `ERROR: MSys/Mingw is not supported`. After the first successful install, bash works for subsequent builds.

#### Flash (upload)

```powershell
# PowerShell only — bash crashes on UTF-8 progress bars
& "C:/Users/Victus/.platformio/penv/Scripts/pio.exe" run -t upload --upload-port COM9
```

Approximately 12 seconds at 921 600 baud. Auto-resets via DTR/RTS when complete.

**Why PowerShell is required for upload (not bash):** `esptool.py` prints UTF-8 box-drawing progress bars (`█`). When piped through bash on Windows the stream encoding falls back to Windows-1252 and PIO's stdout reader thread crashes with `UnicodeEncodeError`. The crash kills the reader thread but the underlying esptool subprocess often keeps going, leaving `firmware.bin` locked. PowerShell handles UTF-8 cleanly. Compile works fine in bash because no progress bars are involved.

#### Monitor (serial)

```powershell
& "C:/Users/Victus/.platformio/penv/Scripts/pio.exe" device monitor --port COM9 --baud 115200 --filter time --filter log2file
```

Logs land in `logs/device-monitor-YYMMDD-HHMMSS.log`. The `log2file` filter is what makes overnight soak tests possible.

#### Platform pinning

`platformio.ini` (top of project):

```ini
platform = https://github.com/pioarduino/platform-espressif32/releases/download/54.03.21-2/platform-espressif32.zip
board = 4d_systems_esp32s3_gen4_r8n16
framework = arduino
board_build.flash_mode = dio
board_build.arduino.memory_type = qio_opi
```

Pin to **pioarduino**, NOT the upstream `platformio/platform-espressif32` — the upstream lags Arduino-ESP32 by months. Pioarduino is the community fork that tracks Arduino-ESP32 closely.

`board_build.flash_mode = dio` is **mandatory** on the R8N16 chip. Its OPI PSRAM shares pins with QIO flash, and the bootloader/app must agree on flash mode or boot fails immediately with `invalid segment length 0xffffffff`. The board-file default still says QIO from the Arduino 2.x era; this override forces DIO everywhere.

#### Partition layout

Default Arduino partitions on 16 MB flash (`default.csv`):

| Partition | Size | Purpose |
|---|---|---|
| `nvs` | 20 KB | Sensor metadata, WiFi creds, calibration, alert thresholds, timezone, API key, `last_cloud_ok_epoch` |
| `otadata` | 8 KB | OTA slot metadata (unused — no OTA today) |
| `app0` | ~3 MB | Current firmware |
| `app1` | ~3 MB | OTA slot (reserved, unused) |
| `spiffs` | ~3.4 MB | BLE history files `/hist_0.bin` … `/hist_3.bin` per sensor slot |

Current firmware uses ~66 % of the 3 MB app slot.

#### First-time flash on a new device

1. Connect USB-C cable. Device enumerates as **COM9** on this hardware (auto-detected by esptool).
2. (Optional, if device has stale partitions from prior firmware): `pio run -t erase --upload-port COM9`.
3. `pio run -t upload --upload-port COM9` from **PowerShell**.
4. First boot runs with empty NVS. User must:
   - Settings → WiFi → enter SSID + password.
   - Settings → Send to Cloud → enter API key (issued by `/admin/primus` on the web portal).
   - Tap "Send to Sensor" on each new sensor row to authenticate + push initial config (TimeSync auto-runs on first BLE connect).

#### OTA: not implemented

All firmware updates today are USB-cable flashes. The `app1` OTA slot exists but is unused. OTA infrastructure is on the section 22 roadmap. Planned approach when implemented: standard Arduino `Update` library + a versioned binary served from the cloud (e.g. `/primus/firmware/<version>.bin`) gated on a heartbeat-side `update_available` flag.

#### Versioning

- `FIRMWARE_VERSION` macro in `main.cpp` — currently `"1.0.0"`.
- Sent on every heartbeat in the `firmware_version` field (cloud writes this to `primus_devices.firmware_version`).
- Displayed on the About screen + Settings → Device Info.
- Bump policy: TBD by Andrew. Suggested: bump on every shipped build; semver for user-visible changes; git tag convention `firmware-vX.Y.Z`.

#### Custom font generation

Custom 72-pt fonts (Bebas Shadow, DSEG7, Roboto Cond, Montserrat) are generated with:

```bash
PATH="/tmp/fonts/node-v20.11.1-win-x64:$PATH"
/tmp/fonts/node_modules/.bin/lv_font_conv \
  --no-compress --no-prefilter \
  --bpp 4 --size 72 \
  --font Bebas-Bold.ttf --range 0x20,0x25,0x2D-0x2E,0x30-0x39,0xB0 \
  --format lvgl --output lv_font_bebas_72.c --lv-include "lvgl.h"
```

**Critical flags:** `--no-compress --no-prefilter`. `lv_conf.h` has `LV_USE_FONT_COMPRESSED 0`. Without these flags, fonts render as blank/invisible text with no error message at all.

Glyph range covers digits + space + `%` + `-` + `.` + `°` (the only chars used in numeric value displays). Multi-font merge (e.g. DSEG7 + Montserrat) is needed when one font lacks `°` or `%`.

#### custom_sdkconfig

`platformio.ini` does NOT use `custom_sdkconfig` today. Earlier attempts to bump `CONFIG_ESP_INT_WDT_TIMEOUT_MS` via that mechanism were unstable on this board variant — pioarduino's prebuilt esp32s3 libs include patches that don't reproduce when `custom_sdkconfig` triggers a from-source IDF rebuild (the rebuild silently replaces the prebuilt libs with stripped-down custom ones, breaking the Arduino link). The IWDT timeout is now extended via the runtime tick-hook pattern instead (see section 9.3).

#### Build environment

- Windows 11 Pro (10.0.26200)
- pioarduino at `C:/Users/Victus/.platformio/`
- Build / monitor: PowerShell, bash (Git Bash) for compile only
- Flash time on this hardware: ~12 s at 921 600 baud over USB-C
- No CI today. All builds run locally on a single development machine.

### 18.5 App build

#### Build commands

```bash
# Debug — local development; assertions enabled, slow
flutter build apk --debug

# Profile — perf-tuned with some debug info; rarely needed
flutter build apk --profile

# Release APK — sideload distribution
flutter build apk --release

# Release App Bundle — required for Play Store upload
flutter build appbundle --release

# Install in-place without wiping app data. flutter install always
# uninstalls first regardless of mode, so use adb directly:
adb install -r build/app/outputs/flutter-apk/app-release.apk
```

The current Andrew-dev cycle ships **release APK only**, sideloaded
to a Samsung SM-G980F over USB. AAB is built only when uploading to
Play Console (currently manual — see Play Console flow below).

#### Versioning

Source of truth: `pubspec.yaml` line `version: 1.0.0+1`. Format is
`<semver>+<buildNumber>`; Flutter's gradle plugin maps these to
Android's `versionName` and `versionCode` automatically.

`android/app/build.gradle.kts` currently hard-codes `versionCode = 1`
and `versionName = "1.0"` — these should be removed so the gradle
plugin reads from pubspec (TBD — Andrew to confirm before first Play
release).

Bump policy: TBD. Suggested: bump `versionCode` (build number) on
every shipped build and `versionName` per semver on user-visible
changes. Git tagging convention: TBD.

#### Signing

| | Status |
|---|---|
| Debug keystore | Default `~/.android/debug.keystore` (auto-generated by Android SDK) |
| Release keystore | **Not configured.** `release` build type currently signs with the debug keystore (`build.gradle.kts` line 33: `signingConfig = signingConfigs.getByName("debug")`) |
| `key.properties` | Not present |
| Backup procedure | **Not yet established. Critical:** losing the upload keystore = locked out of Play Store updates forever. Plan must include offline backup (1Password / encrypted USB / printout of base64-encoded keystore in a fire-safe). |
| Access | Single-developer (Andrew) |

Before first Play release, must:
1. `keytool -genkey -v -keystore origin-monitor-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload`
2. Create `android/key.properties` (gitignored) with `storeFile`, `storePassword`, `keyAlias`, `keyPassword`
3. Replace `signingConfig = signingConfigs.getByName("debug")` with a real `signingConfigs.create("release") { ... }` block reading from `key.properties`
4. Enable Play App Signing on Play Console so Google manages the distribution key (recommended — keeps the upload key as the only thing Andrew has to back up)
5. Back up the keystore + passwords to two independent offline locations

#### Play Console flow

Not yet set up. TBD — Andrew to confirm:
- Whether a Play Console developer account exists for the
  `com.originmonitor.app` package
- Track strategy (suggested: Internal → Closed (beta) → Production)
- Upload mechanism (manual AAB drag-drop initially; `fastlane supply`
  or `gh action upload` once cadence justifies automation)
- Release-notes review (suggested: Andrew drafts in Play Console; no
  reviewer required at single-developer scale)

#### CI / build environment

No CI today. All builds run locally on Andrew's Windows machine:

- **OS:** Windows 10 Pro (10.0.19045)
- **Flutter:** 3.32.8 stable (channel `stable`, engine `ef0cd00091`)
- **Dart SDK constraint** in `pubspec.yaml`: `^3.8.0`
- **Android toolchain:** Android SDK at `C:/Users/OEM/AppData/Local/Android/sdk`, NDK 27.0.12077973, compileSdk/targetSdk 35, minSdk 21
- **Build host:** the same machine running Claude Code; APKs land at `build/app/outputs/flutter-apk/app-release.apk`

If/when CI is added, GitHub Actions on `ubuntu-latest` with the
`subosito/flutter-action` is the lowest-friction path; pin the Flutter
version explicitly to match local.

#### iOS

Not started. The `ios/` Flutter scaffold exists from project creation
but no Xcode work, no signing certs, no App Store Connect account, no
CoreBluetooth state-preservation code (see §10.6). Tracked in §22
roadmap.

#### Common gotchas

- **`flutter install` always uninstalls first** regardless of build
  mode. This wipes login + saved sensors on every iteration. Always
  use `adb install -r <apk>` for in-place upgrades during dev.
- **Switching debug ↔ release wipes app data** because the signing
  keys differ. Stay on the same mode between iterations.
- **Debug-only assertions can crash a debug build** (e.g. the
  `_dependents.isEmpty` framework assertion that fired on the home
  screen's `ReorderableListView` interactions). Release builds skip
  these. If something crashes only in debug, try release before
  spending hours on a framework bug hunt.
- **`SwitchListTile.adaptive(activeThumbColor: ...)`** is M3-only
  (newer Flutter). Use `activeColor` if targeting Flutter < 3.x — we
  hit this on 3.32.8 building debug.
- **`x86` Android target is deprecated** after Flutter 3.27 (build
  output warning). Not a problem today (no x86 devices in the test
  fleet) but will eventually need to be removed from
  `android/app/build.gradle.kts` ABIs.
- **Dart source files use unicode escapes for `°`** (`'°C'`)
  rather than the literal character. Editor tools that auto-normalise
  unicode can break diff matching — keep the escape form when editing.

---

## 19. Migration history

| # | File | Title / change |
|---|---|---|
| 001 | `001_rename_products.sql` | Initial product naming alignment |
| 002 | `002_primus_devices.sql` | Primus device table + API key hash |
| 003 | `003_sensor_claims.sql` | Sensors claim/pending lifecycle |
| 004 | `004_app_readings_insert.sql` | App-direct INSERT RLS policy on `sensor_readings` |
| 005 | `005_sensors_realtime.sql` | Add `sensor_readings` to Realtime publication |
| 006 | `006_hatch_sensors_junction.sql` | Many-to-many hatch ↔ sensor link |
| 007 | `007_profile_timezone.sql` | Profile timezone column |
| 008 | `008_hatch_results.sql` | Hatch outcome data |
| 009 | `009_hatch_metadata_and_milestones.sql` | Hatch metadata + milestones |
| 010 | `010_sensor_readings_dedup.sql` | **Foundation:** unique index `(sensor_id, recorded_at)` |
| 011 | `011_primus_events.sql` | Primus events ring buffer |
| 012 | `012_primus_commands.sql` | Primus commands queue |
| 013 | `013_ambient_sensors.sql` | `is_ambient` on sensors + `ambient_sensor_id` on hatches |
| 014 | `014_sensor_last_seen_trigger.sql` | Auto-bump `sensors.last_seen` on every reading INSERT |
| 015 | `015_sensor_resync_requests.sql` | Unified gap-fill queue + Realtime |
| 016 | `016_sensor_resync_retry_and_failover.sql` | Retry tracking + Primus-offline detector + pg_cron |
| 017 | `017_hatch_gated_offline_detector.sql` | Restrict offline detector to active-hatch sensors |

---

## 20. Reference tables

### 20.1 Realtime channels

| Channel / table | Type | Filter | Subscribers |
|---|---|---|---|
| `sensor_readings` | postgres_changes (INSERT) | `user_id = auth.uid()` (via RLS) | App + web portal |
| `sensor_resync_requests` | postgres_changes (INSERT, UPDATE) | `user_id = auth.uid()` | App |
| `sensor_live:{sensor_id}` | broadcast | (per-channel) | App + web portal (when remote viewing casual sensor) |

### 20.2 HTTP endpoints (cloud API)

See section 6.2.

### 20.3 Reason codes (sensor_resync_requests)

See section 12.2.

### 20.4 Command types (primus_commands)

| Type | Params | Notes |
|---|---|---|
| `resync` | `since`, `auto`, `reason`, `gap_sensor_id`, `gappy_sensor_ids`, `window_hours`, `resync_request_id`, `resync_request_ids` | Today's only command type |
| `restart` | (future) | TBD |
| `ota_update` | (future) | TBD |

### 20.5 Hatch statuses

`[TO BE CONFIRMED — likely: 'active', 'completed', 'archived']`

---

## 21. Glossary

| Term | Meaning |
|---|---|
| **Active hatch** | A `hatch_logs` row with `status = 'active'`. Drives recording vs. broadcast decisions. |
| **Ambient sensor** | A sensor representing room/ambient air, not the inside of an incubator. Marked via `sensors.is_ambient` or `hatch_logs.ambient_sensor_id`. |
| **Casual mode** | A sensor not linked to any active hatch. Live readings broadcast but not recorded. |
| **Claim (a request)** | Atomic UPDATE on `sensor_resync_requests` setting `claimed_at + claimed_by` — first reader to do this wins. |
| **Dedup index** | `unique (sensor_id, recorded_at)` on `sensor_readings`, migration 010. The foundation that makes idempotent re-uploads safe. |
| **Failover** | App takes over from a silent Primus. Two paths: A (BLE-direct, ~2min), B (cloud-signalled via `primus_offline`, ~5-7min). |
| **Heartbeat** | Primus → cloud `POST /primus/heartbeat` up to every 10 min (was 60s before 2026-05-01). Carries events, returns commands. Less-frequent cadence is the BLE-tearing mitigation. |
| **KBeacon** | Third-party BLE protocol the sensors implement. Both Primus and app read this. |
| **Live-only** | Reading broadcast on a Realtime channel without persistence, because the sensor is in casual mode. |
| **Primus** | Origin Primus basestation. ESP32-S3, BLE central, always-on professional gateway. |
| **Reader** | Anything that reads from a sensor and uploads to the cloud. Today: Primus and App. |
| **RLS** | Row-Level Security. Postgres-side policy that gates per-user access. |
| **Resync** | Pulling historical readings from a sensor's on-board flash to fill a cloud-side gap. |
| **Sensor clock** | The sensor's own time, used to stamp `recorded_at`. |
| **Service role** | Supabase secret key that bypasses RLS; used only by the cloud API server. |
| **Standby** | App is in BLE range and the user has a healthy Primus → app stays silent on cloud writes. |

---

## 22. Future roadmap

- **User-configured threshold alarms** outside of an active hatch
  context
- **Multi-Primus per-sensor coverage** — track which Primus actually
  uploads each sensor's readings; refine offline detector to be
  per-Primus instead of per-user
- **Primus management tab in the app** — once multi-Primus tracking
  exists
- **Sensor commands** (reset_defaults, set_intervals, factory_reset,
  sync_time) unified into a `sensor_commands` table mirroring the
  resync_requests pattern
- **Pro tier** (paid) with hatch outcome analytics, trend reports,
  longer retention
- **Origin Scale + Origin Pulse integrations** — egg weighing and
  ultrasonic candling tied into hatch records
- **iOS app** — CoreBluetooth state preservation work
- **OTA firmware updates** for Primus

---

## Document maintenance

This file is the master. When making system-level changes:

1. Update this document first (the design)
2. Update the relevant addendum (`PRIMUS_ADDENDUM_*.md`,
   `APP_ADDENDUM_*.md`) with the deep-technical detail
3. Implement the code change
4. Add a row to section 19 if a migration was involved

Keep section 22 honest — when something on the roadmap ships, move it
into the relevant section and remove it from the roadmap.

— Document originated by Claude (Cloud session), 2026-04-27
— TBD sections to be filled in by Claude Primus and Claude App sessions
