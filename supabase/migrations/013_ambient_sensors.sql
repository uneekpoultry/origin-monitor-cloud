-- Migration 013 — ambient / room-temperature sensors.
--
-- A sensor can be flagged as "ambient" (room/environment) instead of being
-- inside an incubator. Ambient sensors:
--   * live on the same sensors table, no schema split
--   * are NOT linked to hatches via hatch_sensors (they're separate)
--   * are NOT folded into hatch temp/humidity aggregates (would poison the
--     averages — 20°C ambient mixed with 37.5°C incubator is meaningless)
--   * can optionally be referenced BY a hatch via hatch_logs.ambient_sensor_id
--     so the hatch report shows "Room Temp" alongside incubator conditions
--
-- One ambient sensor can be referenced by many hatches (e.g. several
-- incubators in the same shed). Many-to-one, nullable.

alter table public.sensors
  add column if not exists is_ambient boolean not null default false;

create index if not exists sensors_ambient_idx
  on public.sensors(user_id)
  where is_ambient = true;

alter table public.hatch_logs
  add column if not exists ambient_sensor_id uuid
    references public.sensors(id) on delete set null;

-- Index the FK so the hatch page's lookup is fast.
create index if not exists hatch_logs_ambient_sensor_idx
  on public.hatch_logs(ambient_sensor_id)
  where ambient_sensor_id is not null;

-- Note: the referenced sensor doesn't HAVE to be is_ambient=true (customer
-- might label an incubator sensor as ambient temporarily). Enforcement is
-- soft — the UI filters the "ambient sensor" dropdown to is_ambient=true,
-- and warns if an out-of-spec sensor is already linked, but the DB allows
-- it for flexibility.
