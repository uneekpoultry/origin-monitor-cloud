# Primus addendum — gap-fill resync after cloud outage

> **Read `docs/ARCHITECTURE_SYNC.md` first** for the universal sync
> pattern that applies to every reader. This document is the Primus-
> specific implementation of that pattern. Paste this into the Primus
> Claude Code session. The sensor firmware session needs to read this
> too — there's a BLE contract at the bottom.

## The problem

Primus loses cloud connectivity (WiFi dropout, DNS, DO network blip, etc).
Sensors keep reading and **buffer their data on-board**. When Primus
reconnects, the cloud has a gap in its history — today's outage was 7 hours,
which is unacceptable for a monitoring product people are trusting with
multi-week incubations.

## The solution — one-way overshoot

On cloud reconnect, Primus asks each linked sensor for everything since the
**last successful cloud post** (or last 24h, whichever is longer, floored at
the sensor's buffer depth — sensors hold ~1 month) and POSTs the whole
window to the normal `/primus/readings` endpoint. The cloud dedups —
existing rows are silently skipped via a unique index on
`(sensor_id, recorded_at)`.

**Primus never has to ask the cloud "what are you missing?"** — the cloud
just accepts everything and throws away duplicates. Tiny firmware logic,
no new endpoints.

## Trigger conditions

Run the resync when **any** of these happen:

1. **Cloud reconnect after a failed POST.** If the last `/primus/readings`
   or `/primus/heartbeat` returned a network error / 5xx and the next one
   succeeds → resync immediately.
2. **Cold boot.** On startup, always pull last 24h once the WiFi + cloud
   come up.
3. **User taps "Resync now"** on the Primus WiFi Settings screen (you're
   already adding last-cloud-connection status there — add this button
   next to it). Belt-and-braces for when things get weird.

## Protocol

For each linked sensor:

1. BLE connect to sensor (if not already connected).
2. Write to the **readings-range characteristic** (see BLE contract below)
   with `since = now - 24h`.
3. Sensor streams back N readings, each with its on-device `recorded_at`
   timestamp.
4. Primus accumulates into batches of up to **100 readings** (cloud's
   `readings` schema caps at 100 per POST).
5. POST each batch to `/primus/readings` with the sensor's original
   timestamps — **do not substitute `now()`**. The dedup only works if the
   same reading always has the same `recorded_at`.

## Cloud response

```json
{
  "ok": true,
  "accepted": 84,      // rows we tried to insert
  "inserted": 47,      // actually new rows
  "duplicates": 37,    // silently skipped (already present)
  "pending_created": 0,
  "skipped": []
}
```

**Do not show anything on the LCD.** The resync is invisible to the user —
it just happens. Instead, write one `info`-severity entry to the
**cloud-events ring buffer** (the same one you're forwarding via
`/primus/heartbeat` → `events`) with a message like:

```
"resync: inserted=47 duplicates=37 sensors=2 window=7h12m"
```

That gives support + admin everything they need to see that a gap-fill
happened without ever bothering the user.

## Important — also applies to live path

For dedup to work across live + buffered paths, **the Primus must always
send `recorded_at` with the sensor's real timestamp**, even for live
readings. Don't let the cloud fall back to `now()` — that would create two
versions of the same reading (one with sensor-time, one with cloud-time)
and dedup would miss.

If the sensor doesn't stamp its own time (some cheap BLE weather stations
don't), capture the time on Primus **at the moment of the BLE
notification**, not at the moment of HTTPS post.

## What NOT to do

- Don't query the cloud for a gap list first. Overshoot and let the cloud
  dedup — simpler, no round trip.
- Don't skip the resync just because `/primus/heartbeat` worked. A working
  heartbeat doesn't mean `/primus/readings` caught up. Resync on any
  reconnect-after-failure.
- Don't retry the same batch on 429 or network error without backoff —
  sleep, try again; if still failing, stop (user will retry via the manual
  button).
- Don't fail the resync silently. If BLE can't reach a sensor, log it; if
  the cloud keeps rejecting batches, surface "Resync failed" on the LCD
  with the reason.
- Don't use `now()` for `recorded_at` in either live or backfill paths.

---

## BLE contract (sensor firmware session — please implement)

The sensor needs one new characteristic on its existing GATT service:

**Characteristic: readings-range** (uuid TBD — pick one)
- **Write** (from Primus): 8 bytes, little-endian unix epoch seconds
  (`since_ts`). Sensor responds by streaming every on-board reading with
  `recorded_at >= since_ts`.
- **Notify** (from sensor): each notification is one reading packet:
  - `recorded_at` — 8 bytes, unix epoch seconds
  - `temperature` — 2 bytes, int16 × 100 (37.52°C → 3752)
  - `humidity` — 2 bytes, uint16 × 10 (45.3% → 453), or 0xFFFF if N/A
  - `battery_mv` — 2 bytes, uint16 (0xFFFF if N/A)
- **End-of-stream marker**: one notification with all fields set to 0xFF
  (or a separate "done" characteristic). Primus uses this to stop waiting.

### Sensor buffer sizing

Confirmed with Andrew: **sensors hold at least 1 month of on-board history.**
That means any realistic cloud outage (a few hours, a weekend, a week-long
ISP problem) is fully recoverable from the sensor itself — no need for the
Primus to keep a second buffer layer.

Practical implication: the "last 24h" default on reconnect is a safety
floor, not a hard ceiling. If the last successful cloud POST timestamp is
known and older than 24h ago, Primus should pull from **that timestamp**
instead, up to the sensor's full buffer. For example, if Primus has been
offline for 3 days, ask the sensor for `since = last_successful_post - 10min`
(the 10min overlap guarantees no edge-of-window loss; the cloud dedup makes
the overlap free).

## Schema reference

Cloud-side contract (for the firmware session's reference — no changes
needed on cloud, this is what's already live):

```http
POST /primus/readings
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "readings": [
    {
      "serial_number": "OP-240305-0042",
      "model": "pro",
      "recorded_at": "2026-04-22T01:37:00Z",
      "temperature": 37.52,
      "humidity": 45.3,
      "battery_mv": 3124
    },
    ...up to 100 per batch
  ]
}
```

`recorded_at` is optional per the schema, but **send it always** now.
