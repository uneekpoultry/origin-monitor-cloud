# Primus — resync flow investigation request

> Quick request: we're seeing the resync flow report success (`status=ok`)
> but with `result.readings_uploaded = 0` (or similar) for windows that
> we *know* contain real readings in the sensor's flash buffer. Need a
> quick code-level audit to confirm what's actually happening.

## What we observe

We have an active hatch (`Test Hatch`) with 4 sensors, all in BLE range
of one Primus (`Office Test Primus`). Recent history:

- **28-Apr ~13:50 UTC** (10pm AWST): Primus went offline (network issue
  or power — TBD). Sensors kept logging to their own flash.
- **29-Apr ~22:30 UTC** (06:30 AWST next day): Primus came back online,
  cloud queued auto-gap-detected requests covering the outage window.
- **A primus_commands resync was issued and completed `status=ok`** with
  `readings_uploaded` field appearing as 0 (or null).
- **Linked `sensor_resync_requests` rows** were marked
  `fulfilled_at` set, `fulfilled_count = 0`, `fulfilled_error = null`.

But when we count actual `sensor_readings` rows for the gap hours
on the cloud side:

| Hour | Density (each sensor / 60 expected per hour) |
|---|---|
| 28-Apr 23:00 UTC | 12–18 / 60 (~25%) |
| 28-Apr 00:00 UTC | 17–21 / 60 (~32%) |
| 28-Apr 02:00 UTC | 3–6 / 60 (~8%) |
| 28-Apr 05:00 UTC | 10–11 / 60 (~17%) |

So there's clearly missing data, the resync ran, the resync said "OK
zero new readings," but the data wasn't actually backfilled.

## What we need from you

A short audit (20–30 min, no fix needed yet — just diagnosis):

### 1. Phase 1 BLE history pull — does it actually reach back as far as `since`?

The cloud sends `params.since` as a Unix timestamp (seconds). The doc
section 9.3 describes Phase 1 as:

> *"For each online sensor: BLE connect → MD5 auth via FEA0 service →
> request count via `[0x03,0x00,0x00,0x01,0x02,0x00,0x00,0x00,0x00]` →
> request records `[0x03,0x00,0x00,0x02,0x02, recordId(4), maxCnt(2),
> readOpt, connItvl]` with `readOpt=0x01` (reverse, newest first)."*

Questions:

- Does the firmware honour the `since` param when deciding when to stop
  reverse-reading? Or does it use an internal default (e.g. "stop after
  reading the local mirror, don't pull deeper")?
- What's the practical max records-per-sensor it will pull in one
  resync? Is there a `maxCnt` cap that would stop early on a 36-hour
  request?
- After Phase 1, what's actually in `/hist_X.bin` for the gap window?
  Does the file contain the missing records, or did the BLE pull only
  fetch a subset?

### 2. Phase 4 upload — does it report what it actually uploaded?

The architecture doc lists this success log line:

> `[Resync] resync: pushed=N uploaded=M sensors=K win=<minutes>`

When the firmware reports `status=ok` back to the cloud in the heartbeat
`command_results` array, what `result.readings_uploaded` value does it
include? Is it:

- `M` (rows actually POSTed in `/primus/readings` batches)?
- The `inserted` count returned by the cloud (which dedup may have
  reduced to 0)?
- Something else / not populated?

Specifically: **if the Primus uploaded 200 records and the cloud
returned `inserted: 0` (all dedups), does the firmware report 200, 0,
or null in `result.readings_uploaded`?**

### 3. Phase boundaries — does Phase 4 wait for all batches to complete?

If a TLS error occurs mid-drain, does the resync abort early but still
report `status=ok`? Or does it propagate a partial-failure state?

### 4. The PSRAM ring buffer vs sensor flash

The architecture doc says the Primus has a 1000-entry PSRAM ring
buffer (~3 days of buffering). For a 36-hour resync targeting historical
data:

- Does Phase 1 read from the **sensor's BLE history characteristic**
  (deep buffer, ~1 month) — or does it short-circuit to the Primus's
  own ring buffer / SPIFFS mirror?
- If the latter and the ring buffer wraparound has already overwritten
  the gap window, the records would be permanently lost from the
  Primus's mirror — but the **sensor itself** should still have them.

### 5. Quick data point we can verify together

If you add temporary verbose logging to the next resync (or look at
existing serial logs from the most recent run), it'd tell us
immediately whether the issue is:

- **Phase 1 pull stopped early** (sensor flash has the records, Primus
  didn't read them)
- **Phase 1 pulled but Phase 4 dropped them** (mirror has them, upload
  failed silently)
- **Phase 4 uploaded but cloud dedup-rejected them** (records hitting
  the cloud, getting silently dropped due to unique-index conflict)

The third option is interesting because it'd mean the records are
already in `sensor_readings` with slightly different timestamps —
possibly from the App's pre-sensor-clock-anchor era when it stamped
live ads with phone-clock time. That'd be a real data-correctness
issue to follow up on.

## How to share findings

Just paste back to Andrew. No code changes needed yet — we want to
understand the failure mode before deciding what to fix. The
infrastructure (resync queue, claim semantics, retry logic, cloud-side
plumbing) is all working — we've validated those. This is specifically
about whether the firmware's Phase 1 + Phase 4 behaviour matches what
the cloud is assuming.

## Why this matters

Customers with serious hatches will accept "the system pulls deep
history when it reconnects" as an iron-clad guarantee. If the resync
silently reports success but doesn't backfill, support will see
recurring "my data has gaps" tickets that are hard to diagnose. We
need to know whether the current behaviour is:

- A bug we should fix (e.g. honour `since` properly)
- A known limit we should document (e.g. "Primus can backfill ~6h
  reliably, deeper requires sensor disconnect/reconnect cycle")
- A cloud-side issue (the Primus is doing the right thing but the
  cloud is incorrectly counting / reporting)

Whatever the answer, the fix follows naturally once we know.

— Claude (Cloud session)
