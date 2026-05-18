# Claude Primus — Mini self-serve provisioning (firmware brief)

> Mini/Display side of **unified claim-code provisioning**. The shared
> protocol, two-credential model, state enum, security and lifecycle
> are in `PROVISIONING_CONTRACT.md` — **binding; read it first.** This
> brief is firmware scope + the choices you own. Decided 2026-05-18:
> unified claim model, polished, no shortcuts. **No API key over BLE.**

---

## Your deliverables

1. **Bootstrap secret in NVS.** Each unit is flashed at manufacture
   with `bootstrap_secret = HMAC(MASTER_KEY, mac)` (the flashing tool
   computes it; firmware just stores + uses it). It is the device's
   credential to `POST /provision/checkin`. **`MASTER_KEY` never lives
   in firmware or the repo** — only the per-device derived secret is on
   the device. Coordinate the NVS layout + the flashing-tool contract
   (you own the tool side; Cloud owns the verify side).
2. **BLE provisioning service — WiFi only** (`PROVISIONING_CONTRACT.md
   §3`). The old `CLOUD_CREDS` characteristic is **gone** — the claim
   model removed it. Characteristics: `DEVICE_INFO`, `WIFI_SCAN`,
   `WIFI_CREDS`, `STATUS`, `CONTROL`. You assign UUIDs; logical
   contract + state enum fixed. Advertise only `UNPROVISIONED`/
   `REPROVISION_WINDOW`; LE Secure "Just Works"; MTU≈247; chunk scans.
3. **Checkin client.** After WiFi up: `POST /provision/checkin {mac,
   bootstrap_secret}`; on `awaiting_claim` store + expose the
   `pairing_code` (on `STATUS` and, for Connect, send to the Display);
   poll on a sane backoff; on `claimed` receive the operational API
   key over TLS, persist to NVS, ack, switch to the **existing normal
   cloud cycle** (do not reimplement it). State machine = the 0–9 enum
   in the contract, exposed live + truthful on `STATUS`.
4. **Connect / UART (Phase-3 serial).** Display→Mini: `WIFI_SCAN_REQ`,
   `WIFI_CREDS`, `CONTROL`. Mini→Display: `WIFI_SCAN_RESULT`,
   `PROV_STATUS{state,subcode}` (same enum), `CLAIM_INFO{pairing_code,
   qr_payload}` so the Display can render the claim surface. **The
   Display never receives the operational key.**
5. **RGB status LED** per the enum's LED column (incl. `identify`
   blink, `ONLINE` breathe→dim). Approved hardware — design the GPIO +
   enclosure light-pipe into the board-HAL.
6. **Factory-reset button, one button two timings:** short →
   `REPROVISION_WINDOW` (key retained, re-advertise BLE / re-open
   Display WiFi UI); long ~10 s → full NVS wipe → `UNPROVISIONED`.
7. **`DEVICE_INFO.mac` and the QR `mac` must be byte-identical** to
   what the App asserts — agree the normalised format with the App
   session in your first reply (also the `qr_payload` encoding of
   `{mac, bootstrap_secret}`).

## Choices you own (report picks)

- BLE UUIDs; NimBLE Just-Works config; `WIFI_SCAN` chunking scheme.
- NVS layout `{wifi_ssid, wifi_pass, bootstrap_secret, api_key,
  primus_id, name, claim_state}`.
- Checkin poll cadence/backoff + pairing-code refresh handling.
- The flashing-tool design that computes/writes `HMAC(MASTER_KEY,mac)`
  + prints the QR (master-key custody is a release-process control —
  coordinate with Andrew/Cloud; the key is the highest-value secret in
  the system).
- Phase-3 UART framing (you already specced 460800/CRC16 etc.).

## Constraints / consistency

- On the **Phase-1 Mini baseline** (stripped pre-C3 firmware).
- Provisioning only *feeds* the existing WiFi/TLS/cloud stack — do not
  reimplement the cloud cycle; once `ONLINE` the Mini is a normal
  Primus.
- Display never handles the operational key; account binding is always
  the authenticated App/portal.

## Acceptance (happy + unhappy)

1. Factory-flashed unit: bootstrap secret in NVS, QR prints matching.
2. Bare Mini: App finds it, WiFi-only over BLE, joins AP.
3. Wrong WiFi pass → `WIFI_FAILED` sub=1 fast; inline retry, no BLE
   reconnect.
4. Checkin returns `awaiting_claim` + pairing code; LED cyan; code on
   `STATUS` / sent to Display.
5. After user claims → next poll returns key → `ONLINE`, first
   heartbeat lands, BLE service stops advertising.
6. Bad bootstrap secret → `CLAIM_FAILED` sub=1 (must never happen on a
   correctly-flashed unit — proves the HMAC path).
7. Connect: Display drives WiFi + renders `CLAIM_INFO`; Mini never
   sends the key to the Display.
8. Short press = WiFi change (same key); long hold = full wipe.

— Claude (Cloud session)
