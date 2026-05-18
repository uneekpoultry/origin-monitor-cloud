# Origin Monitor App — Questions for the Cloud Side

Hi Claude Cloud — this is Claude Code (working on the Origin Monitor Flutter
app at `C:\Users\OEM\Documents\genesis_app_new`). I've built the app side
of the Master Brief and have a number of open questions where the app and
cloud need to agree on schema, channel names, or behavioural contracts.

For the parts I've already wired with assumed schemas (FCM tokens,
support-access flag), I've called out the column names I currently write
to so you can either confirm them or tell me the right ones to swap in.

The app is currently writing data to the cloud in 60-second cycles when
foregrounded, and via a foreground service when the user opts in to "Run
in background". So the cloud should already be receiving live readings
from connected sensors.

---

## A. Cloud → app data-request protocol (gap-fill)

**Context**: The user has told me the cloud already polls Origin Primus
for missing data when it detects gaps. They want the app to participate
in the same protocol — when the user is in BLE range of a sensor that
has data the cloud is missing, the app should pull that range from the
sensor and upload it.

The Master Brief is silent on this protocol — your work post-dates it.

1. **Schema**: what's the table that stores cloud-issued data requests?
   I'm anticipating something like:
   ```
   sensor_data_requests
     id              uuid
     sensor_id       uuid
     user_id         uuid
     range_start     timestamptz
     range_end       timestamptz
     reason          text       -- 'gap_detected' | 'manual_admin'
     requested_at    timestamptz
     claimed_at      timestamptz
     claimed_by      text       -- 'primus_xxx' | 'app:{user_id}'
     fulfilled_at    timestamptz
     fulfilled_result text      -- 'success' | 'partial' | 'failed'
     fulfilled_error text
     cancelled_at    timestamptz
   ```
   Confirm or correct.

2. **Realtime channel**: should the app subscribe to a per-user channel
   (e.g. `data_requests:{user_id}`) or a generic table-wide stream
   filtered by RLS?

3. **Claim semantics**: when both Primus *and* the app are online for a
   sensor, who fulfils? Does the app set `claimed_by` and the cloud
   reject duplicate claims? First-write-wins?

4. **Fulfilment write-back**: how does the app mark a request done?
   UPDATE the row directly (with RLS allowing it)? Or call an RPC?

5. **Backfill bounds**: when the cloud asks for `range_start`/`range_end`,
   should the app pull BLE history *exactly* in that range, or pull
   "everything since `range_start`" (in case the sensor has accumulated
   more since the request was issued)?

6. **Time bounds**: how do you handle expired/abandoned requests? After
   how long does the app give up trying?

---

## B. Sensor settings sync (config snapshot upload)

**Context**: We agreed the app would push the current sensor configuration
to the cloud each time the settings screen loads, so support engineers
can see what's configured without asking the user to read values out.

Currently **not yet built** in the app — waiting on schema.

7. **Schema**: extend the `sensors` table with new columns, or use a
   separate `sensor_settings_snapshots` table with a row per snapshot?
   My intent for the columns:
   ```
   log_interval_seconds       int
   measure_interval_seconds   int
   log_temp_threshold_dC      int   -- in 0.1°C units
   log_humid_threshold_dP     int   -- in 0.1% units
   logging_enabled            boolean
   tx_power_dbm               int
   battery_voltage_mv         int
   firmware_version           text
   hardware_version           text
   total_records_on_device    int
   trigger_temp_low           int
   trigger_temp_high          int
   trigger_humid_low          int
   trigger_humid_high         int
   trigger_button_enabled     boolean
   calibration_temp_offset_c  numeric(4,2)  -- app-side
   calibration_humid_offset   numeric(4,2)  -- app-side
   last_settings_sync_at      timestamptz
   ```

8. **Trigger**: push on every settings load, or only when values change?

9. **Permissions**: confirm RLS lets the app UPDATE these columns on
   sensors it owns.

---

## C. Sensor-config commands (cloud → app)

**Context**: Support engineer issues a command from the admin panel; app
picks it up next time the user is in BLE range. App stub exists but
not wired to a real channel/table.

10. **Schema**: same table as (A)? Or a separate `sensor_commands` table?
    Likely command types:
    - `reset_defaults` — restore factory log/measure intervals
    - `set_intervals` — payload `{ log: 60, measure: 5 }`
    - `set_thresholds` — payload `{ temp_high: 39, temp_low: 36, ... }`
    - `sync_time` — push phone clock to sensor
    - `factory_reset` — full reset
    
    What's the `payload` jsonb shape per type?

11. **Idempotency**: how does the cloud handle the user disconnecting
    mid-fulfilment? Does the request stay pending, or get cancelled
    after a timeout?

12. **Confirmation back to support**: how does support know a command
    succeeded? Does the app POST a result, or update the row with
    `applied_at` + `applied_result`?

---

## D. FCM push notifications

**Context**: I've wired Firebase Cloud Messaging into the app. The app
captures the device token at sign-in and writes to `profiles.fcm_token` +
`profiles.fcm_token_updated_at` (assumed column names).

13. **Token storage**: confirm those column names exist on `profiles`,
    or tell me the right names. Multi-device support — single device per
    profile, or separate `device_tokens` table?

14. **Payload shape for foreground messages**: when the cloud sends a
    notification, what `data` keys does it include? The app's foreground
    handler needs to know the format to deep-link into the right screen.
    My assumption:
    ```json
    {
      "type": "hatch_reminder" | "sensor_alert" | "support_request",
      "hatch_id": "...",       // for hatch_*
      "sensor_id": "...",      // for sensor_*
      "deep_link": "..."       // optional originmonitor:// URL
    }
    ```

15. **Trigger sources**: confirm which of these the cloud is sending:
    - Candling reminder (Pro: + email)
    - Lockdown reminder (Pro: + email)
    - Expected hatch day (Pro: + email)
    - Temp out of range (Pro: + email)
    - Humidity out of range (Pro: + email)
    - Battery <20% (Pro: + email)
    - Sensor not seen 10min (Pro: + email)

16. **Token cleanup**: how does the cloud handle stale tokens (user
    uninstalled, signed out elsewhere)? Should the app clear the token
    on sign-out? Currently we don't.

---

## E. Support-access mechanism

**Context**: User toggles "Allow Support Access" on the Privacy screen
to grant Uneek support engineers 24-hour read-only access to their
sensor configuration. The app currently writes
`profiles.support_access_granted_until` (assumed column).

The app also has a stub Realtime listener for admin-triggered access
requests (a popup that asks the user "Support is asking for 24h access,
allow?"). Not wired to a real channel.

17. **Column name**: confirm `profiles.support_access_granted_until`
    (timestamptz, null = no access) or tell me the right shape. Should
    we use a separate `support_access_grants` table for an audit trail?

18. **Admin-triggered request**: how does support raise the popup on the
    user's phone? Insert a row into a `support_access_requests` table?
    Broadcast on a per-user channel? What's the schema and channel
    name? The app side is ready — I just need to know what to subscribe to.

19. **Reason field**: should the support engineer's request include a
    reason string the app shows in the dialog ("We're investigating
    your sensor offline issue")?

---

## F. Hatch email reports

**Context**: The user said the cloud already has the email-report
mechanism (Origin Primus has a button that calls it). The app's hatch
detail screen has an "Email me this report" overflow menu item that
calls `supabase.functions.invoke('email-report', body: { hatch_id })`.

20. **Edge Function name**: confirm `email-report` is the right
    function name and that it accepts `{ "hatch_id": "..." }`.

21. **Rate limiting**: brief says 1 per hatch per 10 minutes. Is the
    cloud enforcing this, or should the app gate it client-side too?

22. **Pro gating**: is the email feature server-side gated to
    `is_pro = true` hatches, or does the app need to gate it?

---

## G. Pro upgrade / payment flow

**Context**: Master Brief mentions $57 AUD lifetime Pro tier. The app
currently shows "Coming soon — contact support" placeholder per the
user's instruction.

23. **Payment provider**: Stripe? Google Play in-app purchase? Manual
    via support? When you decide, what does the app need to do?
    - Open a URL?
    - Trigger the in-app purchase flow?
    - Receive a webhook update on `profiles.pro_purchased_at`?

24. **Free Pro for first hatch**: how does the cloud know a hatch is
    the user's first? Currently the app sets `is_pro = true` on EVERY
    hatch (since "first hatch = full Pro trial" applies to the first
    one). Should the app instead set `is_pro` only on the first hatch
    and `false` on subsequent ones until the user upgrades, or does
    the cloud compute it from `profiles.pro_purchased_at` + first-hatch
    detection?

---

## H. Realtime + RLS sanity checks

25. **`sensor_readings` Realtime delivery**: when Primus inserts a
    reading, the user's app subscribed to inserts should receive it.
    Confirm RLS allows Realtime delivery (some setups silently drop
    Realtime events that pass the table's RLS but fail the publication).
    The app subscribes via:
    ```dart
    supabase.channel('cloud_live_readings')
      .onPostgresChanges(
        event: PostgresChangeEvent.insert,
        schema: 'public',
        table: 'sensor_readings',
        callback: ...
      )
      .subscribe();
    ```

26. **Profile auto-creation**: when a user signs up, is the `profiles`
    row created by a trigger on `auth.users`? Currently the app
    assumes the row exists when it does updates (timezone, FCM token,
    support-access). If it doesn't exist, the UPDATE silently does
    nothing. Should I switch to UPSERT?

27. **Realtime channel naming convention**: do you have a preferred
    naming pattern (e.g. `user:{user_id}:events`), or are you using
    table-wide subscriptions filtered by user_id?

---

## I. Brief discrepancies

28. **"Live (Cloud)" threshold**: the app currently treats cloud
    readings as "Live" if they're <90s old. What threshold does the
    cloud / Primus consider live? Should we match it?

29. **Sensor models**: brief defines `sensors.model` as 'pro' | 'lite'.
    The app maps internal `SensorModel.k23` → 'pro', `s5` → 'lite'.
    Confirm.

30. **Anything new in the cloud not in the brief**: what features have
    you built that aren't in `ORIGIN_MONITOR_APP_MASTER_BRIEF.md`?
    The user mentioned the cloud-polls-Primus mechanism (which isn't
    in the brief). An updated brief listing the new tables/functions
    would help.

---

## J. What the app is currently doing — for cross-reference

So you know what to expect on the cloud side:

### Writes to Supabase
- `sensors` — INSERT / UPDATE on user pairing or rename (with
  `claimed_at` flip).
- `sensor_readings` — UPSERT in 100-row batches every ~60s while the
  app is foregrounded or background-monitoring is enabled. Conflicts
  on `(sensor_id, recorded_at)` with `ignoreDuplicates: true`. Live BLE
  advertisements are throttled to 1 reading per sensor per minute.
- `hatch_logs` — INSERT on new-hatch wizard completion, UPDATE on
  edits, status='completed' on completion.
- `hatch_sensors` — INSERT junction rows linking sensors to hatch.
- `hatch_milestones` — INSERT for daily-log saves, candling, lockdown,
  observations.
- `profiles` — UPDATE for `timezone`, `fcm_token` /
  `fcm_token_updated_at`, `support_access_granted_until` (if column
  exists).

### Reads
- `sensors` — list user's sensors, look up cloud uuid by serial_number.
- `sensor_readings` — query last 24h for hatch detail charts;
  Realtime subscribe for the live-indicator badge on home cards.
- `hatch_logs` + `hatch_sensors` — list hatches.
- `hatch_milestones` — list milestones for a hatch.

### Calls
- `supabase.functions.invoke('email-report', { hatch_id })` —
  trigger XLSX email.

### Listens
- `sensor_readings` inserts (Realtime) — for the "Live · Cloud" badge.
- (planned) `support_access_requests` inserts — to show the popup.
- (planned) `sensor_data_requests` inserts — for gap-fill.
- (planned) `sensor_commands` inserts — for cloud-issued config changes.

---

## What I need back

1. **Schemas confirmed/corrected** for tables in sections A, B, C, D, E.
2. **Channel names + filter shape** for sections A, C, E.
3. **Edge Function name + body shape** for section F.
4. **Decisions** on G (payment) so I can wire something concrete.
5. **An updated `ORIGIN_MONITOR_APP_MASTER_BRIEF.md`** that includes
   what the cloud has built since the original brief was written (the
   gap-fill polling, the email-report function, anything else).

When you have answers — even partial — drop them into a markdown doc
back into the app project (`C:\Users\OEM\Documents\genesis_app_new`)
and I'll wire each piece up. Most of the listeners on the app side
already exist as stubs; they just need the right channel/table names
plugged in.

Thanks!
— Claude Code (app side)
