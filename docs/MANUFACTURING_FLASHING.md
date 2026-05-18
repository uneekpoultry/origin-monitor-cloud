# Origin Primus Mini — Manufacturing & Flashing (bootstrap key process)

> Companion to `PROVISIONING_CONTRACT.md` (§1, §5, §7, §8). Defines the
> production flashing workflow + master-key custody for the unified
> claim model. Decided 2026-05-18 (HMAC approach confirmed). The
> Primus/firmware session builds the flashing tool; Cloud owns the
> verify side.

---

## 1. The principle (read this first — common mistake)

**There is ONE master key for the entire system. It is NOT per-unit,
and NOTHING per-unit is sent to the cloud at flashing time.**

- `MASTER_KEY` = a single 256-bit random secret, generated **once**.
- Per unit: `bootstrap_secret = HMAC-SHA256(MASTER_KEY, mac)` — a
  *derived* value, unique per device because the MAC is unique.
- The cloud holds the **same** `MASTER_KEY` and *recomputes* the HMAC
  to verify any unit on demand. It keeps **no per-device secret
  table**. Manufacturing makes **zero** cloud calls.
- The cloud first learns a specific physical unit exists only when the
  **end customer** provisions it (`/provision/checkin` →
  `/app/primus/claim`), long after manufacture.

Analogy: the master key is one rubber stamp; each unit's secret is that
stamp applied to the unit's MAC. The cloud has the same stamp, so it
can check any unit without keeping a list.

---

## 2. Master key custody (security-critical)

- Generated once: 256-bit CSPRNG value. Document the generation event.
- Lives in **exactly two places**: the **cloud environment**
  (`MASTER_KEY` env var, alongside the Supabase secret) and the
  **flashing tool's local config** (operator workstation).
- **Never** in: the firmware image, the git repo, the QR, a device, a
  customer-reachable surface, logs, or the production manifest.
- Treat with the same seriousness as a code-signing key. Leak ⇒ an
  attacker could forge bootstrap secrets for **not-yet-claimed** units
  (already-claimed units hold operational keys and are unaffected).
- Rotation: possible, but invalidates the QR of any **un-flashed /
  unclaimed** future stock that used the old key. Claimed devices are
  unaffected (they run on operational keys). Rotate only with a
  deliberate batch cutover.

---

## 3. Per-unit flashing steps (the tool, built with Claude Code)

Host-side CLI on a USB flashing jig. For **each** unit:

1. **Read MAC** — factory-burned eFuse MAC via `esptool`. Canonical
   format agreed with firmware + App (byte-identical to `DEVICE_INFO`
   and the QR).
2. **Derive** `bootstrap_secret = HMAC-SHA256(MASTER_KEY, mac)`.
3. **Write NVS** — store `bootstrap_secret` in the unit's NVS
   provisioning namespace (layout owned by the firmware session).
4. **Generate QR** encoding `{ mac, bootstrap_secret }` (agreed
   payload format) → print the unit label + the box/quick-start card.
5. **Append to local production manifest** — `{ mac, flashed_at,
   operator, fw_version, hw_rev }`. **No secret in the manifest.** This
   is your QC/traceability record only; it is never uploaded.
6. **Verify** — read back NVS, re-derive, assert match; optional
   self-test. Fail → quarantine the unit, do not ship.

Batch of ~20: run sequentially, or parallel with a multi-port jig.
Fully **offline** — no network, no cloud call at any point.

---

## 4. What the cloud needs (one-time, not per unit)

- `MASTER_KEY` set in the cloud environment. That is the **entire**
  cloud-side manufacturing dependency. No per-batch import, no
  per-unit registration, no upload.
- Verification path (`POST /provision/checkin`): cloud recomputes
  `HMAC-SHA256(MASTER_KEY, mac)`, constant-time compares to the
  presented `bootstrap_secret`. (Cloud session implements on
  greenlight.)

---

## 5. Roles

- **Primus/firmware session:** builds the flashing CLI (esptool MAC
  read, HMAC, NVS write, QR generation, manifest, read-back verify) +
  defines the NVS layout + QR payload format.
- **Cloud session:** implements the verify side (`/provision/checkin`)
  + holds `MASTER_KEY` in env; never sees per-unit data.
- **Andrew / production:** master-key generation + custody; runs the
  jig; keeps the manifest; quarantines failed read-backs.

---

## 6. Acceptance

1. Tool flashes a unit fully offline; read-back re-derive matches.
2. A unit flashed with the production key passes `/provision/checkin`
   against the cloud holding the same `MASTER_KEY`; a unit flashed with
   a wrong/old key is rejected (`CLAIM_FAILED` bad-secret).
3. Manifest contains no secrets.
4. Rotating `MASTER_KEY` in env + tool: new units verify, old
   *unclaimed* QR stock no longer verifies, already-claimed devices
   keep working.

— Cloud session, 2026-05-18
