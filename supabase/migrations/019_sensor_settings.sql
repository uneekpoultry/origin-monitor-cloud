-- Migration 019 — global per-sensor settings.
--
-- Background: per-sensor user settings (calibration offsets, alert
-- thresholds, alert enables) need to live somewhere central so the
-- Primus, the Origin Monitor app, and the cloud-side dashboard all
-- agree on the same values. Spec: CLAUDE_PRIMUS_GLOBAL_SETTINGS_SCHEMA.md.
--
-- Storage choice: a single JSONB column rather than 11 individual
-- columns. Reasons:
--   1. Future fields (alert_battery_low, alert_sound_id, additional
--      alert types) can be added without schema migrations — every
--      side ignores fields it doesn't know about.
--   2. Per-Primus extensions don't bloat the central schema.
--   3. Backward compatibility: the JSONB defaults to '{}' so existing
--      sensor rows behave identically until the user actually sets
--      a value.
--
-- The companion timestamp `settings_updated_at` drives last-writer-
-- wins sync between Primus / App / Cloud. Cloud sets it to now() on
-- any successful settings update; clients use it on GET to decide
-- whether the cloud is newer than their local copy (adopt) or older
-- (push their local up).
--
-- Validation (e.g. alert_temp_low < alert_temp_high) is enforced at
-- the API layer (Zod refinement in /primus/sensors PATCH) rather
-- than as DB constraints — the JSONB shape is intentionally
-- forward-compatible, and adding CHECK constraints inside JSONB is
-- both fragile and hard to evolve.

alter table public.sensors
  add column if not exists settings jsonb not null default '{}'::jsonb;

alter table public.sensors
  add column if not exists settings_updated_at timestamptz;

-- Backfill: existing claimed sensors get an empty settings object
-- with version 1 so all reads return a consistent shape. Pending
-- sensors (claimed_at IS NULL) keep '{}' which is fine — they're
-- not user-visible until claimed.
update public.sensors
   set settings = jsonb_build_object('version', 1)
 where claimed_at is not null
   and (settings is null or settings = '{}'::jsonb);

-- RLS verification: the existing owner-update policy on sensors
-- already covers all columns by default (Postgres RLS is row-level,
-- not column-level, unless explicitly column-restricted). No new
-- policy needed. Sanity-check by re-creating the owner-update
-- policy below in idempotent form so any future tightening is
-- visible here in the migration history.

drop policy if exists "sensors: owner update" on public.sensors;
create policy "sensors: owner update"
  on public.sensors for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Index on settings_updated_at — useful for "show me sensors whose
-- settings have changed since X" queries (currently unused but
-- cheap to have in place for future admin / sync diagnostics).
create index if not exists sensors_settings_updated_at_idx
  on public.sensors(settings_updated_at desc nulls last)
  where settings_updated_at is not null;
