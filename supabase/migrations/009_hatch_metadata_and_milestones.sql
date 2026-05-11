-- Migration 009 — richer hatch metadata, milestone log, egg weights, email audit
--
-- Adds the foundations for:
--   * Recording breed / egg source / incubator details on each hatch
--   * Per-hatch incubation targets (temp + humidity for turning and lockdown)
--   * First-pip and hatch-complete timestamps (so we can compute hatch window)
--   * A daily log and milestones stream (candling, observations, etc.)
--   * Egg weight tracking (for Origin Scale when it ships, manual for now)
--   * Audit log + rate-limit support for emailed hatch reports

-- =============================================================
-- hatch_logs — new columns
-- =============================================================
alter table public.hatch_logs
  add column if not exists breed                     text,
  add column if not exists egg_source                text,
  add column if not exists egg_source_detail         text,
  add column if not exists incubator_model           text,
  add column if not exists target_temp               numeric(4,1),
  add column if not exists target_humid_turn_min     numeric(4,1),
  add column if not exists target_humid_turn_max     numeric(4,1),
  add column if not exists target_humid_lock_min     numeric(4,1),
  add column if not exists target_humid_lock_max     numeric(4,1),
  add column if not exists first_pip_at              timestamptz,
  add column if not exists hatch_complete_at         timestamptz,
  add column if not exists chick_assessment          text;

-- egg_source is freeform but we'll gently nudge via a check (allows custom).
alter table public.hatch_logs
  drop constraint if exists hatch_logs_egg_source_check;
alter table public.hatch_logs
  add constraint hatch_logs_egg_source_check
  check (
    egg_source is null
    or egg_source in ('own_flock', 'purchased', 'shipped', 'other')
  );

-- =============================================================
-- hatch_milestones — daily log entries + candling + lockdown + custom events
-- =============================================================
create table if not exists public.hatch_milestones (
  id              uuid primary key default gen_random_uuid(),
  hatch_id        uuid not null references public.hatch_logs(id) on delete cascade,
  user_id         uuid not null references public.profiles(id)   on delete cascade,
  milestone_type  text not null
    check (milestone_type in (
      'daily_log', 'candling_1', 'candling_2', 'lockdown', 'observation', 'custom'
    )),
  occurred_at     timestamptz not null default now(),
  day_number      integer,
  fertile_count   integer,
  removed_count   integer,
  eggs_remaining  integer,
  turning_count   integer,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists hatch_milestones_hatch_idx
  on public.hatch_milestones(hatch_id, day_number);

create index if not exists hatch_milestones_user_idx
  on public.hatch_milestones(user_id);

-- For the XLSX Sheet 2 "Daily log" population we query by (hatch_id, milestone_type, day_number)
-- so also add a composite index on type within hatch.
create index if not exists hatch_milestones_hatch_type_day_idx
  on public.hatch_milestones(hatch_id, milestone_type, day_number);

alter table public.hatch_milestones enable row level security;

drop policy if exists "milestones: owner read"   on public.hatch_milestones;
drop policy if exists "milestones: owner write"  on public.hatch_milestones;
drop policy if exists "milestones: admin all"    on public.hatch_milestones;

create policy "milestones: owner read"
  on public.hatch_milestones for select
  using (auth.uid() = user_id);

create policy "milestones: owner write"
  on public.hatch_milestones for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "milestones: admin all"
  on public.hatch_milestones for all
  using (public.is_admin())
  with check (public.is_admin());

-- =============================================================
-- egg_weights — for Origin Scale (future) + manual entries
-- =============================================================
create table if not exists public.egg_weights (
  id            uuid primary key default gen_random_uuid(),
  hatch_id      uuid not null references public.hatch_logs(id) on delete cascade,
  user_id       uuid not null references public.profiles(id)   on delete cascade,
  weighed_at    timestamptz not null default now(),
  day_number    integer,
  weight_grams  numeric(6,1),
  stage         text
    check (stage is null or stage in ('set', 'lockdown', 'other')),
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists egg_weights_hatch_idx
  on public.egg_weights(hatch_id, weighed_at);
create index if not exists egg_weights_user_idx
  on public.egg_weights(user_id);

alter table public.egg_weights enable row level security;

drop policy if exists "weights: owner read"   on public.egg_weights;
drop policy if exists "weights: owner write"  on public.egg_weights;
drop policy if exists "weights: admin all"    on public.egg_weights;

create policy "weights: owner read"
  on public.egg_weights for select
  using (auth.uid() = user_id);

create policy "weights: owner write"
  on public.egg_weights for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "weights: admin all"
  on public.egg_weights for all
  using (public.is_admin())
  with check (public.is_admin());

-- =============================================================
-- report_emails — audit + rate limit for the emailed hatch reports
-- =============================================================
create table if not exists public.report_emails (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  hatch_id       uuid not null references public.hatch_logs(id) on delete cascade,
  source         text not null
    check (source in ('web', 'app', 'primus')),
  sent_at        timestamptz not null default now(),
  email_address  text not null
);

create index if not exists report_emails_hatch_idx
  on public.report_emails(hatch_id, sent_at desc);
create index if not exists report_emails_user_idx
  on public.report_emails(user_id, sent_at desc);

-- RLS: users can read their own audit log (nice for support); writes go through
-- server actions using the service role, so no INSERT policy for users.
alter table public.report_emails enable row level security;

drop policy if exists "report_emails: owner read" on public.report_emails;
drop policy if exists "report_emails: admin all"  on public.report_emails;

create policy "report_emails: owner read"
  on public.report_emails for select
  using (auth.uid() = user_id);

create policy "report_emails: admin all"
  on public.report_emails for all
  using (public.is_admin())
  with check (public.is_admin());
