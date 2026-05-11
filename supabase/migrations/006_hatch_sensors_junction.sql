-- Migration 006 — multiple sensors per hatch
--
-- Customers often run one hatch across multiple positions / trays, each
-- with its own sensor. Move from a single hatch_logs.sensor_id column to a
-- junction table so any number of sensors can be linked to a hatch.

create table if not exists public.hatch_sensors (
  hatch_id  uuid not null references public.hatch_logs(id) on delete cascade,
  sensor_id uuid not null references public.sensors(id)    on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (hatch_id, sensor_id)
);

create index if not exists hatch_sensors_hatch_idx  on public.hatch_sensors(hatch_id);
create index if not exists hatch_sensors_sensor_idx on public.hatch_sensors(sensor_id);

alter table public.hatch_sensors enable row level security;

drop policy if exists "hatch_sensors: owner read"   on public.hatch_sensors;
drop policy if exists "hatch_sensors: owner write"  on public.hatch_sensors;
drop policy if exists "hatch_sensors: admin all"    on public.hatch_sensors;

-- Read: user can see links for their own hatches
create policy "hatch_sensors: owner read"
  on public.hatch_sensors for select
  using (
    exists (
      select 1 from public.hatch_logs h
      where h.id = hatch_sensors.hatch_id
        and h.user_id = auth.uid()
    )
  );

-- Write (insert / update / delete): user must own BOTH the hatch and the sensor
create policy "hatch_sensors: owner write"
  on public.hatch_sensors for all
  using (
    exists (
      select 1 from public.hatch_logs h
      where h.id = hatch_sensors.hatch_id
        and h.user_id = auth.uid()
    )
    and exists (
      select 1 from public.sensors s
      where s.id = hatch_sensors.sensor_id
        and s.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.hatch_logs h
      where h.id = hatch_sensors.hatch_id
        and h.user_id = auth.uid()
    )
    and exists (
      select 1 from public.sensors s
      where s.id = hatch_sensors.sensor_id
        and s.user_id = auth.uid()
    )
  );

create policy "hatch_sensors: admin all"
  on public.hatch_sensors for all
  using (public.is_admin())
  with check (public.is_admin());

-- Backfill: copy any existing single-sensor links into the junction.
insert into public.hatch_sensors (hatch_id, sensor_id)
  select id, sensor_id
  from public.hatch_logs
  where sensor_id is not null
  on conflict do nothing;

-- Drop the old single-sensor column. Safe — above backfill has copied any
-- existing data, and app code will be updated in the same deploy.
alter table public.hatch_logs drop column if exists sensor_id;
