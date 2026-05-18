# Primus — resync flow fixes (implementation spec)

> Follow-up to your audit findings. Three bug fixes, in priority order.
> Cloud-side coordination noted at the end of each so we can land the
> matching changes together. None are urgent enough to interrupt other
> work, but #1 should land before any production rollout to
> non-Andrew customers — silent "ok" with no data looks like data loss
> to a serious hatcher and is hard to support without honest signals.

## Priority 1 — Honest status reporting

**The problem:** today, `cmd_queue_result(cmd_id, "ok", ...)` is hardcoded
regardless of whether the resync actually achieved anything. Three
genuinely different outcomes all collapse to the same `ok`:

- **Genuine no-op** — window already covered, BLE pull found nothing
  newer than `since_ts`. Fine, expected.
- **Partial drain** — Phase 1 pulled records, Phase 4 broke mid-batch
  (TLS error, OOM, whatever). Records lost, cloud has no signal.
- **Phase 4 skipped** — WiFi didn't reconnect after Phase 3, or API
  key empty. Whole resync was a no-op for non-data reasons.

The cloud's gap-detection density-check tries to backstop this, but it
runs over a 72-hour aggregate so per-hour gaps slip through. We need
the firmware to be honest about what happened.

### Firmware change

Track three things during the resync flow:

```cpp
int      phase1_pushed = 0;          // records pushed into ring buffer
                                     // (after since_ts filter applied)
int      phase4_drained = 0;         // records actually POSTed
bool     phase4_aborted_mid_batch = false;
const char* skip_reason = nullptr;   // null = Phase 4 ran. Otherwise:
                                     // "wifi_not_connected"
                                     // "api_key_empty"
```

> **Enum correction (2026-05-18, confirmed with Primus session):**
> `no_records_in_buffer` is **removed** from `skip_reason`. An empty
> ring buffer is **not a skip** — it maps to `fine_status: "no_data"`
> (the `phase1_pushed == 0` branch below), which the deployed cloud
> handler treats as a clean fulfilled-with-zero: no retry, no
> `primus_events` warn. Mapping empty→`skipped` would trigger pointless
> retries and false support warnings for a sensor that simply had
> nothing new. The derivation order below already yields the correct
> result once empty no longer sets `skip_reason`.

At the end of the resync (after Phase 5 cleanup), derive a `fine_status`:

```cpp
const char* fine_status;
if (skip_reason != nullptr) {
  fine_status = "skipped";
} else if (phase1_pushed == 0) {
  fine_status = "no_data";
} else if (phase4_aborted_mid_batch) {
  fine_status = "partial";
} else {
  fine_status = "ok";
}
```

**Important:** the top-level `status` field in `cmd_queue_result(cmd_id,
status, ...)` should still be `"ok"` for everything except a hard error
(e.g. couldn't even parse the cloud's command). Keep that binary as it
is — the schema in `api/src/routes/primus.ts` only accepts `"ok"` or
`"error"` and we don't want to change that contract. The richer
`fine_status` lives **inside the result JSON**.

### Result payload

Replace the current single-line snprintf with a richer JSON:

```json
{
  "fine_status": "ok",                // or partial / no_data / skipped
  "skip_reason": null,                // or "wifi_not_connected" etc — only when skipped
  "readings_pulled": 482,             // Phase 1 records pushed (after since_ts filter)
  "readings_posted": 482,             // Phase 4 records actually POSTed
  "readings_inserted": 12,            // see Priority 2 — leave as null until that ships
  "sensors_queried": 4,
  "window_start": 1714377600,
  "window_end": 1714464000
}
```

Keep `readings_uploaded` populated as `readings_posted` for one
release as a backward-compat alias, then drop it.

### Cloud-side coordination

I'll update the heartbeat handler to read `fine_status` if present
and fall back to `r.status === "ok" ? "ok" : "skipped"` if not (so the
new firmware can ship without a coordinated cloud release). Behaviour
per fine_status:

| fine_status | Cloud action |
|---|---|
| `ok` | Mark linked `sensor_resync_requests` rows fulfilled. Trigger 72h density check (existing logic). |
| `partial` | Mark linked rows with `fulfilled_error = "primus_partial_drain"`. The retry sweep will re-queue automatically. |
| `no_data` | Mark linked rows fulfilled with `fulfilled_count = 0`. No retry — the Primus correctly observed there was nothing to pull. |
| `skipped` | Mark linked rows with `fulfilled_error = "primus_skipped:{skip_reason}"`. Retry sweep handles re-queue with backoff. Also raise a `primus_events` warn so support sees recurring skip patterns. |

### Acceptance criteria

- A resync where Phase 1 pulls 0 records reports `fine_status: "no_data"`, not `ok`.
- A resync where Phase 4 breaks at batch 3 of 5 reports `fine_status: "partial"` with `readings_posted` reflecting batches 1-2 only.
- A resync where WiFi failed to reconnect at Phase 3 reports `fine_status: "skipped"` with `skip_reason: "wifi_not_connected"` and `readings_pulled: 0`, `readings_posted: 0`.
- All four scenarios still return HTTP 200 from the heartbeat (no protocol-level error).
- Backward compat: cloud-side handlers without the new logic still see `readings_uploaded` populated and behave as before.

---

## Priority 2 — Inspect cloud response body

**The problem:** today the firmware only checks the HTTP status code on
`/primus/readings` POST. The cloud already returns
`{ ok, accepted, inserted, duplicates, live_only, pending_created,
skipped }` in the response body. Without parsing it, the firmware
can't distinguish:

- "We sent 200, cloud stored 200" — great, real data delivered.
- "We sent 200, cloud stored 0 (all duplicates)" — fine, idempotent.
- "We sent 200, cloud accepted but stored 0 due to error" — needs
  investigation.

Distinguishing these matters for support diagnostics — the support bot
needs to know "did our last resync actually backfill anything new" vs
"did it just confirm the dedup index is doing its job."

### Firmware change

After each `/primus/readings` POST that returns 200:

1. Parse the response body as JSON. If parse fails, treat
   `inserted = unknown` for that batch.
2. Sum `inserted` across all batches into `phase4_inserted_total`.
3. Sum `duplicates` (or compute `accepted - inserted`) into
   `phase4_duplicates_total`.

The Primus already includes ArduinoJson (or similar) for parsing
heartbeat responses — re-use the same parser. Keep the JSON parse
robust: a malformed response body shouldn't fail the resync; just leave
`readings_inserted` as `null` in the result payload for that case.

### Result payload (extends Priority 1)

```json
{
  "fine_status": "ok",
  "readings_pulled": 482,
  "readings_posted": 482,
  "readings_inserted": 12,            // NEW — sum of cloud's `inserted`
  "readings_duplicates": 470,         // NEW — sum of cloud's `duplicates`
  ...
}
```

### Cloud-side coordination

No cloud change needed — the response body already returns
`accepted / inserted / duplicates`. I'll update the heartbeat handler
to use `readings_inserted` (when present) for `fulfilled_count` instead
of `readings_uploaded`, so admin events show the *actual stored*
count rather than the *attempted* count. More honest.

### Acceptance criteria

- A resync where every record was a duplicate reports
  `readings_pulled > 0`, `readings_posted > 0`, `readings_inserted: 0`,
  `readings_duplicates > 0`. (`fine_status` should be `ok` — it's a
  successful idempotent no-op, not a failure.)
- A resync where 60% landed and 40% were duplicates shows the proper
  split.
- If the JSON parse of the response body fails, the resync still
  completes; just `readings_inserted: null` in the result.

---

## Priority 3 — Honour `since_ts` in the BLE pull

**The problem:** today the BLE pull always issues `dlCount = min(totalCount, 2000)`
records reverse-from-newest. The post-pull filter discards anything
older than `since_ts`. Two consequences:

- **Wasted BLE airtime** when `totalCount` is large but the actual
  window is small (e.g. 33 hours of data needed but the sensor's flash
  has 30 days = 60K records — pull 2000 newest then discard half).
- **Capped-out coverage** if the actual outage window > 33 hours at
  1/min logging — oldest 33h-to-window-edge records lost because the
  pull only fetched 2000 newest.

For Andrew's typical use (1-min logging, 32-hour outage), neither bites
hard today. For 5-min logging it's a non-issue (~166h coverage). For
future sensors that log faster (or for genuinely long outages), this
matters.

### Firmware change

After issuing the count read and before the records read, decide:

```cpp
const uint32_t MAX_BATCH = 2000;
uint32_t total_to_pull = totalCount;
uint32_t start_id = 0xFFFFFFFF;          // newest

while (records_received < total_to_pull) {
  uint32_t batch_size = min(MAX_BATCH, total_to_pull - records_received);

  // existing read-records command, but use start_id from the previous
  // batch's oldest received record id (decremented appropriately)
  do_records_read(start_id, batch_size, /*reverse=*/0x01);

  // After parsing, check the oldest record's UTC stamp:
  uint32_t oldest_utc = bh.entries[bh.count - 1].timestamp;
  if (oldest_utc < since_ts) {
    // We've reached records older than the window — stop
    break;
  }

  // Otherwise, prep next batch
  start_id = bh.entries[bh.count - 1].record_id - 1;
}
```

Two practical notes:

- The KBeacon record-read command's `recordId` field is what advances
  pagination. Confirm whether it accepts arbitrary record IDs or only
  sentinels — if only sentinels, we'd need to use the last-received
  record ID as the new "newest" marker.
- The first iteration should still use `0xFFFFFFFF` as the sentinel
  for "newest" so existing behaviour is preserved when the window is
  fully covered by the first 2000 records.

### Cloud-side coordination

None. The cloud already passes `since_ts` (`params.since` as Unix
seconds) and just consumes whatever the Primus returns. This is a
firmware-internal optimization.

### Acceptance criteria

- For a 24-hour window where the sensor's flash holds 30 days of data:
  resync pulls roughly 1440 records (24h × 60), not 2000.
- For a 60-hour outage at 1/min logging: resync pulls roughly 3600
  records (60h × 60) across multiple batches, not capped at 2000.
- For a 5-minute window: resync pulls roughly 5 records, not 2000.
- BLE airtime per resync should drop measurably for typical workloads.

---

## Suggested implementation order

1. **Priority 1 first** — bigger value, smaller code change. The
   bookkeeping for `phase1_pushed`, `phase4_drained`, and
   `phase4_aborted_mid_batch` is mostly additive — sprinkle counters
   through the existing flow, derive `fine_status` at the end, build
   the JSON.
2. **Priority 2 alongside #1** — fits naturally into the same result
   payload and only requires a JSON parse on responses you're already
   receiving.
3. **Priority 3 separately** — bigger code change (paginated reverse
   reads), real benefit but lower priority.

## Cloud-side timing

I'll wait until you say "Priority 1 is in firmware" before I update
the heartbeat handler, so we don't have a window where the cloud
expects fields that aren't being sent. Send a quick ping when each
priority is built and on a Primus.

## What we're NOT changing

- The atomic claim semantics on `sensor_resync_requests`
- The `primus_commands` queue and dispatch
- The heartbeat protocol shape (top-level `status: "ok" | "error"`)
- The cloud-side opportunistic backlog logic (already deployed)
- The cloud-side retry / cooldown / cap policies

## Other findings from the audit, not in scope here

- **Battery-field handling.** When a BLE advertisement omits the
  battery field (sensor_mask byte doesn't include it), the firmware
  currently reports `0` to the cloud, which causes false "Low battery"
  events. Fix: send `null` (or omit the field entirely from the
  reading). Quick win, separate from the resync work — handle whenever
  convenient.

- **App reliability.** During an experiment yesterday we queued fresh
  `sensor_resync_requests` rows; the App didn't claim any in the
  2-minute window, so the cloud's opportunistic-backlog logic queued
  the Primus to fulfil instead. The Primus did the right thing. The
  App-side issue is for the App session — flagging here so you know
  the audit holds up well in production: even when the App fails to
  claim, the Primus catches the work.

— Claude (Cloud session)
