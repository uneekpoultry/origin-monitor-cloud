# Origin Primus — Self-Serve Provisioning (canonical contract)

> **Single source of truth for all three sessions (Cloud / Primus /
> App).** Model decided 2026-05-18: **unified claim-code provisioning,
> all units, professional UX, no fast/cheap shortcuts.** No API key is
> ever written over BLE; no human ever sees a key. RGB status LED +
> enclosure light-pipe approved.
>
> Relay briefs: `CLAUDE_PRIMUS_MINI_PROVISIONING.md`,
> `CLAUDE_APP_MINI_PROVISIONING.md`. This doc owns the protocol.

---

## 1. Two-credential model

| Credential | Origin | Used for | Secrecy |
|---|---|---|---|
| **Bootstrap secret** | Factory: `HMAC(MASTER_KEY, mac)`, flashed to NVS + printed in the unit/box QR | Authenticate to `/provision/checkin`; proves device genuine + holder has physical possession | Cloud verifies by recomputing the HMAC — **no per-device DB**. `MASTER_KEY` lives only in cloud env + flashing tool; never in firmware/repo. |
| **Operational API key** | Cloud-minted on claim (existing `primus_devices` Bearer key/SHA-256 machinery) | All normal cloud calls (heartbeat/readings/resync/…) | Pulled by device over TLS during checkin; never on BLE; never shown to a human. |

WiFi onboarding and account-claiming are **fully decoupled**. WiFi is
local plumbing (BLE for bare Mini, Display for Connect). Claiming is
always done by an **authenticated user** (App or web portal). The
device pulls its operational key over WiFi once claimed.

---

## 2. End-to-end flow (unified, all units)

1. **Power on** → no WiFi, unclaimed. LED slow blue pulse.
2. **Get on WiFi (decoupled, local):**
   - **Bare Mini:** App connects over BLE provisioning service →
     writes WiFi creds only (no key). LED steady blue while connected.
   - **Connect:** Display touchscreen WiFi entry → UART → Mini. (App/
     BLE not required for this path.)
3. Mini joins WiFi (`WIFI_CONNECTING`→`WIFI_OK`, LED amber). On
   failure: specific subcode (bad pass / AP not found / no DHCP).
4. Mini calls **`POST /provision/checkin`** with `{ mac,
   bootstrap_secret }`. Cloud verifies via HMAC recompute, marks the
   device "online, awaiting claim", returns a **short-lived pairing
   code** (TTL ~10 min, rots on expiry). Mini begins polling checkin.
   State `AWAITING_CLAIM` (LED cyan pulse).
5. **User claims it (authenticated):**
   - Surfaces the claim payload: **sticker QR** (any unit) encoding
     `{mac, bootstrap_secret}`, **or** the **Display shows** the
     short-lived pairing code / QR on screen (Connect).
   - In the logged-in **App** (scan QR) or **web portal** (type code):
     calls **`POST /app/primus/claim`** with the user JWT +
     `{ mac, bootstrap_secret }` **or** `{ pairing_code }`.
   - Cloud verifies, binds the `primus_devices` row to that user,
     mints the operational API key, marks `claimed`.
6. Device's next `/provision/checkin` poll returns the **operational
   API key** over TLS → NVS. State `CLOUD_CONNECTING` (LED amber).
7. First authenticated heartbeat lands → `ONLINE` (LED green,
   breathe ~30 s → dim). Mini stops the provisioning BLE service /
   exits the Display setup UI.
8. **Double-confirm success:** App/Display declare done only when
   device reports `ONLINE` **and** `GET /app/primus` shows first
   `last_seen`. User names the device (if not named at claim).

---

## 3. BLE provisioning service (bare-Mini WiFi only)

Headless Mini still needs a way to receive WiFi creds → BLE. **The BLE
service no longer carries any key** (claim model removed that). One
custom 128-bit service (Primus assigns UUIDs); advertised only when
`UNPROVISIONED`/`REPROVISION_WINDOW`; LE Secure "Just Works" bonding;
MTU ≈247, chunk scan results.

| Characteristic | Props | Payload |
|---|---|---|
| `DEVICE_INFO` | Read | `{ mac, model:"origin-primus-mini", fw, hw }` |
| `WIFI_SCAN` | Write trigger + Notify | stream `{ ssid, rssi, sec, band }`, end `{done:true}` |
| `WIFI_CREDS` | Write | `{ ssid, password, hidden:bool }` |
| `STATUS` | Read + Notify | `{ state:uint8, subcode:uint8, pairing_code?:string, detail? }` |
| `CONTROL` | Write | `{ cmd:"retry"|"abort"|"identify"|"enter_reprovision" }` |

`STATUS` exposes the pairing code once `AWAITING_CLAIM` so a bare-Mini
App flow can show it without the sticker if desired.

### State enum (shared: firmware / App / Display / this doc)

| # | State | LED |
|---|---|---|
| 0 | `UNPROVISIONED` | slow blue pulse |
| 1 | `WIFI_PROVISIONING` (BLE/Display connected) | steady blue |
| 2 | `WIFI_CONNECTING` | amber pulse |
| 3 | `WIFI_FAILED` (1 bad-pass · 2 AP-not-found · 3 no-DHCP) | red |
| 4 | `WIFI_OK` | amber |
| 5 | `AWAITING_CLAIM` (checked in, polling) | cyan pulse |
| 6 | `CLAIM_FAILED` (1 bad-secret · 2 already-claimed-other · 3 checkin-timeout) | red |
| 7 | `CLOUD_CONNECTING` (key received) | amber |
| 8 | `ONLINE` | green (breathe → dim) |
| 9 | `REPROVISION_WINDOW` (key retained, WiFi-change) | cyan pulse |

`CONTROL:"identify"` → ~5 s rapid white blink (confirm which box).

---

## 4. Connect path — Display ↔ Mini over UART

The Display (Connect only) replaces BLE for WiFi and is a nicer claim
surface. Serial messages (Phase-3 protocol; Primus owns framing):

- **Display → Mini:** `WIFI_SCAN_REQ`; `WIFI_CREDS{ssid,pass,hidden}`;
  `CONTROL{retry|abort}`.
- **Mini → Display:** `WIFI_SCAN_RESULT[…]`; `PROV_STATUS{state,
  subcode}` (same enum as §3); `CLAIM_INFO{ pairing_code, qr_payload }`
  so the Display can render "Scan to link to your account" with a QR +
  the human code.

The Display never sees or handles the operational key — it only does
WiFi + renders the claim surface + shows live `PROV_STATUS`. Account
binding is always the authenticated App/portal.

---

## 5. Cloud contract (Cloud session owns; documented here)

**Device-auth endpoint (bootstrap secret):**
- **`POST /provision/checkin`** — body `{ mac, bootstrap_secret }`.
  Cloud verifies `bootstrap_secret == HMAC(MASTER_KEY, mac)`.
  - not yet claimed → return `{ state:"awaiting_claim",
    pairing_code, pairing_ttl }` (issue/rotate the short-lived code).
  - claimed → return `{ state:"claimed", api_key }` (one-time key
    delivery; subsequent calls return `{state:"claimed"}` without the
    key once the device has acked receipt).
  - rate-limited per MAC; constant-time HMAC compare; reject malformed.

**User-auth endpoints (Supabase JWT — the user):**
- **`POST /app/primus/claim`** — body `{ mac, bootstrap_secret }` *or*
  `{ pairing_code }` + `name`.
  - verify (HMAC, or look up by unexpired pairing_code) → bind
    `primus_devices{user_id,name,device_mac,claimed_via:'app'}` →
    mint operational key → mark `claimed`.
  - MAC already claimed by **another** user → `409
    device_claimed_by_other_account` (App shows transfer guidance).
  - same user re-claim → idempotent (rotate key; device pulls new on
    next checkin).
- **`DELETE /app/primus/:id`** — unbind (transfer/RMA): invalidate key,
  reset claim state so it can be re-claimed, **keep all history**
  (data is sensor/user-scoped, not Primus-scoped).
- **`GET /app/primus`** — user's devices `[{primus_id,name,
  mac_masked,last_seen,online,claim_state}]` for "My Devices".

**Migration (spec only — standing hold):** `primus_devices` +=
`device_mac text` (unique, nullable), `claimed_via text default
'admin'`, `claim_state text` (`unclaimed|awaiting|claimed`),
`claimed_at`, `unbound_at`. Existing admin rows keep `device_mac
NULL`, `claimed_via='admin'`, fully backward-compatible. **No
per-device secret stored** (HMAC-derived). `MASTER_KEY` added to cloud
env + the flashing tool only.

---

## 6. Lifecycle

- **Change WiFi:** short button press → `REPROVISION_WINDOW` (key
  retained; bare Mini re-advertises BLE / Connect re-opens Display
  WiFi UI). No re-claim.
- **Transfer / RMA / sell:** long hold ~10 s → full NVS wipe →
  `UNPROVISIONED`. App "Remove device" → `DELETE /app/primus/:id`.
  Either frees the device for a new owner; clean transfer does both.
- **Replace dead Mini:** claim the new one; unbind the old. History
  preserved (sensor/user-scoped) — surface this reassuringly.

---

## 7. Security / threat model

- Operational key never on BLE, never shown — minted server-side on an
  authenticated claim, pulled by the device over TLS.
- Bootstrap secret = `HMAC(MASTER_KEY, mac)`; cloud verifies by
  recompute (no secret DB). `MASTER_KEY` custody: cloud env + flashing
  tool only — **highest-value secret in the system**; never in repo/
  firmware. Rotating it invalidates all un-flashed future QR but not
  claimed devices (they hold operational keys).
- Claim requires an **authenticated user** + possession of the QR/
  pairing code → can't bind someone else's device to your account
  without both. One-time: a claimed device rejects re-claim until
  unbound/factory-reset.
- Pairing code short-lived (≈10 min) + rate-limited; `/provision/
  checkin` rate-limited per MAC; constant-time HMAC compare;
  enumeration-resistant.
- Residual: attacker who has physically seen a sticker QR of an
  *unclaimed* device could claim it first → mitigated by possession
  (they had physical access) + one-time-claim + the owner noticing at
  setup. Acceptable for the product class; same posture as before,
  stronger key handling.

---

## 8. QR / hardware notes

- QR encodes `{ mac, bootstrap_secret }`. Printed **on the unit *and*
  the box/quick-start card**. Connect additionally renders a
  short-lived code/QR on the Display.
- **RGB status LED + enclosure light-pipe** — required (approved);
  also at-a-glance health in normal operation.
- One factory-reset button, two timings: short = WiFi-reprovision
  window (key retained); long ~10 s = full wipe.
- **Manufacturing step:** flashing tool computes `HMAC(MASTER_KEY,
  mac)` per unit, writes NVS, prints the QR. One shared master key (not
  per-unit); zero cloud contact at flash time. Full process +
  master-key custody: **[`MANUFACTURING_FLASHING.md`](./MANUFACTURING_FLASHING.md)**.

— Canonical contract, Cloud session, 2026-05-18 (unified claim model)
