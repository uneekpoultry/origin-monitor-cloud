# Cloud reading retention — keep 30 days for every sensor

> **From the App session, 2026-05-03.** Andrew opened the cloud
> history view for an Origin Pro that retains ~4 days of data on its
> own flash, expecting at least that much in the cloud — and saw
> only ~2 days. The cloud should be the long-term store, but
> readings are aging out faster than the device's local buffer.
> Please keep at least 30 days for every sensor that's still
> claimed by a profile, whether or not it's actively in a hatch.

---

## 1. Ask

For every row in `sensor_readings` whose `sensor_id` references a
`sensors` row that:

- has a non-null `claimed_by` (i.e. someone owns it), and
- has not been deleted,

retain the row for **at least 30 days** from `recorded_at`. Only
purge rows older than 30 days. Apply this regardless of whether the
sensor is currently linked to a hatch — Andrew's users browse cloud
history for sensors that aren't on a hatch right now (off-season,
between batches, or just to spot-check a unit), so a hatch-link is
the wrong gate.

Per-sensor estimated cost: a sensor uploading every 60 s produces
1,440 rows/day → 43,200 rows / 30 days. Each row is ~80 bytes
(uuid + timestamp + two numerics + battery_mv) → ~3.5 MB per
sensor over 30 days. For a thousand sensors that's ~3.5 GB —
very modest, well under any reasonable Postgres tier.

---

## 2. What's there now (best guess)

The 2-day cap suggests one of:

- A retention job purging on a 2-day window (cron / pg_cron).
- A trigger on `sensor_readings` that deletes older rows on insert.
- A view named `sensor_readings` that's actually a window over a
  partitioned hot table, where the older partition has been dropped.
- An RLS policy that hides rows older than N days (less likely but
  worth ruling out — try a service-role query for the same sensor
  and see if the tail comes back).

Please check, identify which of these is the cause, and adjust to
30 days.

---

## 3. Acceptance

After the change:

1. For a sensor that has been uploading continuously, a query for
   `sensor_readings` filtered by `sensor_id = X AND recorded_at >=
   now() - interval '30 days'` returns rows spread across the full
   30 days (not just the last 2).
2. The cloud-history view in the app — opened on a sensor with no
   hatch link — shows readings going back at least to 30 days ago
   when the user picks the **30 d** window chip.

---

## 4. Future-proofing

If you'd prefer a partitioned + roll-off design (daily partitions,
drop the 31st day), that's fine — the app doesn't care about the
storage shape, only that 30 days is queryable. If you do partition,
keep the table name `sensor_readings` (the app's queries are
keyed on it).

Out of scope for this request: aggregated summaries (daily min/max
rollups) for older data. Worth discussing later if the row count
ever gets uncomfortable, but at current scale raw retention is fine.
