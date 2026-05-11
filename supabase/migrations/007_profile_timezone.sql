-- Migration 007 — per-user timezone
--
-- Each user account now stores its own IANA timezone (e.g. "Australia/Perth",
-- "Pacific/Auckland", "Europe/London"). This is used for:
--   - Admin viewing customer data (renders in customer's TZ, not admin's)
--   - Email reminders (so "Day 18 lockdown" fires at 8am user-local)
--   - Scheduled jobs acting on behalf of users
--
-- Sources that populate it (first-write wins after default):
--   1. Browser's Intl API at signup (metadata.timezone)
--   2. Browser's Intl API on first login after this migration (via the
--      dashboard SyncTimezone client component)
--   3. Primus heartbeat (for customers who set up via the device first)

alter table public.profiles
  add column if not exists timezone text not null default 'UTC';

-- Extend the signup trigger to pick up timezone from signup metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, timezone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(nullif(new.raw_user_meta_data->>'timezone', ''), 'UTC')
  );
  return new;
end;
$$;
