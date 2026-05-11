-- Migration 003 — pending/claimed sensor flow
--
-- Until now, sensors had to be registered with a known serial (MAC) via the
-- portal. This migration lets the Primus auto-create "pending" sensor rows
-- when it sees a new BLE advertisement, and customers simply claim + name
-- them in the dashboard.
--
-- Adds:
--   sensors.claimed_at            — null = pending, non-null = claimed
--   sensors.discovered_by_primus  — which Primus announced it (nullable)

alter table public.sensors
  add column if not exists claimed_at timestamptz default now();

alter table public.sensors
  add column if not exists discovered_by_primus uuid
  references public.primus_devices(id) on delete set null;

-- Backfill: any existing rows (registered via portal before this migration)
-- are considered claimed.
update public.sensors
  set claimed_at = coalesce(claimed_at, registered_at)
  where claimed_at is null;

create index if not exists sensors_pending_idx
  on public.sensors(user_id, claimed_at)
  where claimed_at is null;
