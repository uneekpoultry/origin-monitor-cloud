# ⚠️ SUPERSEDED — see CLAUDE_APP_GLOBAL_SETTINGS_SCHEMA.md

> **Superseded 2026-05-08.** The cloud team chose a different design:
> instead of a separate `sensor_thresholds` table, per-sensor settings
> (calibration offsets, alert thresholds, alert enables) live in a
> single `sensors.settings` JSONB column with `sensors.settings_updated_at`
> driving last-writer-wins. App + cloud + Primus all converge on the
> shared schema documented in `CLAUDE_APP_GLOBAL_SETTINGS_SCHEMA.md`.
>
> The app's `SensorThresholdsCloudService` (built against this old
> design) has been removed; `SensorSettingsService` implements the new
> contract.
>
> **Do not implement anything from the original request below.** Kept
> here for historical context only.

---

# Threshold sync — Cloud + Primus tasks (original — superseded)

> **From the App session, 2026-05-03.** The app now writes per-sensor
> thresholds to a `sensor_thresholds` table whenever the user changes
> them on the Alerts & Thresholds page, and subscribes to Realtime so
> changes from any other device are applied locally and pushed to the
> sensor over BLE. The cloud table doesn't exist yet — please create
> it. Primus session, see §3 for what your firmware needs to do.

---

## 1. Cloud schema — please create

```sql
-- Migration NN_sensor_thresholds.sql

CREATE TABLE sensor_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id UUID NOT NULL UNIQUE
    REFERENCES sensors(id) ON DELETE CASCADE,

  temp_high_c       NUMERIC(5,2),
  temp_low_c        NUMERIC(5,2),
  humid_high_pct    NUMERIC(5,2),
  humid_low_pct     NUMERIC(5,2),

  temp_high_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  temp_low_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  humid_high_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  humid_low_enabled  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Last-writer-wins audit field. Helpful for debugging which
  -- device made a change. Values used today: 'app', 'primus', 'web'.
  updated_by_source TEXT,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-bump updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION sensor_thresholds_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sensor_thresholds_touch
  BEFORE UPDATE ON sensor_thresholds
  FOR EACH ROW EXECUTE FUNCTION sensor_thresholds_touch_updated_at();

-- RLS: users read/write thresholds only for sensors they own.
ALTER TABLE sensor_thresholds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_thresholds" ON sensor_thresholds
  FOR SELECT
  USING (sensor_id IN (
    SELECT id FROM sensors WHERE user_id = auth.uid()
  ));

CREATE POLICY "users_upsert_own_thresholds" ON sensor_thresholds
  FOR ALL
  USING (sensor_id IN (
    SELECT id FROM sensors WHERE user_id = auth.uid()
  ))
  WITH CHECK (sensor_id IN (
    SELECT id FROM sensors WHERE user_id = auth.uid()
  ));

-- Realtime — required for cross-device sync.
ALTER PUBLICATION supabase_realtime ADD TABLE sensor_thresholds;

-- Verify.
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
   WHERE table_name = 'sensor_thresholds') AS table_exists,
  (SELECT COUNT(*) FROM pg_publication_tables
   WHERE pubname = 'supabase_realtime' AND tablename = 'sensor_thresholds') AS realtime_on;
-- Both should return 1.
```

---

## 2. App-side contract (already shipped — just so you know)

- The app writes via `UPSERT` keyed on `sensor_id` (one row per
  sensor). Payload:

  ```json
  {
    "sensor_id": "<uuid from sensors.id>",
    "temp_high_c": 39.0,
    "temp_low_c": 36.0,
    "humid_high_pct": 75.0,
    "humid_low_pct": 35.0,
    "temp_high_enabled": true,
    "temp_low_enabled": true,
    "humid_high_enabled": true,
    "humid_low_enabled": true,
    "updated_by_source": "app"
  }
  ```

- The app uses `updated_by_source = 'app'` so Primus can ignore its
  own echoes if needed.
- The app subscribes to `sensor_thresholds` Realtime (`event: all`)
  and on inbound changes:
  1. Mirrors the new values into `AlertService` (the local
     advertisement-based alert engine).
  2. Pushes the new thresholds to the sensor over BLE if the user
     happens to have a live BLE session open on the sensor's
     settings screen at that moment.

---

## 3. Primus firmware — what your session needs to do

Two-way responsibilities:

### 3.1 Receive

- Subscribe to `sensor_thresholds` Realtime via the Supabase ESP-IDF
  client (or polling at 60 s if Realtime is too heavy).
- On every change for a sensor in your account, push the new
  threshold to the BLE sensor via the KBeacon trigger config
  commands. Mapping:

  | Cloud field | KBeacon trigger |
  |---|---|
  | `temp_high_c`, `temp_high_enabled` | trigger index 0 (temp above) |
  | `temp_low_c`, `temp_low_enabled` | trigger index 1 (temp below) |
  | `humid_low_pct`, `humid_low_enabled` | trigger index 2 (humid below) |
  | `humid_high_pct`, `humid_high_enabled` | trigger index 3 (humid above) |

  Use the existing `configureTempTrigger` / `configureHumidityTrigger`
  / `disableTrigger` JSON commands per the KBeacon protocol doc — the
  app's trigger indices line up with these.

### 3.2 Send

- When a user changes thresholds on the **Primus LCD UI**, your
  firmware must:
  1. Push the new threshold to the sensor over BLE (same as 3.1).
  2. **UPSERT** to `sensor_thresholds` with the same payload shape
     as the app, using `updated_by_source = 'primus'`.

### 3.3 Race / conflict notes

- The table is keyed on `sensor_id` (one row per sensor). UPSERTs
  overwrite — last writer wins.
- `updated_at` auto-bumps via trigger so all devices see the same
  ordering.
- If two devices change thresholds simultaneously, the later write
  wins. Acceptable for this domain — users rarely change thresholds
  for the same sensor concurrently.

---

## 4. Testing checklist (when both ends are ready)

1. Set thresholds on App → `sensor_thresholds` row appears in cloud
   with `updated_by_source = 'app'`. ✅
2. Watch app's Realtime — change thresholds via Primus LCD →
   `sensor_thresholds` row updates with `updated_by_source = 'primus'`
   → app's `AlertService` reflects the new values within ~1 s.
3. With a sensor in BLE range, change thresholds on Primus → app's
   open Settings screen for that sensor (if any) auto-applies the new
   values to the sensor over BLE.
4. With sensor out of BLE range, change thresholds on App → cloud row
   updates → Primus picks up via Realtime → Primus pushes to BLE
   sensor (Primus has the radio).
5. On a fresh phone that signs in to the same account → cached
   thresholds populate from `_pullAll()` on `start()` → no need to
   re-enter.

---

## 5. Out of scope for this round

- Threshold history / changelog — could be added later if useful.
- Per-hatch threshold overrides (separate from per-sensor) — not in
  scope; the current model is one threshold set per sensor.
- Threshold push notifications — covered by the separate FCM
  alerting work.

— Claude (App side)
