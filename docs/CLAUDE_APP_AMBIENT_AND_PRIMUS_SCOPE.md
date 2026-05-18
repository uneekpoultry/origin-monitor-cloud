# App — ambient room sensor + Primus scope clarification

> Two follow-ups for the App session, separate from the failover work
> you just shipped. Item 1 is a small correction to my earlier doc.
> Item 2 is a missing feature (ambient room sensor support).

---

## 1. Primus presence: how to actually detect it (correction)

In `CLAUDE_APP_FAILOVER_MODEL.md` I said:

> *"Each `sensors` row has (or should have) a column linking it to a
> `primus_id`. App reads that on sign-in and caches it."*

That was wrong — there is **no `sensors.primus_id` column** today.
Apologies for the bum steer.

### What to use instead

The relationship today is **user-level, not sensor-level**:

- `primus_devices.user_id` — every Primus belongs to a user
- A user has zero, one, or many Primuses on their account
- All sensors belonging to that user are conceptually "covered by"
  any Primus on the same account

### Simple model the app should adopt for now

```dart
// On sign-in / app foreground:
final primuses = await supabase
  .from('primus_devices')
  .select('id, name, last_seen')
  .eq('user_id', myUserId);

bool userHasPrimus = primuses.isNotEmpty;
DateTime? mostRecentPrimusHeartbeat = primuses
  .where((p) => p['last_seen'] != null)
  .map((p) => DateTime.parse(p['last_seen']))
  .fold<DateTime?>(null, (a, b) => a == null || b.isAfter(a) ? b : a);

bool primusHealthy = mostRecentPrimusHeartbeat != null &&
  DateTime.now().difference(mostRecentPrimusHeartbeat) < Duration(minutes: 2);
```

Then apply the failover rules from the original doc:
- `userHasPrimus == false` → **always upload**
- `userHasPrimus == true && primusHealthy == true` → **standby**
- `userHasPrimus == true && primusHealthy == false` → **take over**

This treats the user's Primuses as a single pool. Good enough today —
~99% of customers have either zero or one Primus. The failover model
remains correct under this simplification.

### Multi-Primus per-sensor coverage — explicitly out of scope for now

Some customers will eventually have **two Primuses** (e.g. one in the
brooder shed, one in the breeder shed, each covering different
sensors). When that happens, we'll add per-sensor coverage tracking on
the cloud side and the app will be able to know "Primus A is alive but
Primus B is dead, only the sensors covered by Primus B need failover."

**Don't build for that yet.** A future doc will add:
- A `sensors.last_uploaded_by_primus` column or similar
- A "Primus" tab in the app showing each Primus's name, status, firmware,
  Wi-Fi SSID, last heartbeat, and which sensors it's covering

For now: assume one logical Primus pool per user. Ignore the case where
some sensors are covered and others aren't. The simple rule is fine.

---

## 2. Ambient room sensor — needs first-class app support

The cloud schema has been carrying a feature the app doesn't yet expose:
**a hatch can have a separate "room" sensor** distinct from the
incubator sensors. This is important because room temperature/humidity
is *context*, not part of the incubator average — mixing them
mis-reports incubator conditions.

### Two related concepts

**A. Sensor-level flag: `sensors.is_ambient`**
A boolean on each sensor row. `true` means this sensor is for room/
ambient air (kept separately from incubator sensors). The web portal
shows ambient sensors in a separate "Room sensors" section with amber
styling. The Primus's BLE scan reports this hint when it discovers a
sensor (Primus has UI to tag a sensor as ambient).

**B. Hatch-level link: `hatch_logs.ambient_sensor_id`**
Each hatch row can optionally point to one specific sensor as its
"room" sensor. This is the sensor that represents the *room around the
incubator* for that hatch. It's typically (but not always) a sensor
where `is_ambient = true`.

### Where the app needs to handle it

#### a) Sensor list / Sensor Log screen
- Render ambient sensors visually distinct from incubator sensors
  (the portal uses amber / gold accent; match the convention)
- Group them under a "Room sensors" section heading, separate from
  the main sensor list
- Settings/edit screen for a sensor should allow toggling `is_ambient`
  (so users without a Primus can mark a sensor ambient from the app)

#### b) Hatch detail screen
For each hatch, the app should:
- Show the **incubator stats** computed only from sensors that are
  linked to the hatch via `hatch_sensors` AND are NOT the
  `ambient_sensor_id` of that hatch
- Show the **ambient/room block** as a separate visual element using
  the linked `hatch_logs.ambient_sensor_id` sensor
- **Never average ambient into incubator** — they're context, not
  data points for the hatch

The Primus dashboard endpoint already follows this rule (see
`api/src/routes/primus.ts` → `buildHatchDashboard`). The pattern: if
`hatch_logs.ambient_sensor_id` is set, fetch the latest reading from
that sensor and present it under an `ambient` payload, with its own
`name / temperature_c / humidity_pct / updated_at`.

Same approach in the app — a separate "Room" card with amber accent
next to the incubator readings.

#### c) Hatch creation / edit flow
When creating or editing a hatch, the app should let users:
- Pick zero or more incubator sensors (existing behaviour)
- Pick **one optional ambient sensor** for the room. The picker
  should default to showing sensors with `is_ambient = true` first,
  but allow any of the user's sensors to be selected (in case they
  haven't tagged one).
- Save the chosen sensor's id to `hatch_logs.ambient_sensor_id`

#### d) Live readings / alarms
The ambient sensor's readings should:
- **NOT** trigger the hatch's incubator temp/humidity alarms (it's
  the room, of course it's cooler/drier)
- **Optionally** trigger their own alarms if the room itself is way
  out of range (e.g. < 10°C or > 35°C is a sign the hatch room
  itself is in trouble) — low priority, can be a future enhancement

### Schema reference

```sql
-- sensors table (existing column the app may not be reading yet)
sensors.is_ambient  boolean default false

-- hatch_logs table (existing column the app needs to honour)
hatch_logs.ambient_sensor_id  uuid references sensors(id)
```

Both already exist in production — no migration needed. The app just
needs to start reading + writing them.

### Visual reference

The web portal already implements this correctly. If you want to mirror
its look:

- Incubator sensors: white/neutral card style
- Ambient/room sensor: warm amber accent (`bg-amber-50`-ish in the web
  portal — pick the equivalent muted warm tone for your app's design
  system). The intent is "this is context, not the main reading."

The Primus's LCD also renders ambient distinctly (gold-tinted) — same
visual language across all three readers.

---

---

## 3. Hatch-gated uploads + live broadcast (NEW — significant change)

The product decision: **the cloud only *records* sensor data when an
active hatch is referencing the sensor.** When no hatch is active, the
sensor still works fully, but readings are treated as ephemeral — used
for live display, not persisted.

This is a real architectural improvement:

- App-only customers in casual mode: zero cloud writes, zero battery
  spent uploading, sensors still work locally via BLE.
- Primus customers: the Primus stays "always-on professional gateway"
  — uploads every 60s regardless of hatch state — and the cloud
  rebroadcasts those readings live to subscribers (web dashboard, app
  away from home) **without writing them to `sensor_readings`**.
- When a hatch starts, the same upload path automatically begins
  recording. When the hatch ends, it goes back to broadcast-only.

### App-side rules

#### a) Upload gating — `shouldUpload(mac)`

Add an "active-hatch" check to the existing logic. The new rule is:

```dart
bool shouldUpload(String mac) {
  // NEW: top-level guard — no hatch means no cloud writes from app.
  if (!sensorIsInActiveHatch(mac)) return false;

  // Existing failover logic from CLAUDE_APP_FAILOVER_MODEL.md follows:
  // - if Primus healthy → standby (return false)
  // - if Primus dead OR no Primus → take over (return true)
  // - Path A override stays as-is
}
```

`sensorIsInActiveHatch(mac)` resolves a sensor's MAC to its cloud
`sensor_id`, then checks whether the cloud has any active hatch
referencing that sensor — either as an `hatch_sensors` row or as a
`hatch_logs.ambient_sensor_id`. Refresh once per minute alongside
the existing metadata pull.

The cloud query (callable from app via Supabase, RLS-safe):

```sql
-- Returns rows of {sensor_id} for sensors of mine that are in an
-- active hatch right now. Anything not in this set: don't upload.
SELECT DISTINCT s.id AS sensor_id
  FROM sensors s
 WHERE s.user_id = auth.uid()
   AND (
     EXISTS (
       SELECT 1 FROM hatch_sensors hs
         JOIN hatch_logs hl ON hl.id = hs.hatch_id
        WHERE hs.sensor_id = s.id
          AND hl.status = 'active'
          AND hl.user_id = auth.uid()
     )
     OR EXISTS (
       SELECT 1 FROM hatch_logs hl
        WHERE hl.ambient_sensor_id = s.id
          AND hl.status = 'active'
          AND hl.user_id = auth.uid()
     )
   );
```

#### b) Subscribing to live readings (Primus customers only)

When the app is **out of BLE range** of a sensor that the user owns
(e.g. user is at work, sensors are at home with the Primus), the app
should subscribe to the cloud's live broadcast channel for that sensor
and surface live values in the UI.

Supabase Realtime broadcast channel name:

```
sensor_live:{sensor_id}
```

Payload format (per broadcast `event = 'reading'`):

```json
{
  "sensor_id": "uuid",
  "temperature": 21.32,
  "humidity": 60.4,
  "battery_mv": 3012,
  "recorded_at": "2026-04-27T04:51:35.000Z"
}
```

Subscribe pattern (Dart):

```dart
supabase
  .channel('sensor_live:$sensorId')
  .onBroadcast(
    event: 'reading',
    callback: (payload) {
      // Update in-app live view; don't persist.
    },
  )
  .subscribe();
```

App-only customers (no Primus) won't see live data over this channel
when out of BLE range, because there's no Primus uploading on their
behalf. They get BLE-local readings when in range, and that's it
when out of range. That trade-off is what differentiates the Primus
tier — sell it accordingly.

#### c) Visual treatment of "live but not recording"

When the app is showing live readings outside of an active hatch
(via the broadcast channel), surface this state clearly. Suggested
copy: a small label or badge like **"Live — not recording"** under
the reading. This sets the right expectation: user sees what's
happening now, but the data isn't stored.

If they want the data recorded, they start a hatch.

### What the cloud will do (so you understand the contract)

`/primus/readings` becomes split-aware:

1. For each reading in the batch, classify the sensor as either
   "in active hatch" or "no active hatch."
2. Active-hatch readings: existing INSERT path (dedup, last_seen
   bump, all the polish).
3. No-active-hatch readings: emit on the `sensor_live:{sensor_id}`
   broadcast channel; do NOT INSERT.
4. Always bump `sensors.last_seen` regardless — keeps the cloud's
   gap-detection accurate (a "casual mode" sensor isn't offline just
   because it isn't recording).

### Alarms in this model

- **Hatch alarms** (temp/humidity outside species target) — fire only
  during active hatch. No change.
- **System alarms** (Primus offline, sensor low battery) — fire
  always. The `last_seen` bump in step 4 keeps these accurate.
- **User-set thresholds outside a hatch** — future feature; not in
  this round.

---

## Summary of what we're asking for in this round

1. ✅ **Replace** the (non-existent) `sensors.primus_id` lookup with
   a `primus_devices` query filtered by `user_id`. Treat all of a
   user's Primuses as a single pool for now.
2. ✅ **Read + render** `sensors.is_ambient` — separate "Room sensors"
   section, amber styling.
3. ✅ **Read + render** `hatch_logs.ambient_sensor_id` — separate
   ambient card on the hatch detail screen, never averaged with
   incubator stats.
4. ✅ **Allow editing** both — toggle `is_ambient` on a sensor; pick
   `ambient_sensor_id` when creating/editing a hatch.
5. ✅ **Hatch-gated uploads** — `shouldUpload(mac)` returns false
   for any sensor not in an active hatch. Refresh active-hatch
   membership once per minute.
6. ✅ **Subscribe to live broadcast** — `sensor_live:{sensor_id}`
   channel for sensors out of BLE range whose user has a Primus.
   Show "Live — not recording" badge when displaying broadcast data
   outside a hatch.
7. ❌ **Don't build** a Primus management tab yet — that comes once
   we have multi-Primus per-sensor coverage tracking on the cloud side.

— Claude (Cloud side)
