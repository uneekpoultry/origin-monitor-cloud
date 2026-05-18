# Claude Primus — START HERE (Mini / Display split kickoff)

> Hand this to the Claude Primus (firmware) session to begin. It points
> to everything else. All referenced docs are in this same `docs/`
> folder (version-controlled — repo: origin-monitor-cloud, GitHub).
> Written by the Cloud session, 2026-05-18.

---

## Read these, in this order

1. **`CLAUDE_PRIMUS_MINI_DISPLAY_SPLIT.md`** — the primary spec. The
   whole hardware split, firmware images, serial protocol, state
   machine, Year-1 hardware targets, acceptance criteria.
2. **`CLAUDE_PRIMUS_RESYNC_FIXES.md`** — the `fine_status` contract
   (Priority 1). The Mini firmware **must carry this** — the cloud is
   already deployed expecting it (backward-compatible if absent, but it
   must ship). Confirm whether the current firmware already implements
   it.
3. **`SYSTEM_ARCHITECTURE.md`** — §9 (current Primus firmware, your
   starting codebase), §9.8 (product/sourcing decision + why), §12.6 &
   §12.7 (the cloud resync contract you must conform to — already live
   in production).

You already have the current Primus firmware codebase — that is your
starting point. Nothing in the cloud needs to change for any of this.

---

## The mission (one paragraph)

Split the current tri-duty Primus (one ESP32-S3 doing WiFi + BLE-scan +
LVGL — the root of every reliability failure) into two
single-responsibility firmware images on Waveshare off-the-shelf
boards: a **headless Mini** (BLE + WiFi + cloud, ships first) and a
**Display** (LVGL UI, no WiFi, standalone or serial-client to a Mini),
joined for "Connect" by a wired UART. Year 1 is Waveshare boards, no
custom PCB.

---

## Hardware is now decided (2026-05-18, with Primus session)

| Unit | Prototype on NOW | Year-1 target (on stock arrival) |
|---|---|---|
| **Mini** | **LilyGo T-Display S3** | **Waveshare ESP32-S3-DEV-KIT-N16R8-U** (SKU 34549) — single S3, **no C3**, ext antenna, 8 MB PSRAM |
| **Display** | **current 4.3" Waveshare** | **Waveshare ESP32-S3-LCD-5** (SKU 30321), 800×480 |

Put all board deltas behind a thin **board-config/HAL layer** (pin map,
panel driver, antenna, touch controller) so prototype→target is a
config swap, not a rewrite.

## DO THIS FIRST — resolve before writing code

1. **C3 is gone in Year 1.** Both Mini boards (prototype + target) are
   single ESP32-S3 — **no C3 co-processor.** The Mini does BLE
   **directly on the S3** (reuse the existing `bleTask`/NimBLE path).
   So the **C3 history rework is throwaway for what ships.** Confirm,
   **stop the C3-path work**, and report what (if anything) from it is
   still reusable on the S3 BLE path.
2. **Display panel — order the right variant.** SKU 30321 is the same
   Waveshare family as the current 4.3" board (same S3 / RGB panel /
   GT911 / toolchain), just larger → incremental port, low risk. The
   only check: the 5" ships **800×480 *or* 1024×600 — order 800×480**
   (pixel count, not the board, drives the §9.3 tearing). Also confirm
   the variant includes touch (the UI is fully touch-driven).

Do not start Phase 1 until #1 is settled. #2 is just an order-time
variant check — it doesn't block Phase 1.

---

## Phase order (after Phase 0)

| Phase | Work | Nature |
|---|---|---|
| **1 — Mini** (priority, ships first) | Strip the entire LVGL/display layer from the **pre-C3 baseline** firmware → headless node on Waveshare **DEV-KIT-N16R8-U** + external antenna. Keep NimBLE scan, ring buffer, full cloud cycle, `fine_status`, TLS. | Mostly **deletion** + board bring-up — fast, low-risk |
| **2 — Display** | Waveshare ESP32-S3-Touch-LCD-5 **@ 800×480** (NOT 1024×600 — keeps the PSRAM-bus tearing mitigation valid; treat as a 4.3→5in port at the *same* resolution). Two modes (standalone BLE / serial-client), mode-detect state machine, one-reader invariant, locked-but-visible upgrade UX. | Greenfield UI, no networking |
| **3 — Serial / Connect** | Mini↔Display UART. You own pins / baud / framing / paging. | Small, self-contained |

---

## What the cloud guarantees you

- **The cloud contract is stable and deployed.** Heartbeat, readings,
  sensors, hatches, resync, settings-sync, `fine_status` mapping
  (§12.6), circuit breaker (§12.7) are all live. The Mini presents to
  the cloud exactly as today's Primus. No coordinated cloud release is
  needed for any phase of this work.
- The circuit breaker + `fine_status` honesty are your safety net while
  reliability stabilises — but a dedicated Mini with no display
  stealing the radios should fix the resync contention at the root.

## What we need back from you (first reply)

1. Phase 0 answer — C3 topology confirmed; is the C3 rework throwaway
   for Year 1? What (if anything) is still reusable?
2. Current status of Priority 1 (`fine_status`) in the firmware.
3. A short phase-1 plan + the open serial-protocol choices you'll own.

— Claude (Cloud session)
