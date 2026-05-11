-- Migration 014 — auto-update sensors.last_seen on every reading INSERT.
--
-- Background: sensors.last_seen drives the dashboard "Live" green dot
-- and the cloud auto gap-detect logic. Until now, only the Primus's
-- /primus/readings API endpoint refreshed it (as a server-side side
-- effect after the insert).
--
-- The Origin Monitor mobile app uploads readings via direct Supabase
-- INSERT (RLS-permitted), which bypasses the server-side hook — so
-- app-only sensors showed as "offline" on the dashboard despite
-- actively reporting. This trigger makes last_seen update automatic
-- regardless of which reader inserted the row, matching the
-- "any reader can write" architecture in docs/ARCHITECTURE_SYNC.md.
--
-- Only updates if the new reading is newer than the current last_seen
-- (avoids back-dating from gap-fill resyncs that upload historical data).

create or replace function public.bump_sensor_last_seen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.sensors
     set last_seen = new.recorded_at
   where id = new.sensor_id
     and (last_seen is null or last_seen < new.recorded_at);
  return new;
end;
$$;

drop trigger if exists trg_sensor_readings_bump_last_seen
  on public.sensor_readings;

create trigger trg_sensor_readings_bump_last_seen
  after insert on public.sensor_readings
  for each row
  execute function public.bump_sensor_last_seen();

-- Also retroactively fix any sensors whose last_seen is currently behind
-- the latest reading on record (should be a no-op going forward, but
-- catches existing stale rows from before this migration).
update public.sensors s
   set last_seen = latest.max_recorded_at
  from (
    select sensor_id, max(recorded_at) as max_recorded_at
      from public.sensor_readings
     group by sensor_id
  ) as latest
 where latest.sensor_id = s.id
   and (s.last_seen is null or s.last_seen < latest.max_recorded_at);
