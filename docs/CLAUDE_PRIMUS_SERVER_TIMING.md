# Primus — Server-Timing header (small diagnostic addition)

> Quick add to help diagnose the residual display tearing. Cloud-side
> deployed 2026-04-30 ~13:08 UTC. Firmware change is small and additive
> — nothing breaks if you don't implement it; you'd just be missing
> useful info in the serial log.

## What the cloud does now

Both `/primus/heartbeat` and `/primus/readings` responses now include a
standard W3C `Server-Timing` HTTP response header. Format:

```
Server-Timing: dev;dur=12, tz;dur=0, events;dur=45, results;dur=8, density;dur=0, timeout;dur=4, retry;dur=210, backlog;dur=15, gapdet;dur=120, deliver;dur=6
```

Each stage is a phase of the handler with its duration in milliseconds.
Definitions:

### `/primus/heartbeat` stages

| Stage | What it covers |
|---|---|
| `dev` | Read previous `last_seen`, update `primus_devices` row |
| `tz` | Timezone adoption (usually `0` — no work to do) |
| `events` | Ingest events from request body, dedup, ack, trim ring |
| `results` | Process `command_results`, mark linked `sensor_resync_requests` fulfilled |
| `density` | Post-resync gap-fill density verification (only when a resync just completed) |
| `timeout` | Sweep `primus_commands` for stuck/abandoned commands + cascade timeouts |
| `retry` | Re-queue any failed `sensor_resync_requests` past their backoff |
| `backlog` | Opportunistic backlog pickup (you claim unclaimed requests > 2 min old) |
| `gapdet` | Auto gap-detection for sensors stale > 5 min |
| `deliver` | Pick up pending commands and mark them delivered |

### `/primus/readings` stages

| Stage | What it covers |
|---|---|
| `lookup` | Resolve serial numbers to `sensors` rows |
| `provision` | Auto-create pending sensors + refresh advertised name |
| `hatch_q` | Active-hatch query (which sensors are recording vs broadcast-only) |
| `upsert` | UPSERT into `sensor_readings` (with dedup index) |
| `bcast_seen` | Live broadcast for casual-mode sensors + `last_seen` bump |

### Deferred-heartbeat short-circuit

When you receive `deferred: true` in the response body, the
`Server-Timing` header will only have `dev`, `tz`, and `results`
stages — the rest are skipped. This is normal and expected.

## What the firmware needs to do

In your existing cloud-request log lines, add a parsing of the
`Server-Timing` response header. If your HTTP client (esp_http_client,
HTTPClient, etc.) exposes response headers to a callback, you can grab
it from there. Pseudocode for esp_http_client:

```cpp
esp_err_t http_event_handler(esp_http_client_event_t *evt) {
  switch (evt->event_id) {
    case HTTP_EVENT_ON_HEADER:
      if (strcasecmp(evt->header_key, "Server-Timing") == 0) {
        snprintf(g_server_timing_buf, sizeof(g_server_timing_buf), "%s",
                 evt->header_value);
      }
      break;
    // ... existing cases
  }
  return ESP_OK;
}
```

Then in your existing log line, append it:

```cpp
ESP_LOGI(TAG, "[Cloud] POST /primus/heartbeat err=%d status=%d heap=%d body=%d dur=%dms srv=%s",
         err, status, heap, body_len, duration_ms,
         g_server_timing_buf[0] ? g_server_timing_buf : "-");
```

The result in your log:

```
[Cloud] POST /primus/heartbeat err=0 status=200 heap=92252 body=196 dur=1431ms srv=dev;dur=12, events;dur=45, results;dur=8, retry;dur=210, backlog;dur=15, gapdet;dur=120, deliver;dur=6
```

That tells me: of the 1431ms, the cloud spent 416ms in the listed
stages, and the remaining ~1000ms is TLS round-trip + body
upload/download. If `retry` or `gapdet` is high, those are DB-bound.
If they're all small, the slowness is network/TLS.

## Why this helps the tearing investigation

The current "slow request" log line just says `dur=Nms`. We don't know
whether that N is:

- Network/TLS (out of our control short of changing endpoints)
- DB query work on the cloud (we can optimise specific stages)
- One specific stage being a hog (we can target it)

With this header, when you do a cold-boot test and we see tearing
correlated with a specific cloud request, we can immediately read
which stage took the most time. If `retry;dur=400` shows up on the
slowest heartbeat, that's the function to optimise. If it's all
small but `dur` is still high, the slowness is TLS/PSRAM-related and
the firmware-side levers (mbedtls 4KB threshold, etc.) are the right
place to look.

## Verification

After your change is in firmware, do a cold boot. The serial log
should show the breakdown on every heartbeat. Roughly expected
shapes:

- **Steady-state heartbeat:** `dev;dur=10-50, retry;dur=200-400` —
  the rest mostly 0. Total ~250-500ms. The TLS+network adds another
  500-800ms.
- **First-after-absence (deferred):** `dev;dur=10-50, results;dur=0`
  only. Total ~50ms cloud-side. TLS+network ~500-800ms.
- **Heartbeat with command results from a recent resync:**
  `dev;dur=10, results;dur=20-50, density;dur=200-1000, ...` —
  density check can be slow if many sensors are checked.

## Cloudflare passthrough check

The cloud sits behind Cloudflare. Most CDNs pass `Server-Timing`
through transparently — it's a standard header — but if your firmware
isn't seeing the header at all in HTTP_EVENT_ON_HEADER, Cloudflare may
be stripping it. In that case, ping me back and I'll add it to a
custom `X-Origin-Timing` header to bypass any CDN policy. Shouldn't
need this but worth flagging.

## What I'm NOT changing

- The response body shape — `Server-Timing` is a header, not a body
  field. Existing JSON parsing is unaffected.
- HTTP status codes.
- Heartbeat schema, contract, anything else.

## Roll-out is independent

You can merge this whenever. The cloud is already serving the header
— if firmware ignores it, no harm done. If firmware logs it, I get
the diagnostic info I need on the next test.

— Claude (Cloud session)
