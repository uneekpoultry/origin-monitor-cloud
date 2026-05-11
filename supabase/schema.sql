-- Origin Monitor — Supabase schema
-- Paste into Supabase SQL Editor and run once.
-- Safe to re-run; uses IF NOT EXISTS and DROP POLICY IF EXISTS.

-- =============================================================
-- EXTENSIONS
-- =============================================================
create extension if not exists "pgcrypto";

-- =============================================================
-- PROFILES
-- =============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  country text default 'AU',
  notification_email boolean not null default true,
  notification_push boolean not null default true,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =============================================================
-- SENSORS
-- =============================================================
create table if not exists public.sensors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  serial_number text unique not null,
  model text not null check (model in ('pro', 'lite')),
  name text,
  calibration_date date,
  calibration_due_date date,
  calibration_certificate_url text,
  registered_at timestamptz not null default now(),
  last_seen timestamptz,
  firmware_version text
);

create index if not exists sensors_user_id_idx on public.sensors(user_id);
create index if not exists sensors_serial_idx on public.sensors(serial_number);

-- =============================================================
-- SENSOR READINGS (time series)
-- =============================================================
create table if not exists public.sensor_readings (
  id uuid primary key default gen_random_uuid(),
  sensor_id uuid not null references public.sensors(id) on delete cascade,
  temperature real,
  humidity real,
  battery_mv integer,
  recorded_at timestamptz not null default now()
);

create index if not exists readings_sensor_time_idx
  on public.sensor_readings(sensor_id, recorded_at desc);

-- =============================================================
-- HATCH LOGS
-- =============================================================
create table if not exists public.hatch_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  sensor_id uuid references public.sensors(id) on delete set null,
  name text not null,
  species text,
  egg_count integer,
  start_date date not null,
  expected_hatch_date date,
  actual_hatch_date date,
  hatched_count integer,
  notes text,
  status text not null default 'active'
    check (status in ('active', 'completed', 'failed')),
  is_pro boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists hatch_logs_user_idx on public.hatch_logs(user_id);
create index if not exists hatch_logs_status_idx on public.hatch_logs(status);

-- =============================================================
-- FIRMWARE
-- =============================================================
create table if not exists public.firmware (
  id uuid primary key default gen_random_uuid(),
  product text not null check (product in ('pro', 'lite', 'primus', 'scale', 'pulse')),
  version text not null,
  release_notes text,
  download_url text not null,
  is_latest boolean not null default false,
  released_at timestamptz not null default now(),
  unique (product, version)
);

create index if not exists firmware_product_latest_idx
  on public.firmware(product) where is_latest;

-- =============================================================
-- CALIBRATION CERTIFICATES
-- =============================================================
create table if not exists public.calibration_certificates (
  id uuid primary key default gen_random_uuid(),
  sensor_id uuid not null references public.sensors(id) on delete cascade,
  certificate_number text unique not null,
  calibrated_at date not null,
  next_due date not null,
  certificate_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists cal_cert_sensor_idx on public.calibration_certificates(sensor_id);

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================
alter table public.profiles                 enable row level security;
alter table public.sensors                  enable row level security;
alter table public.sensor_readings          enable row level security;
alter table public.hatch_logs               enable row level security;
alter table public.firmware                 enable row level security;
alter table public.calibration_certificates enable row level security;

-- Helper: is current user an admin?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (select is_admin from public.profiles where id = auth.uid()),
    false
  );
$$;

-- -------- profiles --------
drop policy if exists "profiles: self read"   on public.profiles;
drop policy if exists "profiles: self update" on public.profiles;
drop policy if exists "profiles: admin all"   on public.profiles;

create policy "profiles: self read"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles: self update"
  on public.profiles for update
  using (auth.uid() = id);

create policy "profiles: admin all"
  on public.profiles for all
  using (public.is_admin())
  with check (public.is_admin());

-- -------- sensors --------
drop policy if exists "sensors: owner read"   on public.sensors;
drop policy if exists "sensors: owner write"  on public.sensors;
drop policy if exists "sensors: admin all"    on public.sensors;

create policy "sensors: owner read"
  on public.sensors for select
  using (auth.uid() = user_id);

create policy "sensors: owner write"
  on public.sensors for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "sensors: admin all"
  on public.sensors for all
  using (public.is_admin())
  with check (public.is_admin());

-- -------- sensor_readings --------
drop policy if exists "readings: owner read"  on public.sensor_readings;
drop policy if exists "readings: admin all"   on public.sensor_readings;

create policy "readings: owner read"
  on public.sensor_readings for select
  using (
    exists (
      select 1 from public.sensors s
      where s.id = sensor_readings.sensor_id
        and s.user_id = auth.uid()
    )
  );

create policy "readings: admin all"
  on public.sensor_readings for all
  using (public.is_admin())
  with check (public.is_admin());

-- Note: sensor_readings INSERTs come from the Node.js API using the
-- service role key, which bypasses RLS — so no insert policy for users.

-- -------- hatch_logs --------
drop policy if exists "hatches: owner read"   on public.hatch_logs;
drop policy if exists "hatches: owner write"  on public.hatch_logs;
drop policy if exists "hatches: admin all"    on public.hatch_logs;

create policy "hatches: owner read"
  on public.hatch_logs for select
  using (auth.uid() = user_id);

create policy "hatches: owner write"
  on public.hatch_logs for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "hatches: admin all"
  on public.hatch_logs for all
  using (public.is_admin())
  with check (public.is_admin());

-- -------- firmware --------
drop policy if exists "firmware: authed read" on public.firmware;
drop policy if exists "firmware: admin write" on public.firmware;

create policy "firmware: authed read"
  on public.firmware for select
  to authenticated
  using (true);

create policy "firmware: admin write"
  on public.firmware for all
  using (public.is_admin())
  with check (public.is_admin());

-- -------- calibration_certificates --------
drop policy if exists "certs: owner read"  on public.calibration_certificates;
drop policy if exists "certs: admin write" on public.calibration_certificates;

create policy "certs: owner read"
  on public.calibration_certificates for select
  using (
    exists (
      select 1 from public.sensors s
      where s.id = calibration_certificates.sensor_id
        and s.user_id = auth.uid()
    )
  );

create policy "certs: admin write"
  on public.calibration_certificates for all
  using (public.is_admin())
  with check (public.is_admin());

-- =============================================================
-- DONE. After running, set your own profile row to admin with:
--   update public.profiles set is_admin = true where id = auth.uid();
-- (Run that from SQL Editor while signed in as yourself, OR update
-- by matching the email once you have an account.)
-- =============================================================
