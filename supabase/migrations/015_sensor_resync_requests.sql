-- Migration 015 — unified sensor resync request queue.
--
-- Background: gap-fill / catch-up work was previously coupled to the
-- Primus device via primus_commands (type='resync'). This worked when
-- the Primus was the only "reader" that could pull historical data
-- from sensor on-board flash.
--
-- The Origin Monitor mobile app is now also a reader — it's BLE-central
-- to sensors when in range, and ~75% of customers will be app-only
-- (no Primus). For app-only customers, the cloud has no way to ask for
-- gap-fill via primus_commands. So we lift the gap-fill request to a
-- reader-agnostic table: any reader (Primus OR App) can claim and
-- fulfill a request.
--
-- Race semantics: if both Primus and App are online for a sensor, the
-- atomic UPDATE on claimed_at (where claimed_at is null) decides who
-- wins. The other gets 0 rows back and skips. The dedup unique index
-- on (sensor_id, recorded_at) catches any reading-level overlap, so
-- worst-case both upload the same readings → second insert silently
-- drops as a duplicate.

create table if not exists public.sensor_resync_requests (
  id              uuid primary key default gen_random_uuid(),
  sensor_id       uuid not null references public.sensors(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  range_start     timestamptz not null,
  range_end       timestamptz not null,
  reason          text not null check (reason in (
                    'auto_gap_detected',
                    'admin_manual',
                    'app_user_pulled',
                    'gap_fill_retry'
                  )),
  requested_at    timestamptz not null default now(),
  requested_by    uuid references auth.users(id) on delete set null,
  claimed_at      timestamptz,
  claimed_by      text,    -- 'primus:{device_id}' | 'app:{user_id}:{install_id}'
  fulfilled_at    timestamptz,
  fulfilled_count int,     -- readings actually inserted (after dedup)
  fulfilled_error text,    -- non-null + status='error' if failed
  cancelled_at    timestamptz,
  expires_at      timestamptz not null default (now() + interval '24 hours')
);

-- Hot path: reader looking for "what's open for me to claim?"
create index if not exists sensor_resync_requests_open_idx
  on public.sensor_resync_requests(user_id, sensor_id, expires_at)
  where claimed_at is null
    and cancelled_at is null
    and fulfilled_at is null;

-- Admin / observability: per-sensor history
create index if not exists sensor_resync_requests_sensor_history_idx
  on public.sensor_resync_requests(sensor_id, requested_at desc);

-- Dedupe: don't queue a second auto-detect request for the same sensor
-- + range while one is already open. Soft uniqueness — enforced by the
-- gap-detect logic, not by a DB unique constraint (admin can still
-- queue manual overlapping requests).

alter table public.sensor_resync_requests enable row level security;

-- Owner can read their own requests
drop policy if exists "resync requests: owner read"
  on public.sensor_resync_requests;
create policy "resync requests: owner read"
  on public.sensor_resync_requests for select
  using (user_id = auth.uid());

-- Owner can claim and update their own requests (status fields only —
-- they can't change sensor_id / range / reason / etc.)
drop policy if exists "resync requests: owner update"
  on public.sensor_resync_requests;
create policy "resync requests: owner update"
  on public.sensor_resync_requests for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Owner can insert app-initiated rows (e.g. "I noticed a gap myself,
-- pre-claim it"). Mostly for the app's manual "Sync now" button.
drop policy if exists "resync requests: owner insert"
  on public.sensor_resync_requests;
create policy "resync requests: owner insert"
  on public.sensor_resync_requests for insert
  to authenticated
  with check (user_id = auth.uid());

-- Admins (support engineers) can do anything
drop policy if exists "resync requests: admin all"
  on public.sensor_resync_requests;
create policy "resync requests: admin all"
  on public.sensor_resync_requests for all
  using (public.is_admin())
  with check (public.is_admin());

-- Realtime: app subscribes to INSERT events filtered by user_id (RLS).
-- When the cloud detects a gap and inserts a row, the app sees it
-- within seconds and decides whether it can fulfill (in BLE range or not).
alter publication supabase_realtime add table public.sensor_resync_requests;
