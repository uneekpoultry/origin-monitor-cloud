-- Migration 004 — allow the Origin Monitor app (or any user JWT) to insert
-- readings for sensors they own.
--
-- Previously sensor_readings had no INSERT policy for regular users — only
-- the Node.js API writing via the service role could insert. That's fine
-- for Primus-only setups, but the app also needs to push readings when
-- a user has no Primus (for cloud history / cross-device sync).

drop policy if exists "readings: owner insert" on public.sensor_readings;

create policy "readings: owner insert"
  on public.sensor_readings for insert
  to authenticated
  with check (
    exists (
      select 1 from public.sensors s
      where s.id = sensor_readings.sensor_id
        and s.user_id = auth.uid()
    )
  );
