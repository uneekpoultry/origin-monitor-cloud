-- Migration 021 — stop-hatch: status='stopped' + reason + category.
--
-- Background: today's hatch lifecycle on hatch_logs is constrained
-- to status IN ('active', 'completed', 'failed'). The only way to
-- end a hatch early is to delete the row outright — losing all the
-- linked sensor history, alerts, milestones, and notes.
--
-- For serious hatchers, the data from a FAILED hatch is more
-- valuable than a successful one: it's the post-mortem evidence
-- ("what went wrong on day 15?") that informs the next attempt.
-- Deleting it loses that. So we add a 'stopped' status (distinct
-- from 'failed', which is reserved for hatches that ran to the
-- expected hatch date but didn't produce live hatchlings) plus
-- structured columns for the reason.
--
-- Status semantics post-migration:
--   active     — currently running, hasn't reached expected hatch date
--   completed  — reached expected hatch date with successful hatch
--   failed     — reached expected hatch date but no/poor hatch outcome
--   stopped    — ended early by user before expected hatch date
--   archived   — old hatch hidden from default views (future use)
--
-- The new columns:
--   stopped_at        — timestamp of when the user ended the hatch
--   stopped_reason    — free-text description ("Found 6 of 12 eggs
--                       were clear at day-14 candling; ended cycle")
--   stopped_category  — optional categorization for analytics, free-
--                       text but app-suggested values are:
--                         equipment_failure
--                         temperature_excursion
--                         humidity_excursion
--                         power_outage
--                         eggs_not_viable
--                         contamination
--                         accident
--                         other

alter table public.hatch_logs
  add column if not exists stopped_at       timestamptz,
  add column if not exists stopped_reason   text,
  add column if not exists stopped_category text;

-- Replace the status CHECK constraint to add 'stopped' and 'archived'.
-- The existing constraint is named `hatch_logs_status_check`; drop and
-- recreate. Existing rows are all 'active' / 'completed' / 'failed'
-- (verified pre-migration), so no data migration needed.
alter table public.hatch_logs
  drop constraint if exists hatch_logs_status_check;

alter table public.hatch_logs
  add constraint hatch_logs_status_check
    check (status in ('active', 'completed', 'failed', 'stopped', 'archived'));

-- Refresh PostgREST schema cache so the new columns are immediately
-- visible to authenticated REST clients without a service restart.
notify pgrst, 'reload schema';
