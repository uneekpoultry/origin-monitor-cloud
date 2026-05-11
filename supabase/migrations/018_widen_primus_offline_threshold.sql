-- Migration 018 — widen Primus offline detector threshold to 15 min.
--
-- Background: as of 2026-05-01 the Primus heartbeat cadence widened
-- from 60s to up to 10 min. The cause was BLE-scanning PSRAM contention
-- on the ESP32-S3 + 4.3" RGB LCD hardware: BLE active scan windows
-- contend with the bounce-fill DMA for OPI PSRAM bandwidth, causing
-- visible display tearing. Each cloud cycle pauses BLE while it runs,
-- so reducing cycle frequency from 1/min to 1/10min minimises how often
-- the user sees the artifact.
--
-- The detect_offline_primus_and_queue_app_failover() function added in
-- migration 016 used a 5-minute stale threshold. With 10-minute
-- heartbeat cadence, every Primus would appear "offline" between
-- cycles and the function would constantly queue primus_offline
-- resync requests for sensors that are perfectly fine.
--
-- This migration replaces the function body with a 15-minute threshold:
-- only trigger app-failover if the Primus has missed 1.5 cycles. That's
-- conservative enough to ride out a slow heartbeat (Primus may take
-- ~3-4 sec for the cycle itself) without false-positive failover.

create or replace function public.detect_offline_primus_and_queue_app_failover()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  -- Widened from 5 min (migration 016) to 15 min to accommodate the
  -- new ~10 min Primus heartbeat cadence. App-failover should only
  -- fire if the Primus has truly gone silent — not during the normal
  -- gap between cycles.
  v_primus_stale_threshold interval := interval '15 minutes';
  -- Sensor stale threshold also widened. With 10-min upload cadence,
  -- sensors.last_seen oscillates between 0 and 10 min stale. 15 min
  -- gives margin without over-triggering.
  v_sensor_stale_threshold interval := interval '15 minutes';
  r record;
begin
  for r in
    select s.id as sensor_id, s.user_id
      from public.sensors s
     where s.claimed_at is not null
       and s.last_seen is not null
       and s.last_seen < now() - v_sensor_stale_threshold
       and exists (
         select 1
           from public.primus_devices pd
          where pd.user_id = s.user_id
       )
       and not exists (
         select 1
           from public.primus_devices pd
          where pd.user_id = s.user_id
            and pd.last_seen is not null
            and pd.last_seen >= now() - v_primus_stale_threshold
       )
       -- Only consider sensors that are linked to an active hatch.
       -- Sensors not in any active hatch are casual-mode; they don't
       -- need failover because the cloud isn't recording them anyway.
       and (
         exists (
           select 1
             from public.hatch_sensors hs
             join public.hatch_logs hl on hl.id = hs.hatch_id
            where hs.sensor_id = s.id
              and hl.user_id = s.user_id
              and hl.status = 'active'
         )
         or exists (
           select 1
             from public.hatch_logs hl
            where hl.ambient_sensor_id = s.id
              and hl.user_id = s.user_id
              and hl.status = 'active'
         )
       )
       and not exists (
         select 1
           from public.sensor_resync_requests rr
          where rr.sensor_id = s.id
            and rr.reason = 'primus_offline'
            and rr.claimed_at is null
            and rr.fulfilled_at is null
            and rr.cancelled_at is null
            and rr.expires_at > now()
       )
  loop
    insert into public.sensor_resync_requests (
      sensor_id, user_id, range_start, range_end, reason
    ) values (
      r.sensor_id, r.user_id,
      now() - interval '24 hours',
      now(),
      'primus_offline'
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
