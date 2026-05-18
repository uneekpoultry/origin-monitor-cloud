# Claude App — Mini/Display split: what changes for you (almost nothing)

> Relay brief, Cloud session, 2026-05-18. Context: the Primus hardware
> is being split into **Origin Primus Mini** (BLE+WiFi+cloud, no
> screen), **Origin Primus Display** (screen, no WiFi), and **Origin
> Primus Connect** (both, joined by a local cable). Full spec:
> `SYSTEM_ARCHITECTURE.md §9.8`. This doc is only the App impact.

---

## TL;DR

**The split is invisible to the App. No new entities, no model
change, no migration, no new screens.** One small copy audit. One
roadmap note. That's it.

---

## Why there's no App work

The defining fact: **the cloud only ever talks to the Mini. The
Display never touches the cloud.** The App talks to the cloud (and to
sensors over BLE as the failover reader) — it never talks to a Mini or
Display directly.

Consequences:

1. **The Mini *is* the Primus, to the cloud and to you.** It presents
   to the cloud identically to today's Primus (same `primus_devices`,
   same heartbeat, same everything). Your existing **Origin Primus
   dashboard/status works unchanged** against it. Do **not** create a
   separate "Mini" entity — it's the same Primus you already model.
2. **You cannot represent the Display at all.** It has no WiFi, no
   cloud record, no telemetry. The App has **zero data source** for it.
   Do **not** add an "Origin Primus Display" icon/status — it would be
   a permanently-"unknown" dead element. (Same principle as honest
   locked-features: never build UI the data can't support.)
3. **Keep the single "Origin Primus" label.** Not "Origin Primus
   Mini". It's the locked family name and it stays accurate in every
   configuration. Critically, **the App cannot distinguish a bare Mini
   from a full Connect** (the Display is cloud-invisible), so a "Mini"
   label would mislabel a Connect. "Origin Primus [online/offline]"
   correctly means "your cloud-bridge device is up" in all cases.

The failover model is unaffected: the Mini is still just "the Primus"
in reader arbitration. A dedicated, screenless Mini is a *more
reliable* workhorse (no display contention), which only strengthens
the existing model — no logic change.

---

## The one real task: copy audit

Search App copy for anything that assumes the Primus has a screen —
e.g. "check your Primus screen", "tap on the Primus", instructions
that reference the on-device UI. A bare **Mini has no screen**. Soften
/ make screen-agnostic. Small but real — a Mini-only customer should
never be told to look at a screen they don't have.

---

## Roadmap note — do NOT build now

Later we will add `display_attached` telemetry (the Mini reporting
whether a Display is connected — the Connect-attach signal that feeds
the upgrade-funnel / business model). When that ships as its own
coordinated feature (cloud column + portal + firmware field + a small
App detail like "Display attached ✓" under the Primus status), it'll
be specced properly. **Until then, build no speculative Display UI** —
the App has no way to know a Display exists in Phase 1.

---

## Net

No App deliverable for the split itself beyond the copy audit. The
existing pending App briefs (stop-hatch, local-notification toggle,
global-settings schema, failover model) are unaffected and proceed
independently.

— Claude (Cloud session)
