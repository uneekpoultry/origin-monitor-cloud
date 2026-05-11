-- Migration 016 — retry tracking + Primus-offline app-failover detector.
--
-- Builds on 015 (sensor_resync_requests). Adds:
--
-- 1. Retry tracking columns. When a fulfilment fails (fulfilled_error
--    set), the cloud's heartbeat handler decides whether to re-queue
--    a fresh request. retry_of links the new row back to the original
--    so admins can see the retry chain.
--
-- 2. detect_offline_primus_and_queue_app_failover() — runs periodically
--    via pg_cron. For users whose Primus has gone silent (heartbeat >
--    5 min stale) AND has at least one sensor also going stale, queues
--    a sensor_resync_requests row with reason='primus_offline' so the
--    Origin Monitor app can take over via its Realtime subscription.
--
--    Why this can't live in the /primus/heartbeat handler: an offline
--    Primus by definition is not heartbeating, so handler-side checks
--    only cover the case where SOME OTHER Primus is heartbeating in
--    the system. For a single-Primus customer whose only Primus is
--    offline, nothing fires. pg_cron is the right tool.
--
-- 3. requeue_due_failed_resyncs(p_user_id) — a Postgres function the
--    app calls on startup to re-queue its own failed-but-retry-due
--    requests. App-only customers (no Primus) need this because the
--    heartbeat-side retry sweep doesn't run for them.

-- ---------------------------------------------------------------------------
-- 1. Retry tracking columns
-- ---------------------------------------------------------------------------

alter table public.sensor_resync_requests
  add column if not exists retry_count int not null default 0;

alter table public.sensor_resync_requests
  add column if not exists retry_of uuid
    references public.sensor_resync_requests(id) on delete set null;

create index if not exists sensor_resync_requests_retry_chain_idx
  on public.sensor_resync_requests(retry_of)
  where retry_of is not null;

-- Reason code for app failover. Existing check constraint needs widening.
alter table public.sensor_resync_requests
  drop constraint if exists sensor_resync_requests_reason_check;

alter table public.sensor_resync_requests
  add constraint sensor_resync_requests_reason_check
    check (reason in (
      'auto_gap_detected',
      'admin_manual',
      'app_user_pulled',
      'gap_fill_retry',
      'primus_offline'
    ));

-- ---------------------------------------------------------------------------
-- 2. Backoff helper — how long to wait before retrying a failed fulfilment
-- ---------------------------------------------------------------------------
--
-- Two buckets:
--   - "transient" errors (BLE busy, another fulfilment in flight): 5 min
--   - everything else (sensor unreachable, network error, etc.): 15 min
--
-- We classify by substring match on the error string. The app's contract
-- with these strings is loose (free-text), so we keep the matcher
-- lenient — anything obviously transient bumps to the short backoff.

create or replace function public.resync_retry_backoff_minutes(
  p_error text
) returns int
language sql
immutable
as $$
  select case
    when p_error is null then 15
    when p_error ilike '%another fulfilment%'
      or p_error ilike '%fulfilment in flight%'
      or p_error ilike '%ble busy%'
      or p_error ilike '%radio busy%'
      or p_error ilike '%dispatcher_busy%'
      then 5
    else 15
  end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Re-queue function — used by both the heartbeat handler (Primus
--    users) and an RPC the app calls on startup (app-only users).
-- ---------------------------------------------------------------------------

create or replace function public.requeue_due_failed_resyncs(
  p_user_id uuid default null,
  p_max_retries int default 5
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  r record;
  v_new_id uuid;
begin
  -- Walk failed requests that are due for retry, owned by p_user_id (or
  -- all users if null). For each, queue a fresh request and cancel the
  -- original so it doesn't get re-processed.
  --
  -- Lock the row we're about to act on so a concurrent invocation can't
  -- requeue the same one twice. SKIP LOCKED keeps things flowing if
  -- another worker is mid-process.
  for r in
    select id, sensor_id, user_id, range_start, range_end, retry_count,
           fulfilled_error, fulfilled_at
      from public.sensor_resync_requests
     where fulfilled_error is not null
       and cancelled_at is null
       and retry_count < p_max_retries
       and fulfilled_at is not null
       and fulfilled_at <
           now() - (resync_retry_backoff_minutes(fulfilled_error)
                    * interval '1 minute')
       and (p_user_id is null or user_id = p_user_id)
     order by fulfilled_at asc
     limit 100
     for update skip locked
  loop
    insert into public.sensor_resync_requests (
      sensor_id, user_id, range_start, range_end,
      reason, retry_count, retry_of
    ) values (
      r.sensor_id, r.user_id, r.range_start, r.range_end,
      'gap_fill_retry', r.retry_count + 1, r.id
    )
    returning id into v_new_id;

    update public.sensor_resync_requests
       set cancelled_at = now()
     where id = r.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Keep RPC tight: callable by authenticated users for their OWN rows
-- only. Pass null user_id is admin-only.
revoke all on function public.requeue_due_failed_resyncs(uuid, int) from public;
grant execute on function public.requeue_due_failed_resyncs(uuid, int) to authenticated;

-- Convenience wrapper the app can call without arguments — defaults to
-- the calling user's own rows.
create or replace function public.requeue_my_failed_resyncs()
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  return public.requeue_due_failed_resyncs(auth.uid(), 5);
end;
$$;

revoke all on function public.requeue_my_failed_resyncs() from public;
grant execute on function public.requeue_my_failed_resyncs() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Primus-offline detector
-- ---------------------------------------------------------------------------
--
-- Users with a Primus rely on it as the always-on uploader. If the
-- Primus dies (power cut, Wi-Fi outage, hardware fault), the app should
-- step in. The app's Path-A direct detection (watching live BLE vs
-- cloud last_seen) catches most cases at ~2 min. This function is the
-- Path-B safety net at ~5-7 min, ensuring the app is signalled even
-- if it wasn't actively in BLE range when the Primus died.

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
  -- Find sensors whose owning user has a Primus that's gone silent
  -- AND the sensor itself hasn't reported recently.
  --
  -- "Owning user has a Primus" is detected via primus_devices.user_id,
  -- not a direct sensors.primus_id link (which doesn't exist in this
  -- schema). One Primus per user is the typical case; multi-Primus
  -- households would need this query refined to "ALL Primuses for this
  -- user are stale" but that's premature today.
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

-- Admin-only — not user-callable (the app shouldn't trigger this
-- directly; it should rely on its own Path-A detection or the cron).
revoke all on function public.detect_offline_primus_and_queue_app_failover()
  from public;

-- ---------------------------------------------------------------------------
-- 5. Schedule both functions via pg_cron
-- ---------------------------------------------------------------------------
--
-- Requires the pg_cron extension. Supabase provides it; if it isn't
-- enabled in this project yet, run:
--   create extension if not exists pg_cron with schema extensions;
-- in the SQL editor first.

create extension if not exists pg_cron with schema extensions;

-- Drop existing schedules for these jobs (so re-running this migration
-- doesn't pile up duplicates).
do $$
declare
  v_jobid bigint;
begin
  for v_jobid in
    select jobid from cron.job
     where jobname in (
       'origin_detect_offline_primus',
       'origin_requeue_failed_resyncs'
     )
  loop
    perform cron.unschedule(v_jobid);
  end loop;
end$$;

select cron.schedule(
  'origin_detect_offline_primus',
  '*/2 * * * *',  -- every 2 minutes
  $$select public.detect_offline_primus_and_queue_app_failover();$$
);

select cron.schedule(
  'origin_requeue_failed_resyncs',
  '*/5 * * * *',  -- every 5 minutes
  $$select public.requeue_due_failed_resyncs();$$
);
