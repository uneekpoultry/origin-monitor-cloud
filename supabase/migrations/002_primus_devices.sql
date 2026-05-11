-- Migration 002 — Primus basestation device registry
-- Each Primus has a per-device API key (hashed) it uses to POST readings/heartbeats.

create table if not exists public.primus_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text,
  api_key_hash text unique not null,
  last_seen timestamptz,
  firmware_version text,
  wifi_ssid text,
  registered_at timestamptz not null default now()
);

create index if not exists primus_devices_user_idx on public.primus_devices(user_id);

alter table public.primus_devices enable row level security;

drop policy if exists "primus: owner read"  on public.primus_devices;
drop policy if exists "primus: owner write" on public.primus_devices;
drop policy if exists "primus: admin all"   on public.primus_devices;

create policy "primus: owner read"
  on public.primus_devices for select
  using (auth.uid() = user_id);

-- Users can rename / delete their own devices but cannot rotate the api_key_hash
-- from the portal directly — that's a server-issued credential.
create policy "primus: owner write"
  on public.primus_devices for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "primus: admin all"
  on public.primus_devices for all
  using (public.is_admin())
  with check (public.is_admin());
