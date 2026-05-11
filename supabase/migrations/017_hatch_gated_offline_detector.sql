-- Migration 017 — gate the Primus-offline detector on active hatches.
--
-- Background: migration 016 added detect_offline_primus_and_queue_app_failover()
-- which scans every claimed sensor whose user has a Primus that has gone
-- silent. The product decision (2026-04-27) is that **the cloud only
-- monitors and records sensor data when the sensor is linked to an
-- active hatch**. Casual-mode sensors that aren't part of any active
-- hatch don't need failover — they aren't being recorded in the first
-- place, so there's nothing to fill in.
--
-- This migration replaces the function body so it skips sensors that
-- aren't currently in an active hatch (either via hatch_sensors OR via
-- hatch_logs.ambient_sensor_id).

create or replace function public.detect_offline_primus_and_queue_app_failover()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  v_primus_stale_threshold interval := interval '5 minutes';
  v_sensor_stale_threshold interval := interval '5 minutes';
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
       -- All this user's Primuses are stale (or none have ever reported)
       and not exists (
         select 1
           from public.primus_devices pd
          where pd.user_id = s.user_id
            and pd.last_seen is not null
            and pd.last_seen >= now() - v_primus_stale_threshold
       )
       -- NEW: only consider sensors that are linked to an active hatch.
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
       -- Don't double-queue: skip if there's already an open
       -- primus_offline request for this sensor.
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
