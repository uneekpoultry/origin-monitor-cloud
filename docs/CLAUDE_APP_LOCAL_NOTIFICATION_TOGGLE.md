# App — local "Notify me on this phone" toggle (alert behaviour fix)

> Follow-up to the global settings sync work just shipped. The settings
> read/write paths are working correctly across Primus, App, and Cloud.
> But the App's handling of the `alert_*_enabled` fields is conflating
> two different concepts and surfacing as a real UX problem during
> Andrew's testing today (2026-05-08).

---

## The user scenario this fixes

> *"I'm at work. The phone is in my pocket. Earlier today I had alerts
> turned off on this phone — I don't want it buzzing during meetings.
> But Mary's at the farm, standing in front of the Primus, and she
> dials in alert thresholds for one of the sensors and turns alerts on.*
>
> *Two minutes later my phone starts beeping in the middle of a meeting,
> because the App auto-enabled alerts on my device when the Primus's
> change came in via Realtime."*

That's the bug. The Primus enabling an alert for a *sensor* should NOT
auto-enable alerts on every other device that happens to be subscribed
to that sensor's settings.

The same thing happens with the user themselves on a different device:
they change something on the Primus while at the farm, then go to work
and forget. Phone starts firing alerts they had silenced earlier.

This is especially bad for the App because the phone is the *personal*
device — silencing it should mean silencing it, regardless of what
other devices think.

---

## The conceptual split

The current `alert_*_enabled` field in the cloud's `sensors.settings`
JSONB conflates two distinct things:

| Concept | Scope | Source of truth | Should sync? |
|---|---|---|---|
| **Is this alert configured for the sensor?** | Per-sensor, global | Cloud `sensors.settings` | Yes |
| **Does THIS device act on it (sound, vibrate, push notify)?** | Per-device, per-user-on-this-app | App local storage | No |

Cloud holds: *"the user wants the sensor to alert if temp > 38.5"*.
That's a sensor configuration fact. It syncs.

Each device decides locally: *"does my notifications/sounds layer
respond when the cloud says an alert fires?"*. That's a device
behaviour preference. It does NOT sync.

These are independent. A user can:

- Have alerts **configured** on the sensor (cloud `alert_*_enabled: true`)
  AND **muted** on this phone (App local "Notify me here" off)
- Have alerts **configured** on the sensor AND **active** on the phone
  (both true) — phone makes noise when threshold crossed
- Have alerts **not configured** on the sensor at all (cloud
  `alert_*_enabled: false`) — nothing fires anywhere regardless

Today the App is treating the cloud value as if it controls both
concepts. It doesn't. It controls the first only.

---

## Implementation

### 1. Add a local-only "Notify me on this phone" toggle

Where it lives: SharedPreferences (or your existing local prefs store),
keyed per-sensor per-user:

```dart
final key = 'notify_on_device_${sensorId}_${userId}';
final notifyHere = prefs.getBool(key) ?? false;  // off by default
```

**Default: OFF.** Users opt IN to alerts on each device. Conservative
because the failure mode of accidentally beeping in a meeting is worse
than missing one notification.

### 2. Settings UI — show both layers clearly

The sensor settings screen should distinguish:

```
┌────────────────────────────────────────────────┐
│ Alerts (sensor configuration)                  │
│                                                │
│   Temp high:  38.5 °C       [enabled ✓]        │
│   Temp low:   15.0 °C       [enabled ✓]        │
│   Humid high: 80 %          [enabled ✓]        │
│   Humid low:  20 %          [enabled ✓]        │
│                                                │
│   These thresholds and toggles are shared      │
│   with the Primus and any other devices on     │
│   your account.                                │
├────────────────────────────────────────────────┤
│ This phone                                     │
│                                                │
│   🔔 Notify me on this phone:        [OFF]    │
│                                                │
│   When ON, this phone will sound, vibrate,     │
│   and push-notify when an alert fires above.   │
│   When OFF, this phone stays silent — alerts   │
│   may still fire on the Primus or another      │
│   device.                                      │
└────────────────────────────────────────────────┘
```

The top half is what's stored in `sensors.settings` (synced cloud-side).
The bottom half is purely local.

### 3. Realtime update handler — never touch the local toggle

When a Realtime update for `sensors` arrives:

```dart
void onRealtimeSensorUpdate(Map<String, dynamic> row) {
  final sensorId = row['id'] as String;
  final settings = row['settings'] as Map<String, dynamic>? ?? {};
  final remoteUpdatedAt = row['settings_updated_at'] != null
    ? DateTime.parse(row['settings_updated_at']).toUtc()
    : null;

  // ✅ Update threshold values + cloud enables (these reflect the
  //    sensor's intended configuration — syncs across devices)
  updateLocalCacheForSensor(sensorId, settings, remoteUpdatedAt);

  // ✅ Refresh the settings UI if it's open for this sensor
  notifyListenersIfWatching(sensorId);

  // ❌ DO NOT touch the local "notify_on_device_${sensorId}" preference.
  //    That's per-device, set only by the user, never by Realtime.

  // ✅ Brief toast so the user sees something updated
  showToast('Settings updated from another device');
}
```

The key line is the last comment: **never write to the local
`notify_on_device_*` preference from Realtime**. That preference is
set ONLY by the user toggling the switch on the settings screen.

### 4. Alert delivery layer — gate on BOTH

When a sensor reading crosses a threshold and an alert needs to fire,
the alert engine checks BOTH layers:

```dart
bool shouldFireAlertOnThisDevice(String sensorId, AlertType type) {
  final settings = currentSettingsFor(sensorId);
  if (settings == null) return false;

  // 1. Is the alert configured (cloud)?
  final cloudEnabled = settings[alertEnabledKeyFor(type)] as bool? ?? false;
  if (!cloudEnabled) return false;

  // 2. Does this phone want to act on it (local)?
  final notifyHere = prefs.getBool('notify_on_device_${sensorId}_${userId}') ?? false;
  if (!notifyHere) return false;

  // Both true — fire on this device
  return true;
}
```

This is the actual safety. Cloud says "yes, this alert is configured."
Local says "yes, this device should act on it." Both true → fire. Either
false → silent on this device.

### 5. Don't write the local toggle to cloud

Make absolutely sure the "Notify me on this phone" toggle is never
included in any `update` or `upsert` against the `sensors.settings`
JSONB. It lives in local prefs only. If you accidentally include it,
it'll sync to other devices and we're back to the original bug.

---

## Acceptance test

1. **Setup.** On the App, set "Notify me on this phone" to OFF for
   sensor X. Set alerts for sensor X (cloud) to enabled with a low
   threshold so they'd normally fire.
2. **From Primus**, change a threshold value (or just save the
   settings screen). Wait for Realtime to propagate.
3. **App receives the update.** The threshold value updates in the
   App's settings UI. The "Notify me on this phone" toggle on the App
   stays OFF.
4. **Cause an alert** (e.g., set temp threshold below current reading).
   App makes NO sound. Primus makes its sound (because Primus has its
   own local enable). App settings UI shows the alert configured but
   the phone stays quiet.
5. **User toggles "Notify me on this phone" to ON.** Next threshold
   crossing → App fires push notification + sound on this phone only.
6. **User goes to a different phone, signs in to same account.** That
   phone has its own "Notify me on this phone" preference — defaults
   to OFF. Cloud values sync across, local toggle does not.

---

## What NOT to change

- The `sensors.settings` JSONB schema. Cloud stays as-is.
- The Realtime subscription on `sensors`. Stays as-is.
- The cloud's PATCH endpoint. Stays as-is.
- Primus firmware. Doesn't need to know this exists — it has its own
  local "buzzer on/off" master in the LCD UI for the same reason.

This is a **purely App-side change**. Local storage gains one new
preference key per sensor. Settings UI gains one toggle. Realtime
handler stops writing the local preference. Alert delivery gates on
the local preference too.

---

## Why this is important specifically for the App

The Primus is a fixed, dedicated device sitting in the hatch room. If
its buzzer goes off, that's appropriate and expected.

The phone is the *user's personal device*. If it suddenly starts
beeping during a meeting, on the bus, at dinner, in bed — that's a
user-control failure. Making the local toggle the only thing that
controls device behaviour means the user's personal context (silenced,
do-not-disturb, away from the farm) is always respected.

Customers will forgive missing one notification from time to time.
They will not forgive their phone making noise when they explicitly
turned it off.

— Claude (Cloud session)
