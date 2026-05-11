-- Migration 011 — Primus event log.
--
-- Primus firmware maintains two on-device ring buffers (sensor warnings +
-- cloud warnings/errors) and forwards recent entries via /primus/heartbeat.
-- This table is the cloud-side mirror — lets support/admin see what a
-- customer's device is logging without having to ask them to read their
-- LCD. Silent gap-fill resyncs are also logged here (as info-severity).
--
-- Retention: last ~500 per device, trimmed by the API after each insert.
-- Dedupe: (primus_id, observed_at, source, message) — the Primus may
-- retransmit the same entries across heartbeats until it sees an ack, so
-- duplicates are expected and silently dropped.

create table if not exists public.primus_events (
  id uuid primary key default gen_random_uuid(),
  primus_id uuid not null references public.primus_devices(id) on delete cascade,
  observed_at timestamptz not null,
  severity text not null check (severity in ('info', 'warn', 'error')),
  source text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists primus_events_dedup_uniq
  on public.primus_events(primus_id, observed_at, source, message);

create index if not exists primus_events_device_time_idx
  on public.primus_events(primus_id, observed_at desc);

create index if not exists primus_events_severity_idx
  on public.primus_events(primus_id, severity, observed_at desc);

-- RLS: service-role only. The admin UI reads via the admin (service-role)
-- client, and customers never see this table directly (LCD shows its own
-- local log). If we later want customers to see their own device's events
-- in the portal, add a policy joining primus_devices.user_id = auth.uid().
alter table public.primus_events enable row level security;

-- Retention trim — keeps only the newest p_keep rows per device. Called
-- from the /primus/heartbeat handler after inserting new events.
create or replace function public.trim_primus_events(
  p_primus_id uuid,
  p_keep integer
) returns void
language sql
security definer
set search_path = public
as $$
  delete from public.primus_events
  where primus_id = p_primus_id
    and id not in (
      select id
      from public.primus_events
      where primus_id = p_primus_id
      order by observed_at desc, id desc
      limit p_keep
    );
$$;

revoke all on function public.trim_primus_events(uuid, integer) from public;
grant execute on function public.trim_primus_events(uuid, integer) to service_role;
