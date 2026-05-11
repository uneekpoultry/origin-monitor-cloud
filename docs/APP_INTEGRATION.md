# Origin Monitor — Flutter App Integration Brief

> Paste this entire document into the Claude Code session that is building the **Origin Monitor** Android app.

---

## 1. Architecture

```
Origin Monitor app (Flutter, Android)
   │
   ├── BLE → Origin Pro / Origin Lite sensors (already working — keep as is)
   │
   └── HTTPS → Supabase (auth, cloud database, real-time)
                  ↑
                  └── Same Supabase instance the Origin Primus basestation
                      posts readings into. App reads whatever Primus wrote.
```

**The app talks directly to Supabase. It does NOT talk to `api.originmonitor.com`** — that API is exclusively for Primus basestations (which use a device API key, not a user JWT). The app uses the Supabase Flutter SDK, which handles auth JWTs and refresh automatically.

---

## 2. Credentials

Hard-code these in the app (they're safe to embed — RLS protects data):

```dart
const supabaseUrl = 'https://txdpdotzmiwknrkewngj.supabase.co';
const supabasePublishableKey = 'sb_publishable_-VdOAAP7AOx-d8WlHXDboQ_03awJsod';
```

**Do NOT ever embed** `sb_secret_...` in the app. That key bypasses RLS — server-only.

---

## 3. SDK setup

```yaml
# pubspec.yaml
dependencies:
  supabase_flutter: ^2.8.0
  app_links: ^6.3.2      # for deep-link OTP callbacks
```

```dart
// main.dart
import 'package:supabase_flutter/supabase_flutter.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Supabase.initialize(
    url: 'https://txdpdotzmiwknrkewngj.supabase.co',
    anonKey: 'sb_publishable_-VdOAAP7AOx-d8WlHXDboQ_03awJsod',
  );
  runApp(const MyApp());
}

final supabase = Supabase.instance.client;
```

---

## 4. Deep links for auth callbacks

Supabase email links (magic link, password reset, email confirmation) need to deep-link back into the app. Configure:

**AndroidManifest.xml** — add an intent filter to your main Activity:

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="originmonitor" android:host="auth" />
</intent-filter>
```

**Supabase dashboard** — add `originmonitor://auth/callback` to the Redirect URLs allowlist (Authentication → URL Configuration).

When calling any auth method that sends an email, pass `emailRedirectTo: 'originmonitor://auth/callback'`. The Supabase SDK automatically handles the callback when the deep link fires.

---

## 5. Auth flows

All three work out of the box with the Supabase SDK:

### Sign up (password)

```dart
final res = await supabase.auth.signUp(
  email: email,
  password: password,
  emailRedirectTo: 'originmonitor://auth/callback',
  data: {
    'full_name': fullName,
    // Phone's local IANA timezone, e.g. "Australia/Perth". Used by the
    // cloud for email hatch reminders and admin support tooling.
    'timezone': DateTime.now().timeZoneName, // see note below
  },
);
```

**Note on `timezone`**: Dart's `DateTime.now().timeZoneName` gives a short name like `"AWST"`, not an IANA name — that's not what the cloud expects. Use a package that resolves the IANA name, or the platform channel equivalent:

- Flutter: [`flutter_timezone`](https://pub.dev/packages/flutter_timezone) → `await FlutterTimezone.getLocalTimezone()` returns `"Australia/Perth"`.
- iOS native: `TimeZone.current.identifier`
- Android native: `TimeZone.getDefault().getID()`

All three return IANA names. Send that string as `timezone` at signup AND on every login / app start:

```dart
// After any sign-in (password or magic link), sync the profile TZ
final tz = await FlutterTimezone.getLocalTimezone(); // e.g. "Australia/Perth"
await supabase.from('profiles')
  .update({'timezone': tz})
  .eq('id', supabase.auth.currentUser!.id);
```

Only update on login — not on every BLE reading — or you'll waste DB writes.

### Sign in (password)

```dart
final res = await supabase.auth.signInWithPassword(
  email: email,
  password: password,
);
```

### Magic link

```dart
await supabase.auth.signInWithOtp(
  email: email,
  emailRedirectTo: 'originmonitor://auth/callback',
);
```

### Password reset

```dart
await supabase.auth.resetPasswordForEmail(
  email,
  redirectTo: 'originmonitor://auth/callback',
);
```

### Sign out

```dart
await supabase.auth.signOut();
```

### Session listening

```dart
supabase.auth.onAuthStateChange.listen((data) {
  final session = data.session;
  // rebuild UI based on session
});
```

The SDK persists sessions in secure storage and auto-refreshes JWTs. You don't need to manage tokens yourself.

---

## 6. Database tables the app uses

RLS is **enabled on all tables**. The app's JWT only grants access to the user's own rows.

### `profiles` (auto-populated on signup)

```
id                   uuid     (= auth.users.id)
full_name            text
phone                text
country              text     (default 'AU')
notification_email   boolean
notification_push    boolean
is_admin             boolean  (app should NOT allow self-promotion)
created_at           timestamptz
```

### `sensors` (app writes this when a user pairs a sensor over BLE)

```
id                    uuid           (gen_random_uuid)
user_id               uuid           (= auth.uid())
serial_number         text unique    (from BLE advertisement / MAC)
model                 text           ('pro' or 'lite')
name                  text           (user-assigned, or BLE advertised name)
claimed_at            timestamptz    (null = pending — discovered by Primus but not named by a human yet)
discovered_by_primus  uuid           (which Primus first saw it, nullable)
calibration_date      date
calibration_due_date  date
calibration_certificate_url  text   (admin-uploaded, read-only for app)
registered_at         timestamptz
last_seen             timestamptz   (updated whenever readings arrive)
firmware_version      text
```

**`claimed_at` semantics** — if the Primus sees a sensor before the user opens the app, a pending row exists with `claimed_at IS NULL`. When the user pairs that sensor via the app, the app should **claim** the existing row (UPDATE), not INSERT a new one — the unique constraint on `serial_number` would reject a duplicate anyway.

### `sensor_readings` (app only reads — Primus writes via API)

```
id             uuid
sensor_id      uuid
temperature    real
humidity       real
battery_mv     int
recorded_at    timestamptz
```

### `hatch_logs` (app's main write target)

```
id                    uuid
user_id               uuid
name                  text
species               text                (matches SPECIES_PRESETS values — 'chicken', 'duck', 'muscovy', 'goose', 'turkey', 'quail_jap', 'quail_bw', 'pheasant', 'guinea', 'peafowl', 'other')
egg_count             int
start_date            date
expected_hatch_date   date
actual_hatch_date     date
hatched_count         int
fertile_count         int                 (from candling, optional)
died_in_shell         int                 (fully-formed, didn't pip — optional)
pipped_not_hatched    int                 (optional)
early_deaths          int                 (quitters, early-dev failures — optional)
notes                 text
status                text                ('active' | 'completed' | 'failed')
is_pro                boolean             (true = unlocks multi-hatch + analytics)
created_at            timestamptz
```

**Sensor links are in a separate junction table** `hatch_sensors` — a hatch can link to many sensors. See section 7 for the insert pattern.

### `hatch_sensors` (junction table linking hatches ↔ sensors)

```
hatch_id   uuid   references hatch_logs(id) on delete cascade
sensor_id  uuid   references sensors(id)    on delete cascade
added_at   timestamptz
primary key (hatch_id, sensor_id)
```

RLS requires the user owns both the hatch and the sensor to create links.

### `primus_devices` (read-only from app — admin/server manages)

App can list the user's registered Primus basestations; cannot write.

---

## 7. Common queries

### Register a sensor after BLE pairing

When the user pairs a sensor in the app, there are two possible states to handle:

**A. Brand new sensor (cloud doesn't know about it yet)** — direct insert:

```dart
await supabase.from('sensors').insert({
  'serial_number': bleMacAddress,      // colon-separated uppercase MAC
  'model': detectedModel,              // 'pro' or 'lite' — detect from advertised name or manufacturer data
  'name': userEnteredName,             // required — ask the user to name it
  // claimed_at defaults to now() — marks it as claimed immediately
});
```

Don't set `user_id` — RLS forces it to `auth.uid()`. Don't set `claimed_at` — DB default is `now()` on direct inserts.

**B. Sensor already discovered by the user's Primus (pending)** — claim it instead:

Before inserting, check whether the cloud already has the sensor as pending:

```dart
final existing = await supabase
  .from('sensors')
  .select('id, claimed_at, user_id')
  .eq('serial_number', bleMacAddress)
  .maybeSingle();

if (existing == null) {
  // Path A — direct insert (see above)
} else if (existing['claimed_at'] == null) {
  // Path B — claim the pending sensor
  await supabase.from('sensors').update({
    'name': userEnteredName,
    'model': detectedModel,
    'claimed_at': DateTime.now().toUtc().toIso8601String(),
  }).eq('id', existing['id']);
} else {
  // Already claimed. If it's the same user, just update the name; otherwise error.
  if (existing['user_id'] == currentUserId) {
    await supabase.from('sensors').update({
      'name': userEnteredName,
    }).eq('id', existing['id']);
  } else {
    throw Exception('This sensor is registered to another account.');
  }
}
```

### Model detection from BLE

Factory-fresh Origin sensors broadcast their model as the Complete Local Name:

- `"Origin Pro"` → `model = 'pro'`
- `"Origin Lite"` → `model = 'lite'`

Once the user renames the sensor (via this app or Primus), the advertised name changes but the underlying model doesn't. Fall back to whatever manufacturer-data / service-UUID logic your BLE scanner already uses to identify K23 vs S5 hardware.

### List the user's sensors

```dart
// Claimed sensors — the ones the user has actively named
final claimed = await supabase
  .from('sensors')
  .select()
  .not('claimed_at', 'is', null)
  .order('registered_at', ascending: false);

// Pending sensors — discovered by Primus but not yet named by the user.
// Show these in a separate "Needs naming" section so the user can claim them.
final pending = await supabase
  .from('sensors')
  .select()
  .is_('claimed_at', null)
  .order('registered_at', ascending: false);
```

### Get last 24 hours of readings for a sensor

```dart
final readings = await supabase
  .from('sensor_readings')
  .select('recorded_at, temperature, humidity, battery_mv')
  .eq('sensor_id', sensorId)
  .gte('recorded_at', DateTime.now().subtract(const Duration(hours: 24)).toIso8601String())
  .order('recorded_at', ascending: true);
```

### Push readings from app BLE → cloud (optional — useful when no Primus)

If the user doesn't have a Primus, the app can push sensor readings directly so they have cloud history and cross-device sync. Rate-limit on the client side — don't send every BLE advertisement. Batch every 60 seconds, drop duplicate readings, max ~100 rows per batch:

```dart
// Every 60s, flush the local buffer of BLE readings to the cloud.
final rows = localReadingBuffer.take(100).toList();
if (rows.isNotEmpty) {
  await supabase.from('sensor_readings').insert(
    rows.map((r) => {
      'sensor_id': r.sensorId,
      'temperature': r.temperature,
      'humidity': r.humidity,
      'battery_mv': r.batteryMv,
      'recorded_at': r.recordedAt.toUtc().toIso8601String(),
    }).toList(),
  );
  localReadingBuffer.removeRange(0, rows.length);
}
```

RLS enforces that each `sensor_id` in the batch belongs to the authenticated user — attempts to write for someone else's sensor fail with a policy violation.

**When both app AND Primus are active**, the app posting is redundant (Primus does it too). Either:

- **Skip it when a Primus has heartbeat'd recently** — check `primus_devices.last_seen` for the user; if within 3 minutes, don't push from the app.
- **Or always push** and tolerate duplicates — the rows are cheap, and `recorded_at` differences mean nothing dedupes. Simplest to implement but doubles the data volume.

### Subscribe to live sensor changes (name updates from web / Primus)

A customer may rename a sensor from the web portal or the Primus UI. The app should reflect the new name immediately. Subscribe to the `sensors` table once on boot:

```dart
final sensorsChannel = supabase
  .channel('sensors:user')
  .onPostgresChanges(
    event: PostgresChangeEvent.all,
    schema: 'public',
    table: 'sensors',
    callback: (payload) {
      final newRow = payload.newRecord;
      final oldRow = payload.oldRecord;
      // UPDATE → refresh the sensor in local state (name, model, last_seen...)
      // INSERT → a new sensor appeared (e.g. Primus discovered one)
      // DELETE → sensor was unregistered — remove from UI
      refreshLocalSensorState();
    },
  )
  .subscribe();
```

No filter is needed — RLS already scopes rows to `auth.uid()`, so the channel only delivers this user's sensor events.

To push a name change from the app:

```dart
await supabase
  .from('sensors')
  .update({'name': newName})
  .eq('id', sensorId);
```

Primus picks this up within 60s (it polls `GET /primus/sensors`). Web portal shows it on next navigation.

### Subscribe to live sensor readings (pushed when Primus POSTs)

```dart
final channel = supabase
  .channel('readings:$sensorId')
  .onPostgresChanges(
    event: PostgresChangeEvent.insert,
    schema: 'public',
    table: 'sensor_readings',
    filter: PostgresChangeFilter(
      type: PostgresChangeFilterType.eq,
      column: 'sensor_id',
      value: sensorId,
    ),
    callback: (payload) {
      final row = payload.newRecord;
      // update UI with row['temperature'], row['humidity'], etc.
    },
  )
  .subscribe();

// Remember to .unsubscribe() when the screen closes.
```

### Create a hatch log (with multiple sensors)

```dart
// 1. Create the hatch row. Don't set user_id — RLS forces it to auth.uid().
//    Don't put sensor_id on this row; sensor linking is done separately.
final hatch = await supabase.from('hatch_logs').insert({
  'name': 'Sussex batch 1',
  'species': 'chicken',        // use the enum-style value, not the display label
  'egg_count': 24,
  'start_date': DateTime.now().toIso8601String().substring(0, 10),
  'expected_hatch_date': DateTime.now().add(const Duration(days: 21)).toIso8601String().substring(0, 10),
  'is_pro': false,
}).select().single();

// 2. Link any number of sensors via the junction table.
final links = selectedSensorIds
  .map((sid) => {'hatch_id': hatch['id'], 'sensor_id': sid})
  .toList();
if (links.isNotEmpty) {
  await supabase.from('hatch_sensors').insert(links);
}
```

### Record hatch results

When the hatch completes, update the hatch row with the full breakdown:

```dart
await supabase.from('hatch_logs').update({
  'status': 'completed',
  'actual_hatch_date': DateTime.now().toIso8601String().substring(0, 10),
  'fertile_count': fertileCount,          // optional, null if unknown
  'hatched_count': hatchedAlive,          // required
  'died_in_shell': diedInShell,           // optional
  'pipped_not_hatched': pipped,           // optional
  'early_deaths': earlyDeaths,            // optional
}).eq('id', hatchId);
```

The web portal has a "Record hatch results" form with live hatch-rate / fertility-rate / hatch-of-fertile previews as the user types — mirror that UX in the app. The portal recalculates the rates in real time; you can do the same client-side with simple arithmetic.

---

## 8. Local BLE data vs cloud data

**Keep the current architecture where the app reads live data from BLE advertisements directly.** The cloud is for:

- Sync across the user's devices (phone + tablet)
- Remote viewing when the user is away from the hatchery
- Historical backup
- Primus-sourced readings when the phone isn't in Bluetooth range

When the phone has a BLE advertisement AND a recent cloud reading, prefer the BLE one (it's fresher). Fall back to the most recent `sensor_readings` row when no ad for ≥30s.

---

## 9. Product naming (authoritative — the original spec doc is stale)

- **Origin Monitor** — this Android app
- **Origin Pro** — $95 AUD flagship sensor (IP67, factory calibrated)
- **Origin Lite** — $55 AUD compact sensor
- **Origin Primus** — WiFi basestation (posts readings to the cloud)
- **Origin Arca** — cabinet incubator (future)
- **Origin Calibration Kit** — salt-solution humidity reference
- **Origin Scale / Origin Pulse** — future add-ons

Database enum values use short forms: `sensors.model` is `'pro' | 'lite'`.

---

## 10. Brand tokens for UI

Match the portal's gold-on-black aesthetic:

```dart
const Color bronze = Color(0xFF8A6818);   // dark accent
const Color gold   = Color(0xFFC49A46);   // primary accent / CTA
const Color cream  = Color(0xFFE5C880);   // soft highlights
const Color ink    = Color(0xFF0A0F0A);   // backgrounds / dark surface
const Color paper  = Color(0xFFFFFFFF);   // light text on dark
```

Logo asset: `https://originmonitor.com/logo.png` (gold rooster badge, 512×512 PNG with transparent background).

---

## 11. Push notifications (later)

Deferred. The plan: Supabase database webhook on `sensor_readings` INSERT → Cloud Function → FCM push for alerts (temperature out of range, hatch due today, etc.). Do NOT implement FCM wiring in the app yet — build the UI for alerts first and pull from a server-side alerts table when it exists.

---

## 12. Known gotchas

- Supabase URLs must include `auth` deep link redirects in the allowlist **or the links silently fall back to the web portal** (`https://originmonitor.com`).
- PKCE code_verifier is stored in Flutter secure storage. If the user clears app data between requesting a link and clicking it, the verifier is lost and the token appears "expired."
- `supabase.from('sensors').insert(...)` without specifying `user_id` is correct — RLS enforces it. Passing a different `user_id` will fail with a policy violation.
- `Supabase.instance.client.auth.currentSession` is a synchronous read of the cached session; use `await supabase.auth.refreshSession()` if you need a definitely-fresh JWT before a critical action.

---

## 13. Useful URLs

- Customer web portal: https://originmonitor.com
- Cloud API (Primus only — app doesn't use): https://api.originmonitor.com
- Supabase dashboard: https://supabase.com/dashboard/project/txdpdotzmiwknrkewngj
