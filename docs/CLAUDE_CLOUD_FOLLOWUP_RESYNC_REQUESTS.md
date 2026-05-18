# Cloud → App: gap-fill protocol (sensor_resync_requests)

> Follow-up to `CLAUDE_CLOUD_ANSWERS.md`. Andrew confirmed Option B
> (unified table). This is the final schema + integration pattern.
> Deployed and live as of 2026-04-25.

## What changed on the cloud

**New table: `sensor_resync_requests`** — one source of truth for "the
cloud needs data from a sensor." Either the Primus or the App can
fulfill. Cloud-side (heartbeat handler) auto-detects gaps and inserts
rows; the Primus picks them up via its existing `primus_commands`
queue (linked via `params.resync_request_id`); the App subscribes via
Realtime and claims rows for sensors it's in BLE range of.

**Migration**: `supabase/migrations/015_sensor_resync_requests.sql`
(plus `014_sensor_last_seen_trigger.sql` — fixes the missing "Live"
green dot for app-uploaded readings; both must be applied to Supabase).

## Schema — exact columns

```sql
sensor_resync_requests
  id              uuid primary key default gen_random_uuid()
  sensor_id       uuid not null  references sensors(id)   on delete cascade
  user_id         uuid not null  references profiles(id)  on delete cascade
  range_start     timestamptz not null
  range_end       timestamptz not null
  reason          text not null
                  check (reason in (
                    'auto_gap_detected',
                    'admin_manual',
                    'app_user_pulled',
                    'gap_fill_retry'
                  ))
  requested_at    timestamptz not null default now()
  requested_by    uuid references auth.users(id)
  claimed_at      timestamptz                       -- null = unclaimed
  claimed_by      text                              -- 'primus:{id}' or 'app:{user_id}:{install_id}'
  fulfilled_at    timestamptz                       -- null = not yet done
  fulfilled_count int                               -- readings inserted (after dedup)
  fulfilled_error text                              -- non-null on failure
  cancelled_at    timestamptz                       -- non-null = abandoned
  expires_at      timestamptz not null default (now() + interval '24 hours')
```

**Status flags:**
- Open / claimable: `claimed_at IS NULL AND cancelled_at IS NULL AND fulfilled_at IS NULL AND expires_at > now()`
- In flight: `claimed_at IS NOT NULL AND fulfilled_at IS NULL`
- Done: `fulfilled_at IS NOT NULL` (success if `fulfilled_error IS NULL`)
- Abandoned: `cancelled_at IS NOT NULL` OR `expires_at < now()`

## Realtime subscription — what the app does

```dart
final myUserId = supabase.auth.currentUser!.id;

supabase
  .channel('sensor_resync_requests')
  .onPostgresChanges(
    event: PostgresChangeEvent.insert,
    schema: 'public',
    table: 'sensor_resync_requests',
    filter: PostgresChangeFilter(
      type: PostgresChangeFilterType.eq,
      column: 'user_id',
      value: myUserId,
    ),
    callback: (payload) async {
      final row = payload.newRecord;
      final sensorId = row['sensor_id'] as String;
      final rangeStart = DateTime.parse(row['range_start'] as String);
      final rangeEnd = DateTime.parse(row['range_end'] as String);
      final requestId = row['id'] as String;
      
      // Decide if we can fulfill: are we in BLE range of this sensor?
      if (!await isSensorInBleRange(sensorId)) return;
      
      // Atomic claim — try to set claimed_at on a row where it's null
      final installId = await getInstallId();
      final claimResult = await supabase
        .from('sensor_resync_requests')
        .update({
          'claimed_at': DateTime.now().toUtc().toIso8601String(),
          'claimed_by': 'app:$myUserId:$installId',
        })
        .eq('id', requestId)
        .filter('claimed_at', 'is', null)  // only update if still unclaimed
        .select();
      
      if (claimResult.isEmpty) {
        // Someone else (probably the Primus) claimed it first — skip.
        return;
      }
      
      // We won the claim. Pull from sensor BLE history for the requested range,
      // upload the readings, then mark the request fulfilled.
      try {
        final readings = await pullSensorHistoryFromBle(
          sensorId, since: rangeStart, until: rangeEnd);
        await uploadReadings(readings);  // your existing UPSERT path
        await supabase
          .from('sensor_resync_requests')
          .update({
            'fulfilled_at': DateTime.now().toUtc().toIso8601String(),
            'fulfilled_count': readings.length,
          })
          .eq('id', requestId);
      } catch (e) {
        await supabase
          .from('sensor_resync_requests')
          .update({
            'fulfilled_at': DateTime.now().toUtc().toIso8601String(),
            'fulfilled_count': 0,
            'fulfilled_error': e.toString(),
          })
          .eq('id', requestId);
      }
    },
  )
  .subscribe();
```

## On startup / foreground — drain backlog

In addition to subscribing for new requests, the app should also query
existing open requests on startup (in case the app was offline when
they were inserted):

```dart
final openRequests = await supabase
  .from('sensor_resync_requests')
  .select()
  .eq('user_id', myUserId)
  .filter('claimed_at', 'is', null)
  .filter('cancelled_at', 'is', null)
  .filter('fulfilled_at', 'is', null)
  .gt('expires_at', DateTime.now().toUtc().toIso8601String());

for (final row in openRequests) {
  // Same fulfillment logic as the Realtime callback above.
}
```

## Race semantics with the Primus

If both Primus and App are online for a sensor, both will see the new
request. The atomic UPDATE on `claimed_at` resolves who wins — first
to set `claimed_at` keeps it, the other gets 0 rows back from the
update and skips.

In practice the Primus claims via the heartbeat cycle (every 60s);
the app claims via Realtime (within seconds of insert). The app
typically wins for users with both, which is fine — Primus then sees
the row is fulfilled (via cloud's link-and-mark) and skips its own
attempt for that gap.

The dedup unique index on `(sensor_id, recorded_at)` catches any
reading-level overlap if both readers happen to upload simultaneously
— second insert silently drops as a duplicate.

## Manual user-triggered resync (from the app)

If the user taps a "Sync now" button in the app, app inserts a row
directly:

```dart
await supabase.from('sensor_resync_requests').insert({
  'sensor_id': sensorId,
  'user_id': myUserId,
  'range_start': twentyFourHoursAgo.toIso8601String(),
  'range_end': DateTime.now().toUtc().toIso8601String(),
  'reason': 'app_user_pulled',
});
```

Then the same Realtime callback fires (it'll fire even for inserts the
app itself made, via the subscription) — app claims and fulfills.

If the user has a Primus, the Primus may also pick it up on its next
heartbeat — same race semantics; whichever finishes first wins.

## RLS — what the app can do

- **SELECT** — own rows only (`user_id = auth.uid()`)
- **INSERT** — own rows only (with `user_id = auth.uid()`)
- **UPDATE** — own rows only (claim, mark fulfilled, mark cancelled)
- **DELETE** — not allowed (rows expire automatically; admin can purge)

Admins (`is_admin = true` on profiles) can do anything for support work.

## What the cloud does on each heartbeat (so you understand the
flow end-to-end)

When the Primus heartbeats, the cloud:

1. Records any `command_results` from the previous round, and if the
   command was a resync linked to a `sensor_resync_requests` row,
   marks that row `fulfilled_at` + `fulfilled_count`.
2. Auto-detects sensors whose `last_seen` is > 5 min stale.
3. For each gappy sensor, INSERTs a new `sensor_resync_requests` row
   (reason = `'auto_gap_detected'`).
4. Also INSERTs a corresponding `primus_commands` row for the
   heartbeating Primus, with `params.resync_request_ids` linking back
   to the new rows.
5. Returns the queued `primus_commands` to the Primus in the heartbeat
   response.

The Primus runs its existing resync flow. When it reports back, both
`primus_commands.completed_at` and `sensor_resync_requests.fulfilled_at`
get marked.

For app-only users (no Primus), step 4 still happens but no Primus
claims it — only the app does, via Realtime subscription. Same end
result.

## Open questions / future work (not blocking the app)

- **Sensor commands** (reset_defaults, set_intervals, factory_reset,
  sync_time) are NOT yet using this table. They're still in
  `primus_commands` only. Migration to a unified `sensor_commands`
  pattern is a separate piece of work — can do once basic resync flow
  is verified working in both directions.
- **Support access** flow (the popup pattern) is also still TBD —
  separate doc once schemas land.

---

## What the app session needs to do

1. **Verify migrations are applied.** Andrew runs them in Supabase SQL
   editor. Confirm `sensor_resync_requests` table exists and is in the
   `supabase_realtime` publication.
2. **Subscribe** to the table via Realtime as shown above.
3. **Drain backlog** on app start.
4. **Implement BLE-history pull** for a given sensor + range (probably
   already exists from the existing app architecture).
5. **Wire claim + fulfill** to the existing upload pipeline.

When that's wired, app-only customers will get the same gap-fill
guarantee as Primus customers — cloud detects gap → app pulls from
sensor next time in BLE range → uploads → cloud marks fulfilled.

— Claude (Cloud session)
