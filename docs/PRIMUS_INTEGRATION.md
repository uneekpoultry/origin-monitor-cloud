# Origin Primus — Basestation Integration Brief

> Paste this entire document into the Claude Code session that is building the **Origin Primus** ESP32-S3 firmware.

---

## 1. Architecture

```
Origin Primus (ESP32-S3 + Waveshare 4.3" LCD, LVGL UI)
   │
   ├── BLE central → listens to Origin Pro / Origin Lite sensors (up to 4)
   │                 (already working — same BLE advertisement parsing as the app)
   │
   └── HTTPS → https://api.originmonitor.com
                  POST /primus/heartbeat   (every ~60s)
                  POST /primus/readings    (every ~60s, batched from all sensors)
```

**Primus does NOT talk to Supabase directly.** It only talks to the Origin Monitor cloud API at `https://api.originmonitor.com`, which lives on a DigitalOcean droplet behind Cloudflare and handles writing to Supabase on the device's behalf.

The Android app also exists and uses the same data, but via Supabase directly. Your sensor reading POSTs become visible to the app in real-time.

---

## 2. Authentication model

Every Primus has a **per-device API key** (a 32-byte URL-safe random string). This key is:

- Generated server-side by the admin panel when the device is registered to a customer
- Shown to the admin **exactly once** in plaintext
- Stored hashed (SHA-256) in the database; plaintext never leaves the admin session
- Entered by the user (or admin) into the Primus device config UI
- Persisted in **ESP32 NVS** (partition: `nvs`, namespace: `origin`, key: `api_key`)
- Sent in every API request as:

```
Authorization: Bearer <api_key>
```

**Do NOT hard-code an API key into firmware.** Each physical Primus gets its own. The device must read it from NVS at boot and prompt the user to enter it if missing.

### Provisioning UX

Suggested first-boot flow:

1. LVGL: show "Connect to WiFi" screen → user enters SSID + password → save to NVS
2. Test internet → GET `https://api.originmonitor.com/health` → expect 200 with `{"ok":true,...}`
3. LVGL: show "Enter pairing key" screen with an on-screen keyboard
4. User enters the API key (32 chars, base64url alphabet — uppercase, lowercase, digits, `-`, `_`)
5. Save to NVS, POST a heartbeat → expect 200 — if 401, the key is wrong
6. On success, show the main monitoring UI

---

## 3. Endpoints

### Health check (no auth, useful for connectivity verification)

```
GET /health
→ 200 {"ok":true,"service":"origin-monitor-api","time":"2026-04-20T..."}
```

### Heartbeat

Call every **60 seconds** so we know the device is alive.

```
POST /primus/heartbeat
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "firmware_version": "1.0.3",         // optional but recommended
  "wifi_ssid": "HatchingRoom"          // optional, helps support
}

→ 200 {"ok":true}
→ 401 {"error":"invalid_token"}       // key wrong/revoked — prompt re-entry
→ 429                                  // rate-limited, back off and retry
```

### Sensor readings (batch)

Call every **60 seconds** with all readings accumulated since the last call. Keep each batch ≤ 100 readings.

```
POST /primus/readings
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "readings": [
    {
      "serial_number": "AC:23:3F:EE:11:22",    // sensor MAC or printed serial — must match what the app registered
      "temperature": 37.62,                     // °C, optional
      "humidity": 55.4,                         // %RH, optional
      "battery_mv": 2912,                       // optional
      "recorded_at": "2026-04-20T01:23:45Z"     // ISO8601 UTC, optional (server defaults to now)
    },
    { ... up to 100 rows ... }
  ]
}

→ 200 {"ok":true,"accepted":N,"skipped":["SERIAL_NOT_OWNED_BY_USER",...]}
→ 400 {"error":"invalid_body","details":{...}}
→ 401 {"error":"invalid_token"}
```

**Important:** the API will silently skip readings for sensors whose `serial_number` is not registered to the same user as this Primus. That's intentional — if a nearby sensor from another customer's property is in BLE range, we don't want to write that data to your customer's account. The server returns the skipped serials so Primus can log/ignore them.

---

## 4. TLS

The API is behind Cloudflare + Let's Encrypt. On ESP32, use ESP-IDF's `esp_http_client` with:

```c
esp_http_client_config_t cfg = {
  .url = "https://api.originmonitor.com/primus/heartbeat",
  .crt_bundle_attach = esp_crt_bundle_attach,  // Mozilla CA bundle
  .timeout_ms = 10000,
  .buffer_size = 2048,
  .buffer_size_tx = 1024,
};
```

Enable `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y` in `sdkconfig`. Do not disable certificate verification.

---

## 5. Time sync (NTP) — required

The API accepts readings without `recorded_at` and will timestamp them on arrival, but that makes client-side buffering/retry pointless. Sync NTP before sending:

```c
setenv("TZ", "UTC", 1); tzset();
esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
esp_sntp_setservername(0, "pool.ntp.org");
esp_sntp_init();
// wait for time > 2020 before proceeding
```

Format times as ISO8601 UTC: `"2026-04-20T01:23:45Z"`.

---

## 6. Retry / offline buffering

WiFi and the cloud will not always be available. Buffer readings in RAM (ring buffer, ~1000 entries ≈ 16 hours at one read per minute per sensor) and retry on a geometric backoff:

- 1st failure: retry in 30s
- 2nd failure: retry in 2 min
- 3rd+ failure: retry every 5 min until success
- On success, flush the buffer in batches of ≤ 100

Persist the buffer to NVS or SPIFFS if you want it to survive reboots — a deep sleep or power glitch shouldn't lose an hour of hatch data.

On `401` (invalid token), **stop retrying and surface the error in the UI.** Do not burn the rate limit with bad keys.

---

## 7. Sensor serial numbers

The app registers sensors to a customer's account using the **BLE MAC address** as `serial_number`. Primus must use the exact same string format so the server can match. Use uppercase, colon-separated: `AC:23:3F:EE:11:22`.

If your current parsing uses a different format (no colons, lowercase, etc.), normalize to the colon-separated uppercase form before POSTing.

---

## 8. Firmware version reporting

Every heartbeat should include `firmware_version` so the admin dashboard shows which firmware each Primus is running. Pick a scheme like `"1.0.3"` and hard-code at build time via a `FIRMWARE_VERSION` define.

---

## 9. Recommended LVGL UI screens

- **Main:** big temperature + humidity readout per sensor (up to 4 columns), last-seen age, battery icon
- **Status bar:** WiFi RSSI icon, cloud-sync icon (green = heartbeating OK, red = last heartbeat failed, grey = offline)
- **Settings:** WiFi config, API key entry (masked), firmware version + update check button, factory reset

When the cloud icon is red, tap it to show the last server error for diagnosis.

---

## 10. Rate limits

The API enforces 300 requests / 60 seconds per source IP. A Primus making 2 requests per minute (1 heartbeat + 1 readings batch) is nowhere near that. Don't poll harder than once per 30 seconds — there's no benefit.

---

## 11. Product naming (authoritative)

- **Origin Primus** — this basestation
- **Origin Monitor** — the Android app (not this device, and not "Origin Genesis" as older docs say)
- **Origin Pro / Origin Lite** — the BLE sensors Primus scans for

Database enum values use the short form. If firmware ever needs to identify itself in a field (e.g. firmware release channels), use `"primus"`.

---

## 12. Example: single heartbeat in ESP-IDF C

```c
#include "esp_http_client.h"

void primus_heartbeat(const char* api_key, const char* fw) {
  char auth[96];
  snprintf(auth, sizeof(auth), "Bearer %s", api_key);

  char body[128];
  snprintf(body, sizeof(body),
    "{\"firmware_version\":\"%s\",\"wifi_ssid\":\"%s\"}",
    fw, primus_current_ssid());

  esp_http_client_config_t cfg = {
    .url = "https://api.originmonitor.com/primus/heartbeat",
    .method = HTTP_METHOD_POST,
    .timeout_ms = 10000,
    .crt_bundle_attach = esp_crt_bundle_attach,
  };
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  esp_http_client_set_header(c, "Authorization", auth);
  esp_http_client_set_header(c, "Content-Type", "application/json");
  esp_http_client_set_post_field(c, body, strlen(body));

  esp_err_t err = esp_http_client_perform(c);
  int status = esp_http_client_get_status_code(c);
  esp_http_client_cleanup(c);

  if (err != ESP_OK || status != 200) {
    ESP_LOGW("primus", "heartbeat failed: err=%d status=%d", err, status);
  }
}
```

---

## 13. Useful URLs

- Cloud API base: `https://api.originmonitor.com`
- Customer web portal: `https://originmonitor.com` (not used by Primus directly, but customers land here)
- Admin Primus registration (where the device's API key is issued): `https://originmonitor.com/admin/primus`
- Health check: `https://api.originmonitor.com/health`

---

## 14. Out of scope for Primus

- User authentication / signup (the app handles that)
- Hatch log CRUD (the app handles that)
- Firmware OTA server — not built yet; heartbeat will expose a "firmware available" field later
- Direct Supabase access (do not attempt)
