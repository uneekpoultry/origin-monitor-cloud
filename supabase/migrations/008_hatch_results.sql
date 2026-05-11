-- Migration 008 — richer hatch results
--
-- Previously we only captured hatched_count. Breeders want the full
-- breakdown for hatch-rate / fertility analysis.

alter table public.hatch_logs
  add column if not exists fertile_count      integer,
  add column if not exists died_in_shell      integer,
  add column if not exists pipped_not_hatched integer,
  add column if not exists early_deaths       integer;
