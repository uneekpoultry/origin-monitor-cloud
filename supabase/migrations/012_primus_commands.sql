-- Migration 012 — Primus command queue.
--
-- Cloud-to-Primus channel for remote commands. Admin / support clicks a
-- button (e.g. "Request resync"), we queue a command row. Primus polls
-- /primus/heartbeat; the response now carries any undelivered commands
-- in a `commands` array. Primus executes, reports back via the next
-- heartbeat's `command_results` field. Cloud marks complete.
--
-- Commands are single-use: once returned to the Primus (delivered_at set),
-- they won't be returned again. If the device crashes mid-execution the
-- admin can click again — it's a new command row.

create type primus_command_type as enum ('resync');

create table if not exists public.primus_commands (
  id uuid primary key default gen_random_uuid(),
  primus_id uuid not null references public.primus_devices(id) on delete cascade,
  type primus_command_type not null,
  params jsonb not null default '{}'::jsonb,
  issued_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  completed_at timestamptz,
  result jsonb
);

-- "Pending for delivery" lookup — the hot path on every heartbeat.
create index if not exists primus_commands_pending_idx
  on public.primus_commands(primus_id, created_at)
  where delivered_at is null;

-- Audit/history lookup for admin UI.
create index if not exists primus_commands_device_history_idx
  on public.primus_commands(primus_id, created_at desc);

-- RLS: service role writes; admins read via the admin client (which uses
-- the service role). No policy for authenticated users — commands are
-- opaque to customers.
alter table public.primus_commands enable row level security;
