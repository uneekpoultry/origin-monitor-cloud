# Primus addendum — event log ingestion

> **Read `docs/ARCHITECTURE_SYNC.md` first** for the universal sync
> pattern. Response to `PRIMUS_RECENT_ERRORS_PROPOSAL.md` from the
> basestation repo. Cloud is now ready to accept events. Paste this
> into the Primus Claude Code session so they can finalise the
> heartbeat emit.

## Cloud status

- **Table**: `primus_events` — created in migration 011, live after deploy.
- **Dedup**: unique on `(primus_id, observed_at, source, message)`. Safe to
  retransmit the same entries across heartbeats — duplicates silently drop.
- **Retention**: last 500 per device, trimmed automatically by the cloud
  after each heartbeat with events.
- **Endpoint**: no new route. Events ride on the existing
  `POST /primus/heartbeat`.

## Heartbeat payload — the new field

Add `events` to the existing heartbeat body:

```json
{
  "firmware_version": "0.8.1",
  "wifi_ssid": "UneekHQ",
  "timezone": "Australia/Sydney",
  "events": [
    {
      "observed_at": "2026-04-22T02:07:33Z",
      "severity": "warn",
      "source": "ble",
      "message": "sensor OP-240305-0042 disconnected (rssi=-89)"
    },
    {
      "observed_at": "2026-04-22T02:14:01Z",
      "severity": "error",
      "source": "cloud",
      "message": "POST /primus/readings timeout after 10s"
    },
    {
      "observed_at": "2026-04-22T09:57:12Z",
      "severity": "info",
      "source": "resync",
      "message": "resync: inserted=47 duplicates=37 sensors=2 window=7h12m"
    }
  ]
}
```

### Field rules

| field         | type                       | required | limit                     |
| ------------- | -------------------------- | -------- | ------------------------- |
| `observed_at` | ISO 8601 UTC string        | yes      | Must parse as datetime    |
| `severity`    | `"info" \| "warn" \| "error"` | yes      | Exact match               |
| `source`      | short string               | yes      | 1–40 chars, trimmed       |
| `message`     | string                     | yes      | 1–500 chars, trimmed      |

The whole `events` array is capped at **50 entries per heartbeat**. If the
ring buffer has more than 50 unacked, send the 50 oldest first (FIFO) —
the next heartbeat picks up the rest. Back-compat: omitting `events`
entirely is valid; existing heartbeats with no field keep working.

## Ack contract — so you know what to purge

The cloud response now echoes which entries were safely stored:

```json
{
  "ok": true,
  "events_acked": [
    { "observed_at": "2026-04-22T02:07:33Z", "source": "ble",    "message": "sensor OP-240305-0042 disconnected (rssi=-89)" },
    { "observed_at": "2026-04-22T02:14:01Z", "source": "cloud",  "message": "POST /primus/readings timeout after 10s" },
    { "observed_at": "2026-04-22T09:57:12Z", "source": "resync", "message": "resync: inserted=47 duplicates=37 sensors=2 window=7h12m" }
  ]
}
```

Rules for the firmware:
1. **Purge only acked entries** from the ring buffer. Matching key is the
   full triple `(observed_at, source, message)`.
2. **Acks are idempotent.** A row shows up in `events_acked` whether it
   was newly inserted *or* deduped against an existing row — both mean
   "cloud has it, you can forget it".
3. **If the heartbeat HTTP response fails** (timeout, 5xx, non-200), don't
   purge anything. Next heartbeat will retransmit.
4. **If an individual event is malformed** (cloud returns 400 for the
   whole heartbeat), the whole batch bounces. Fix client-side validation
   before the batch leaves the firmware — don't let bad rows block good
   ones.

## Severity guidance

Pick the one that matches what the user (if they saw it) would think:

| Severity | When to use                                                  | Examples                                                     |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `info`   | Normal lifecycle events worth keeping for audit              | `resync: inserted=47...`, `WiFi reconnected`, `firmware boot v0.8.1` |
| `warn`   | Degraded but recoverable — "something was off, we handled it" | `sensor X disconnected`, `cloud POST retried 3x`, `BLE scan empty` |
| `error`  | Action needed — user or support should know                  | `sensor X unreachable >1h`, `cloud POST 4xx (auth?)`, `NVS corrupt` |

Do **not** spam `error` for transient blips. One `error` after N failed
retries is fine; one per retry is noise.

## Source naming

Free text, but stick to short lowercase identifiers. Suggested set:

- `ble` — sensor pairing, discovery, disconnects, signal
- `cloud` — HTTP, auth, retry, rate-limit
- `sensor:<serial>` — per-sensor events (readings out of bounds, calibration drift)
- `wifi` — reconnects, SSID changes
- `resync` — gap-fill upload results
- `boot` — firmware startup, OTA install
- `system` — memory, flash, watchdog

The admin UI auto-populates the source filter from what's actually been
logged, so you can add new sources without any cloud changes.

## Admin UI — what support sees

Every Primus device now has an **Events** link in the admin panel
(`/admin/primus` → per-device row → "Events"). Support can:

- Scan the 500 most recent entries per device
- Filter by severity (info/warn/error)
- Filter by source
- Free-text search the message

No customer ever sees this table via the portal — it's admin-only by RLS.
LCD remains the customer-visible surface.

## What the user sees

**Nothing.** Per Andrew's direction, the gap-fill resync and the event log
are both invisible to the user. The LCD should not pop toasts for recoveries
or forward events to the user's view — these are telemetry for support,
not user notifications. If we decide later to surface a subset to the
Origin Monitor app, we'll add a second policy to the table; for now,
everything here is admin-only.
