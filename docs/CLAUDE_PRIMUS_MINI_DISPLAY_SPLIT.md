# Primus — hardware split into Mini + Display (firmware brief)

> Decided 2026-05-18 (Andrew + Cloud session). This replaces the
> single tri-duty Primus with two single-responsibility units joined
> by a wired serial link. Canonical record: `SYSTEM_ARCHITECTURE.md`
> §9.8. This brief is the firmware-side action plan for the Primus
> session. **Cloud contract does not change** — read §"Cloud impact".

---

## Why

Every hard reliability failure we've fought — display tearing, resync
stalls, the C3-comms history rework you're doing now, TLS-warmup and
deferred-heartbeat hacks — traces to **one ESP32-S3 doing WiFi +
BLE-scan + LVGL simultaneously**. The hardware fix (custom dual-ESP
board) was quoted too high to commit pre-revenue.

So we split the jobs across separate single-purpose units. Each radio
job on exactly one chip. This *is* the dual-ESP design, shipped as
modular products instead of one NRE-heavy PCB.

---

## The two firmware images

| Image | Runs on | Responsibility | Roughly |
|---|---|---|---|
| **Mini firmware** | Origin Primus Mini | BLE scan sensors + WiFi + full cloud cycle (heartbeat / readings / sensors / hatches / resync / settings sync). **No display code.** | ≈ today's Primus firmware with the entire LVGL/UI layer removed + a serial-server module added |
| **Display firmware** | Origin Primus Display | LVGL UI, graphs, sensor rendering. Two modes: standalone BLE-listener, or serial-client to a Mini. **No WiFi stack at all.** | Greenfield UI + serial-client + BLE-listener fallback |

`Origin Primus Connect` = a Display with a Mini clipped on the back via
the cable. No third firmware. The Mini firmware is the priority — it
reuses 100% of the hardened cloud stack and alone unlocks the whole app
value. Ship the Mini first.

---

## The link: wired UART, in-enclosure

- **Physical:** short captive cable inside the Connect enclosure.
  Pins/connector: **Primus session to choose** (suggest a spare UART,
  e.g. UART1 TX/RX + GND, plus a power rail so a wall-mounted Connect
  is one cord).
- **Baud / framing:** Primus session to choose. Suggest 115200 8N1,
  length-prefixed frames with a type byte + CRC8/CRC16. Keep it dumb
  and robust; this is a 30 cm wire, not a network.
- **No RF on this path** — that is the entire point. Do not be tempted
  to make this BLE.

---

## Serial protocol (suggested shape — Primus session owns the detail)

**Mini → Display** (Mini is the authority):

- `HELLO/CAPS` — Mini announces presence + firmware version + sensor
  count (drives the Display's mode detection).
- `SENSOR_SNAPSHOT` — periodic: per-sensor calibrated temp/humidity,
  battery, RSSI, online flag, ambient flag, identity colour, name.
- `SETTINGS` — per-sensor calibration offsets + alert thresholds +
  enabled flags (the global settings the cloud already syncs).
- `ALERT_STATE` — active alarms (so the Display can render the alert
  overlay) — the Mini owns alarm evaluation.
- `HISTORY_PAGE` — paged history for the graph screens, in response to
  a Display request (Mini can serve cloud-backed history, far richer
  than a standalone Display's local buffer).
- `CLOUD_STATUS` — WiFi/cloud connection state (drives the Display's
  cloud icon + the unlock state).

**Display → Mini:**

- `HELLO_ACK` — handshake completion.
- `CONFIG_WRITE` — user changed a calibration offset / threshold on the
  screen → Mini applies it and syncs to cloud via the existing
  settings-sync path (no new cloud contract).
- `HISTORY_REQ` — request a history page/range for a sensor.
- `PING/PONG` — liveness so the Display can detect Mini removal fast.

---

## Mode-detection state machine (Display firmware)

The **cable is the unlock** — no licence, no feature flag, no cloud
check. Capability is emergent from the data source, so it degrades
gracefully.

```
boot → LISTEN_FOR_MINI (open UART, wait for HELLO, ~2s timeout)
   ├─ HELLO received ───────────► CONNECTED
   └─ timeout / no HELLO ───────► STANDALONE

STANDALONE:
   - start own BLE scan, render live sensor values
   - local short history only; no calibration; no cloud
   - cloud-dependent UI shown GREYED + lock badge
   - keep polling UART for a late HELLO (hot-plug a Mini)

CONNECTED:
   - STOP / never-start own BLE scan  ◄── THE INVARIANT
   - render from Mini's SENSOR_SNAPSHOT (calibrated, authoritative)
   - cloud features UNLOCKED; show "Connected" payoff confirmation once
   - on PING timeout / Mini removed → fall back to STANDALONE cleanly
```

> **The one invariant:** in CONNECTED mode the Display must **not** run
> its own BLE scan. The Mini is the sole reader. Never two readers at
> once — exact same reader-arbitration principle as the cloud-side
> circuit breaker. Two listeners → "slightly different numbers" support
> nightmares.

---

## Upgrade UX — locked-but-visible (deliberate, do it well)

The greyed-out cloud features are the **primary upsell mechanic**, not
an afterthought. Requirements:

- **Honest locks only.** Lock *only* what genuinely needs the Mini
  (cloud history, phone access, remote alerts). Never artificially
  cripple anything the Display can do alone.
- **Basics never locked.** Live values, on-device alarms, basic local
  trend fully work standalone — the Display must feel complete on its
  own.
- **Show, don't nag.** Greyed control + a small lock + one calm line
  ("Add a Primus Mini to unlock cloud history & phone alerts"). One
  discoverable "Unlock with Primus Mini" info screen. **No popups on
  every tap.**
- **Payoff moment.** On Mini detection, light up the greyed features +
  show a brief "Connected — cloud history & alerts unlocked". This is
  the conversion reward; make it feel good.

---

## Cloud impact: NONE

The cloud only ever talks to the **Mini**, which presents to the cloud
exactly as today's Primus does — same endpoints, same auth, same
heartbeat/readings/resync/settings/fine_status/circuit-breaker
behaviour. The Display is invisible to the cloud. No migration, no
endpoint change, no schema change. (Optional future nicety: Mini could
report `display_attached: true` as support telemetry — not required,
flag it if cheap.)

When the Mini runs on dedicated hardware with no LVGL stealing the
radios, the BLE/WiFi contention that broke resync should largely
vanish at the root — the resync reliability work + circuit breaker
stay as the safety net, but the disease itself goes away.

---

## Open items for the Primus session to decide

1. UART pins/connector + whether the cable also carries power.
2. Baud + frame format (length prefix, type byte, CRC width).
3. `SENSOR_SNAPSHOT` cadence + `HISTORY_PAGE` page size (BLE history is
   30K–37K records — page it sensibly over the wire).
4. Handshake/HELLO cadence + PING timeout for fast Mini-removal
   detection.
5. Build system: one repo, two PlatformIO `env:`s (env:mini /
   env:display) sharing the sensor/BLE + cloud libs, or two trees.
   Recommend shared repo, shared libs, two envs — the sensor parsing +
   cloud client are common to Mini; the BLE-listener is common to both.

## Acceptance criteria

1. Mini firmware boots with **no display code**, completes a full
   cloud cycle, passes the existing Primus smoke tests unchanged.
2. Display in STANDALONE shows live BLE sensor values with cloud
   features greyed + lock badges; no crash on no-Mini.
3. Hot-plug a Mini → Display transitions to CONNECTED within ~2 s,
   parks its own BLE, renders calibrated values from the serial feed,
   shows the unlock payoff once.
4. Unplug the Mini → Display falls back to STANDALONE cleanly (no
   brick, no nag), re-greys cloud features.
5. A threshold edited on the Display screen in CONNECTED mode reaches
   the cloud via the Mini's existing settings-sync path (verify the
   cloud row updates — no new cloud code involved).
6. In CONNECTED mode the Display is verified to run **zero** BLE scans
   (the invariant) — single reader only.

— Claude (Cloud session)
