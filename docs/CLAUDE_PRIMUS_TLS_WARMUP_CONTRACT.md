# Primus — TLS warm-up + minimal first-heartbeat response (contract)

> Cloud-side bits 1 and 2 from the display-tearing investigation are
> built. This doc is the firmware-side contract: what the Primus needs
> to do to take advantage of them. Both are small additive changes,
> independently shippable.

## Why

`DISPLAY_TEARING_INVESTIGATION.md` Section 5: residual artifact happens
at first cloud-state-change moment, when mbedtls peak handshake +
cJSON parse + LVGL invalidation collide in one frame on a bandwidth-
constrained PSRAM. These two cloud-side changes shrink the work that
collides:

- **Bit 1 — TLS warm-up**: separate the expensive first handshake from
  the user-visible "icon goes green" moment.
- **Bit 2 — minimal first-heartbeat response**: when the cloud detects
  this is your first heartbeat after absence (>5 min since last
  heartbeat), it skips every non-essential thing and returns a
  ~30-byte response. Less for the firmware to parse during the
  artifact-prone window.

## Bit 1 — TLS warm-up endpoint

### What's deployed

```
GET /primus/ping
Authorization: Bearer <api_key>
Response: 200 { "ok": true, "t": <unix_ms> }
```

Auth-required (same `requirePrimusAuth` middleware). Body < 30 bytes.
Zero DB work beyond the auth-middleware lookup. Designed to be the
absolute cheapest authenticated endpoint we serve.

### Firmware change you need to make

Right after `STA_GOT_IP` in your WiFi event handler, BEFORE the first
`/primus/heartbeat` call, issue a `GET /primus/ping`. Discard the
response body — you don't care what it says, only that the round-trip
completed. The point is to do the expensive cold-mbedtls work (TLS
handshake, peer cert chain, session state allocation in PSRAM) at a
quiet moment when nothing else is competing for memory bandwidth.

```cpp
// Pseudocode — adjust to your HTTPS client wrapper

void on_wifi_got_ip() {
  // ... existing time-sync, DHCP, etc.

  // TLS warm-up. Don't update any UI state.
  // Don't bump the cloud icon. Just do the round-trip.
  bool ok = http_get_simple("https://api.originmonitor.com/primus/ping",
                            g_api_key,
                            /*timeout_ms=*/3000);

  if (!ok) {
    // Warm-up failed. Log it and let the heartbeat path handle the
    // first-real-handshake cost as today. Don't retry — the heartbeat
    // will run anyway and tell us if the cloud is reachable.
    ESP_LOGW(TAG, "[TLS-warmup] failed; first heartbeat will pay the cost");
  }

  // Now schedule the first real heartbeat. By the time it fires,
  // mbedtls session state is hot in PSRAM/cache and the round-trip
  // is much cheaper.
  schedule_first_heartbeat();
}
```

### Important notes

- **Don't update the cloud icon based on `/primus/ping`.** The user-visible
  "we're connected" signal stays as today: the first successful
  heartbeat. The whole point of the warm-up is invisibility.
- **Use the SAME TLS keep-alive client for `/primus/ping` and the subsequent
  heartbeat.** That's what makes the warm-up effective — mbedtls reuses the
  established session/state. If you tear down the client between calls
  and rebuild it for the heartbeat, you've gained nothing.
- **Don't loop on retries.** If `/primus/ping` fails, just proceed with the
  heartbeat path. The heartbeat itself will retry through your existing
  cloud-error handling.
- **Don't call this from the heartbeat task on a regular cadence.** This
  endpoint is one-shot, immediately post-WiFi-up. Future heartbeats use
  the warmed-up keep-alive connection naturally.

### Verification

After implementation, on the serial log you should see something like:

```
[ts] STA_GOT_IP, ip=...
[ts] [TLS-warmup] ping ok dur=820ms heap=...
[ts] [Cloud] HTTP client ready (keep-alive TLS)
[ts] [Cloud] POST /primus/heartbeat ... dur=180ms   <-- much faster than today's 818ms
```

The dramatic drop in heartbeat duration on cold-boot is the proof point.
Today's first heartbeat after WiFi-connect spends most of its budget on
TLS handshake; with warm-up, the handshake cost is amortised before the
icon-relevant heartbeat fires.

---

## Bit 2 — minimal first-heartbeat response

### What changed cloud-side

The `/primus/heartbeat` handler now reads `primus_devices.last_seen`
BEFORE updating it. If it's null or > 5 min stale, this is treated as
a "first after absence" heartbeat. On those, the handler:

- Updates `last_seen`, `firmware_version`, `wifi_ssid` (always done — the
  keepalive bookkeeping must always happen).
- Processes `command_results` from the request body normally (state
  changes can't safely be deferred — if the firmware says a command
  finished, it finished).
- **Skips** events ingest, gap-fill verification, timeout cascade,
  retry sweep, opportunistic backlog, auto gap-detection, and command
  delivery.
- Returns:

```json
{
  "ok": true,
  "deferred": true,
  "events_acked": [],
  "commands": []
}
```

The "real" work runs on the next heartbeat 60s later. Customers see
~60s delay on the first delivery of any pending commands and on the
first round of cloud-side gap detection. For Andrew's account this is
fine; downstream customers won't notice.

### Firmware change you need to make

Two small things:

**1. When you receive `deferred: true`, do NOT trim your events ring buffer.**

Today (per current behaviour) you walk `events_acked` and remove
matching entries from your ring buffer. On a deferred response,
`events_acked` will always be `[]` — but the events were NOT actually
ingested cloud-side. Don't accidentally clear them. Your existing
ring-buffer trim logic should already do this naturally (empty acked
array → nothing to trim), but worth a sanity check.

**2. When you receive `deferred: true`, do NOT log it as an error.**

It's an expected mode, not a failure. Suggested log line:

```
[Cloud] heartbeat deferred (first-after-absence) — full cycle next time
```

The `commands` array will be empty too, so your existing command-
processing loop just no-ops. No special handling needed there.

### What stays the same

- Heartbeat cadence (60s).
- Heartbeat body shape — no change.
- HTTP status code (200).
- Top-level `ok: true` field.
- TLS / keep-alive / cloud icon flip (the "ok" boolean is the trigger
  for the icon to go green, just as today — that's the user-visible
  contract we're explicitly preserving).

### Detecting old vs new cloud

If the firmware needs to be backward-compat with an older cloud that
doesn't return `deferred`, just default-treat the field as `false`
when missing. Existing behaviour falls through naturally.

```cpp
bool deferred = json_get_bool(response, "deferred", /*default=*/false);
if (deferred) {
  ESP_LOGI(TAG, "[Cloud] heartbeat deferred — full cycle next time");
} else {
  // existing event-ack walk, command processing, etc.
}
```

### Verification

Cold boot the device. Watch the serial log:

```
[ts] STA_GOT_IP
[ts] [TLS-warmup] ping ok dur=820ms                  <-- bit 1
[ts] [Cloud] POST /primus/heartbeat dur=180ms        <-- bit 1 effect: TLS warm
[ts] [Cloud] heartbeat deferred                       <-- bit 2 effect: minimal response
[ts] (~60s later)
[ts] [Cloud] POST /primus/heartbeat dur=180ms        <-- normal full cycle
[ts] [Cloud] events_acked=N, commands=M               <-- real work happens now
```

Display tearing should be measurably better at the cloud-icon-green
transition. The remaining ~60s of "no commands delivered" is invisible
to the user — by the time they could possibly perceive it, the next
heartbeat has fired and everything is steady-state.

---

## What I'm NOT changing

- The atomic claim semantics, retry chain, opportunistic backlog —
  all carry over to the second heartbeat unchanged.
- The schema for command_results, events, commands — all unchanged.
- pg_cron jobs — independent of heartbeat path, no impact.
- The auto-gap-detect / Primus-offline detector logic — runs on every
  full-cycle heartbeat; just not on deferred ones. The 60s skip is
  bounded and harmless.

## Recovery

If anything goes wrong with bit 2 (minimal response), worst case is
that the Primus thinks it's been deferred when actually it's been
fully processed — which would cause it to NOT trim its events ring
buffer, leading to retransmits next cycle. Cloud's dedup catches that.
Worst observable symptom: events appear duplicated in `primus_events`
table briefly (quickly trimmed by the 500-event cap). No data loss,
no production impact.

If anything goes wrong with bit 1 (warm-up endpoint), worst case is
that the warm-up fails and the heartbeat pays the cold-handshake cost
as today — i.e., status quo. No regression risk.

## Roll-out order

The contract is designed so you can ship in either order:

- **Bit 1 first** (firmware-only) → immediate ~50% reduction in
  first-heartbeat duration, regardless of whether bit 2 is in cloud.
- **Bit 2 first** (cloud-only, already deployed) → first-heartbeat
  response is minimal regardless of whether firmware sends ping. Just
  means the firmware's parse is cheaper on first heartbeat after
  absence — moderate but not as big a win as bit 1.

Both together is the goal: TLS warm before the user-visible event,
AND minimal response on the user-visible event itself. That should
get the artifact down to "is it even there."

— Claude (Cloud session)
