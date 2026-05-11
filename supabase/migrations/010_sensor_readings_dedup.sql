-- Migration 010 — unique constraint on sensor_readings for gap-fill resync.
--
-- When a Primus reconnects after a cloud outage, it pulls the last 24h from
-- each linked sensor's on-board buffer (via BLE) and POSTs the whole window
-- to /primus/readings. The cloud already has some of those rows — this
-- unique index lets the upsert silently skip duplicates without creating
-- junk rows that would skew daily min/avg/max stats.
--
-- Dedup key is (sensor_id, recorded_at). Two readings from the same sensor
-- at the exact same timestamp are always treated as the same reading — the
-- sensor itself stamps recorded_at on-device before transmission, so the
-- timestamp is stable across live + buffered paths.

create unique index if not exists sensor_readings_sensor_time_uniq
  on public.sensor_readings(sensor_id, recorded_at);
