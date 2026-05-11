-- Migration 001 — rename product enum values
-- Previously: 'monitor_pro' / 'monitor_lite'
-- Now:        'pro' / 'lite'
-- Also expands firmware.product to include future products: scale, pulse.
-- Safe to run on empty tables (no existing rows to migrate).

-- sensors.model
alter table public.sensors
  drop constraint if exists sensors_model_check;

alter table public.sensors
  add constraint sensors_model_check
  check (model in ('pro', 'lite'));

-- firmware.product
alter table public.firmware
  drop constraint if exists firmware_product_check;

alter table public.firmware
  add constraint firmware_product_check
  check (product in ('pro', 'lite', 'primus', 'scale', 'pulse'));

-- If any rows existed with the old values, uncomment these before the ALTERs:
-- update public.sensors  set model = 'pro'  where model = 'monitor_pro';
-- update public.sensors  set model = 'lite' where model = 'monitor_lite';
-- update public.firmware set product = 'pro'  where product = 'monitor_pro';
-- update public.firmware set product = 'lite' where product = 'monitor_lite';
