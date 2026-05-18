# Claude App — Mini self-serve provisioning (App brief)

> App side of **unified claim-code provisioning**. Shared protocol,
> two-credential model, state enum, cloud endpoints, security &
> lifecycle are in `PROVISIONING_CONTRACT.md` — **binding; read it
> first.** This brief is App scope + the UX bar. Decided 2026-05-18:
> unified claim model, **professional polished UX only — no fast/cheap
> paths**. Judged on the unhappy paths. **The user never sees an API
> key; the App never writes a key over BLE.**

---

## Two paths the App must support

**A. Bare Mini (no Display) — App does WiFi + claim**
1. "Add a device" (inside the Primus / My-Devices screen) → BLE
   discovery of `Origin Primus Mini XXXX`.
2. **QR scan** of the unit sticker → `{mac, bootstrap_secret}`; match
   to a discovered advertisement (possession proof + disambiguation).
3. Encrypted BLE connect; read `DEVICE_INFO`; assert `mac == QR mac`.
4. **WiFi picklist** from `WIFI_SCAN` (signal, lock, **explicit
   2.4 GHz-only handling** — name the 5 GHz pitfall plainly).
   Hidden-SSID manual path.
5. Write `WIFI_CREDS` (WiFi only — there is no key characteristic).
   Watch `STATUS`.
6. When the Mini reports `AWAITING_CLAIM`, call **`POST
   /app/primus/claim`** (user session) with `{mac, bootstrap_secret}`
   (already have it from the QR) + `name`.
7. Watch `STATUS` → `CLOUD_CONNECTING` → `ONLINE`.

**B. Connect (Display present) — Display did WiFi; App just claims**
1. The user set WiFi on the Display; the Display shows a "Scan to link
   to your account" QR / short pairing code.
2. App "Add a device" → **scan that QR** (or enter the pairing code).
   No BLE, no WiFi step in the App for this path.
3. Call `POST /app/primus/claim` with `{mac, bootstrap_secret}` **or**
   `{pairing_code}` + `name`.
4. Show live progress until cloud confirms `ONLINE`.

Both paths converge on the **same claim endpoint** and the same
success criteria.

## Your deliverables

- "Add a device" entry in the Primus/My-Devices screen.
- BLE discovery + QR scanner (sticker QR and Display-rendered QR/code
  both resolve to a claim).
- WiFi picklist UI (path A) with 2.4 GHz-only handling + hidden SSID.
- The **claim call** + **live truthful progress** driven by device
  state (BLE `STATUS` path A; `GET /app/primus` poll for both) — every
  failure state/subcode is a **specific message + specific recovery**,
  never a generic spinner:
  - `WIFI_FAILED` 1/2/3 → wrong password / network not found / no IP.
  - `CLAIM_FAILED` 2 → "already linked to another account" → clean
    **transfer-guidance** screen (this is the 409).
  - `CLAIM_FAILED` 3 / no internet → "on Wi-Fi but can't reach Origin".
- **Double-confirm success:** device `ONLINE` **and** `GET
  /app/primus` first `last_seen` before "set up ✓". Then name it.
- **"My Devices"** screen (`GET /app/primus`): live online/last-seen,
  rename, **Change Wi-Fi** (guides the short-press reprovision; key
  retained), **Remove device** (`DELETE /app/primus/:id`; reassure
  **history is kept** — data is sensor/user-scoped), `identify` blink.
- Resumable: BLE drop / backgrounded → reconnect, continue from last
  `STATUS`, never restart from zero.

## The UX bar (the point of the feature)

No dead ends · no lies (progress = real device state) · no jargon
("API key"/"bootstrap secret"/"GATT" never appear in UI) · resumable ·
the LED + the App's live status are the entire reassurance surface for
a non-technical user setting up a screenless box — treat them as the
product.

## Constraints / consistency

- Auth to `/app/primus/*` = the **user's Supabase session** (not a
  device key). The App never handles the operational key at all.
- Once `ONLINE` the Mini is just a Primus in the existing dashboard
  (`CLAUDE_APP_MINI_DISPLAY_SPLIT.md`); provisioning only adds
  onboarding + My-Devices.
- Don't model a "Display" entity — App still never sees one.

## Acceptance (happy + unhappy)

1. Bare Mini: discovered, QR matched, WiFi set over BLE, claimed,
   `ONLINE` confirmed by cloud.
2. Connect: scan the Display-shown QR only → claimed → `ONLINE`
   (no BLE/WiFi in the App).
3. Wrong WiFi password → specific message, inline retry, no restart.
4. 5 GHz-only phone network → explicit 2.4 GHz explanation.
5. Already-claimed device → clean transfer-guidance (409).
6. Success only after device `ONLINE` **and** cloud `last_seen`.
7. Change-WiFi keeps the claim; Remove device unbinds + states history
   retained.
8. Mid-flow BLE drop (path A) → resumes from last `STATUS`.

— Claude (Cloud session)
