# Origin Primus — BLE + WiFi Coexistence Fix

> Paste this entire document into the Primus firmware Claude Code session. Work through it top to bottom — skip steps you've already done (note which, so we can focus).

---

## 1. Root cause

The ESP32-S3 has **one 2.4 GHz radio** shared between BLE and WiFi via a firmware-level coexistence arbiter. If BLE scans aggressively, it starves WiFi. Symptoms:

- WiFi drops / reconnects during active BLE scanning
- High API POST failure rate (timeouts, not 4xx/5xx)
- BLE advertisements received but cloud sync unreliable
- Throughput collapse on WiFi during BLE scan windows

This is not a bug — it's the radio sharing time. The fix is to **reduce BLE's radio share** to the minimum needed to catch Origin sensor advertisements, and **coordinate explicitly during cloud uploads**.

---

## 2. Baseline diagnostics (do this first — you can't fix what you haven't measured)

Before changing anything, instrument these counters and log them every 30 seconds. This tells us *where* the time is being lost so we stop guessing.

```cpp
// Globals
volatile uint32_t g_ble_adverts_total     = 0;
volatile uint32_t g_ble_adverts_unique    = 0;   // unique by MAC, reset per minute
volatile uint32_t g_wifi_disconnects      = 0;
volatile uint32_t g_api_posts_ok          = 0;
volatile uint32_t g_api_posts_failed      = 0;
volatile uint32_t g_api_posts_duration_ms = 0;   // sum, for avg

// Increment in:
//   - BLEScanCallback        -> g_ble_adverts_total++
//   - WiFiEvent(SYSTEM_EVENT_STA_DISCONNECTED) -> g_wifi_disconnects++
//   - after successful HTTPClient.POST  -> g_api_posts_ok++, add duration
//   - after failed HTTPClient.POST      -> g_api_posts_failed++

void diagnosticsTask(void*) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(30000));
    ESP_LOGI("DIAG",
      "30s: adverts=%lu wifi_dc=%lu posts=%lu/%lu avg_post_ms=%lu rssi=%d",
      g_ble_adverts_total, g_wifi_disconnects,
      g_api_posts_ok, g_api_posts_ok + g_api_posts_failed,
      g_api_posts_ok ? g_api_posts_duration_ms / g_api_posts_ok : 0,
      WiFi.RSSI());
    // reset counters if you want per-window stats
  }
}
```

Run for 5 minutes with BLE + WiFi both active and record typical values. **Before proceeding, report back:**

- Adverts per 30s (expected with 4 sensors advertising every 2s: ~60)
- WiFi disconnects per 30s (target: 0)
- API post success rate (target: ≥99%)
- Avg post duration (target: <2000ms)

These become the success criteria for each fix below.

---

## 3. Path 1 — BLE scan tuning (try first, solves most cases)

The Arduino BLE library's default scan parameters are extremely aggressive. Origin sensors broadcast every 2–5 seconds, so listening 100% of the time is pointless — it just blocks WiFi.

**Target duty cycle: BLE radio active ≤3% of the time.**

### Change 1 — passive scan

Active scan sends "scan request" packets (radio TX). Passive scan only listens. For advertisement-only sensors (no paired connection needed for live data), passive is always correct.

```cpp
pBLEScan->setActiveScan(false);
```

### Change 2 — scan window / interval

Window = how long to listen per scan cycle.
Interval = how often to start a scan cycle.
Duty cycle = window / interval.

```cpp
// Defaults are ~100% duty cycle — very bad for WiFi.
// New: listen 30ms every 1280ms = 2.3% duty cycle
pBLEScan->setInterval(1280);   // start a scan every 1.28s
pBLEScan->setWindow(30);       // for 30ms
pBLEScan->setDuplicateFilter(true);
```

Why these numbers: Origin sensors broadcast every 2–5s. Across multiple scan windows you'll catch each advertisement at least once per 5s — plenty fresh for a display that updates once per second.

### Change 3 — continuous scan mode

Make sure scanning is started in continuous mode (non-blocking, not fixed-duration):

```cpp
pBLEScan->start(0, false);   // 0 = continuous, false = not blocking
```

### Verify Path 1

Re-run diagnostics for 5 minutes. Expect:

- `adverts` drops slightly (e.g. 60 → 50 per 30s) — that's fine
- `wifi_dc` drops to near 0
- `posts_ok` rate climbs to ≥99%
- `avg_post_ms` drops below 1500ms

If numbers are already good, stop here. No Path 2/3/4 needed.

---

## 4. Path 2 — Explicit pause during cloud uploads

Even with low-duty scanning, a 30ms BLE window landing during a TLS handshake can kill the HTTP request. Coordinate explicitly: **pause BLE scanning for the 1–2 seconds it takes to POST to the cloud**.

### Pattern

```cpp
void syncWithCloud() {
  // Pause BLE
  pBLEScan->stop();
  vTaskDelay(pdMS_TO_TICKS(50));   // let the radio settle

  // Do the network work
  primusHeartbeat();
  primusSendReadingsBatch();

  // Resume BLE
  pBLEScan->start(0, false);
}
```

Call `syncWithCloud()` from a periodic timer task (every 60s), **not** from inside the BLE scan callback.

### Why this is safe

Origin sensors advertise every 2–5s. A 2-second BLE pause every 60s means you miss at most 1 advertisement per sensor per sync. Next scan catches them. No meaningful data loss.

### Why this isn't just "run them both hard"

BLE and WiFi share the RF front-end, not just CPU time. Even with coexistence arbitration, simultaneous radio ops degrade both. An explicit pause removes the conflict entirely for the 1–2s that matters.

### Verify Path 2

Expect the `avg_post_ms` to drop further (fewer retries inside the TCP stack) and `posts_failed` to approach 0.

---

## 5. Path 3 — Coexistence config and priority bias

Do this if Path 1 + 2 still shows WiFi instability (usually means the coexistence arbiter is giving BLE priority by default).

### Verify coexistence is enabled

In `sdkconfig` (or via menuconfig), confirm:

```
CONFIG_SW_COEXIST_ENABLE=y
```

Arduino-esp32 v3.x has this on by default. If using plain ESP-IDF, check explicitly.

### Bias toward WiFi during uploads

```cpp
#include "esp_coexist.h"

// Default bias — keep this normally
esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);

// In syncWithCloud() — bias toward WiFi for the upload window
void syncWithCloud() {
  esp_coex_preference_set(ESP_COEX_PREFER_WIFI);
  pBLEScan->stop();
  vTaskDelay(pdMS_TO_TICKS(50));

  primusHeartbeat();
  primusSendReadingsBatch();

  pBLEScan->start(0, false);
  esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
}
```

`ESP_COEX_PREFER_BT` is the opposite — avoid unless you're doing long audio streams or similar.

---

## 6. Task and core layout (confirm this is correct)

```cpp
// Core 1 — UI (realtime, priority 2)
xTaskCreatePinnedToCore(lvglTask,         "lvgl",     8192, NULL, 2, NULL, 1);
xTaskCreatePinnedToCore(touchTask,        "touch",    4096, NULL, 2, NULL, 1);

// Core 0 — network + sensors (priority 1)
xTaskCreatePinnedToCore(wifiMaintainTask, "wifi",     4096, NULL, 1, NULL, 0);
xTaskCreatePinnedToCore(cloudSyncTask,    "cloud",    8192, NULL, 1, NULL, 0);
xTaskCreatePinnedToCore(bleScanTask,      "ble",      4096, NULL, 1, NULL, 0);
// diagnosticsTask can live on either; put it on core 0
xTaskCreatePinnedToCore(diagnosticsTask,  "diag",     2048, NULL, 1, NULL, 0);
```

Rules:

- **Never call LVGL from anywhere but `lvglTask`.** If BLE/cloud tasks need to update the UI, they push data into a `QueueHandle_t` that `lvglTask` drains.
- **Never call WiFi/HTTP from `lvglTask`.** Display stays smooth even when the cloud is slow.
- **Shared state** (latest sensor readings, sync status) lives in a struct guarded by a `SemaphoreHandle_t` mutex.
- BLE and cloudSync are both on core 0 deliberately — they serialize radio access through the OS scheduler rather than fighting for it.

---

## 7. Path 4 — Escalation: split radios (only if 1–3 not enough)

If after Paths 1 + 2 + 3 you still see instability during demo/customer use, the clean production fix is to move BLE to a separate chip:

**S3** = LVGL UI + WiFi + cloud
**C3 / C6 companion** = BLE only → UART → S3

Reasons this is the right split (not the opposite):

- BLE only needs to reach sensors 1–10m away in the same room — even a weak-antenna C3 works
- WiFi's antenna quality matters more (customer router might be rooms away) — S3's existing antenna is proven
- UI on the S3 where it already lives

Don't build this unless Paths 1–3 don't close the gap. It adds a chip, a firmware, a UART protocol, and a second OTA target — real cost.

---

## 8. Success criteria

After Paths 1 + 2 (and Path 3 if needed), targets:

| Metric | Target |
|---|---|
| WiFi disconnects per hour | ≤ 1 |
| API POST success rate | ≥ 99% |
| Avg API POST duration | < 1500 ms |
| Per-sensor advertisement loss | < 5% (still get 1+ reading per 10s per sensor) |
| UI frame drops during sync | 0 (LVGL stays at 30+ fps) |

If you hit all five for 30 minutes continuous with 4 sensors + active uploads, ship it.

---

## 9. What to report back

After the diagnostic baseline run:

1. **Baseline numbers** — the 5 counters above
2. **Which paths have already been tried** — we may be half-done already
3. **Current scan parameters** — `setInterval`, `setWindow`, `setActiveScan`
4. **Current coexistence config** — `CONFIG_SW_COEXIST_ENABLE` value
5. **Current task pinning** — which task runs on which core

That lets me give you the next concrete step instead of a list of possibles.
