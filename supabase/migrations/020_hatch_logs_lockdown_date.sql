-- Migration 020 — add `lockdown_date` to `hatch_logs`.
--
-- Background: the app's hatch-creation flow attempts to set
-- `lockdown_date` on insert. The column is documented in the App
-- master brief (`hatch_logs.lockdown_date date`) but was never
-- actually created in production. App is currently working around
-- this by commenting out the field on insert; the lockdown date is
-- otherwise computed from `species` + `start_date` via the species
-- preset's lockdownDay (e.g. day 18 for chickens, day 25 for ducks).
--
-- Adding it explicitly so:
--   1. Users can OVERRIDE the species default (e.g. "I want lockdown
--      on day 19 for these eggs" — useful for non-standard breeds or
--      atypical environments).
--   2. The cloud row carries the canonical lockdown date for any
--      consumer (admin dashboard, hatch report, integrations).
--
-- The column is nullable: when null, the app/portal computes it
-- from species + start_date as before. When set, the explicit value
-- is used.

alter table public.hatch_logs
  add column if not exists lockdown_date date;

-- No backfill — leaving existing rows with null preserves the current
-- "compute from species" behaviour. New rows can opt to populate.

-- Refresh PostgREST schema cache so the column is immediately visible
-- to authenticated REST clients without a service restart.
notify pgrst, 'reload schema';
