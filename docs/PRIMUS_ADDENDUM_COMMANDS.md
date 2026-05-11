# Primus addendum — cloud-to-Primus command channel

> **Read `docs/ARCHITECTURE_SYNC.md` first** for the universal sync
> pattern. Paste this into the Primus Claude Code session alongside
> the resync + events addendums. This one adds remote admin control —
> support can click a button in the web portal and have the Primus
> execute a command on its next heartbeat.

## Why

Cases we couldn't solve before:

- Customer calls: "my dashboard has a gap from last night" — support
  needs to trigger a resync without the customer touching the device.
- Support suspects a hung background task — would like to remote-restart
  a subsystem.
- New firmware feature needs validation in the field — want to flip a
  flag on one customer's device without an OTA.

**Auto-resync is also live.** Every `/primus/heartbeat` now checks
whether any of this device's claimed sensors hasn't reported in the last
5 minutes. If a gap is detected, the cloud auto-queues a `resync`
command — unless one is already pending or in-progress for this device.
This means on a fresh cloud reconnect, the Primus will see an auto-
queued resync command in the very next heartbeat response, without any
admin or user action.

The `params` object on auto-queued commands carries:
```json
{ "since": null, "auto": true, "reason": "sensor_gap_detected",
  "gappy_sensor_ids": ["..."] }
```

`since: null` means "use the device's default window" — the Primus
decides (e.g. `last_successful_post - 10min`, floored at buffer depth).
Admin-queued commands may set `since` explicitly.

The command channel gives admin a way to push work to a Primus without
any new infrastructure (no MQTT, no push notifications, no persistent
connections). Everything rides on the existing heartbeat.

## Protocol — two new fields on /primus/heartbeat

**Outgoing (response body) — commands the Primus should execute:**

```json
{
  "ok": true,
  "events_acked": [...],
  "commands": [
    {
      "id": "c1a0f3d2-...",
      "type": "resync",
      "params": { "since": "2026-04-22T02:00:00Z" }
    }
  ]
}
```

**Incoming (request body) — results for previously-delivered commands:**

```json
{
  "firmware_version": "0.8.2",
  "wifi_ssid": "UneekHQ",
  "events": [...],
  "command_results": [
    {
      "id": "c1a0f3d2-...",
      "status": "ok",
      "result": {
        "sensors_queried": 2,
        "readings_uploaded": 84,
        "inserted": 47,
        "duplicates": 37,
        "window_start": "2026-04-22T02:00:00Z",
        "window_end": "2026-04-22T09:57:00Z"
      }
    }
  ]
}
```

- `command_results[].result` is free-form JSON, whatever makes sense for
  that command type. Cloud just stores it verbatim.
- `status: "error"` — put a short reason string in `result.error` (e.g.
  `{ "error": "sensor_unreachable", "serial": "OP-240305-0042" }`).

## Firmware behaviour

1. **On heartbeat response**, iterate `commands[]`.
2. For each command, **execute based on `type`** (switch statement).
3. **After execution, record** `{ id, status, result }` into a local
   queue (call it `pending_results`).
4. **On next heartbeat request**, include up to 20 from `pending_results`
   in `command_results[]`.
5. **When the next response returns 200**, purge the reported results
   from `pending_results` (they're stored in the cloud now).
6. **Don't re-execute** a command you've seen before — track executed
   `id`s in a small ring buffer (last 50 is fine). The cloud won't re-
   deliver, but a bug in the firmware ack path shouldn't cause repeat
   execution.

Each command should complete within reasonable time. For anything
longer-running (future: `ota_update`), the command can return `status:
"ok"` immediately with `result: { started: true }` and a separate info
event should fire when it finishes.

## Supported command types (v1)

### `resync`

Pull readings from each linked sensor's on-board buffer and upload to
`/primus/readings`.

**Params:**

| param   | type                    | notes                                                          |
| ------- | ----------------------- | -------------------------------------------------------------- |
| `since` | ISO 8601 string or null | Start of window. If null, use `last_successful_post - 10min`, floored at sensor buffer depth. |

**Expected result:**

```json
{
  "sensors_queried": 2,
  "readings_uploaded": 84,
  "inserted": 47,
  "duplicates": 37,
  "window_start": "2026-04-22T02:00:00Z",
  "window_end": "2026-04-22T09:57:00Z"
}
```

**Behaviour:** identical to the automatic gap-fill flow in
`PRIMUS_ADDENDUM_GAP_FILL_RESYNC.md` — same silent, log-only behaviour
(no LCD toast, one info event summarising the outcome).

## Future command types (planned — don't implement yet)

Listed so you can design the switch statement to grow cleanly:

- `restart` — soft reboot the Primus
- `clear_cache` — flush on-device paired-sensor cache, rediscover
- `ota_update` — params `{ url, sha256 }`, pull + flash + reboot
- `set_flag` — params `{ key, value }`, flip a feature flag for A/B

When a new type is added to the enum, the cloud migration will update
`primus_command_type`. Older firmware versions receiving a command they
don't understand should report `status: "error"` with
`result: { error: "unsupported_command_type", type: "<received>" }` —
don't drop it silently, or the admin UI will show it "running" forever.

## Security

- Commands are scoped by `primus_id` — the cloud only hands out commands
  for the device whose API key you presented. A stolen key can only
  target its own device.
- `command_results` updates are also scoped — Primus can only mark its
  own commands complete (even if it guessed another device's UUID).
- No command currently requires user consent on the LCD. If/when we add
  `ota_update` or anything destructive, we should add a device-side
  confirmation prompt.

## Admin UI — what support does

- Main admin page `/admin/primus` — every device row has a **Resync**
  link next to Events / Rotate / Revoke. Prompts for an optional ISO
  start time.
- Per-device events page — a **Commands** table at the top showing the
  last 20 commands with statuses (pending / running / done) and
  result JSON.
- Once the firmware lands, clicking **Resync** on a device should result
  in a filled-in gap on the hatch dashboard within ~2 minutes.

## Integration checklist for the Primus session

- [ ] Parse `commands[]` out of heartbeat response
- [ ] Dispatcher: switch on `type`; initially only `"resync"` is live
- [ ] Wire `"resync"` to the BLE sensor-buffer pull + `/primus/readings`
      upload you're already building
- [ ] Accumulate `{ id, status, result }` into `pending_results`
- [ ] Include up to 20 from `pending_results` in next heartbeat's
      `command_results`; purge on 200
- [ ] Last-50 executed-id ring buffer to prevent repeat execution
- [ ] Unknown `type` returns `status: "error"` with `result.error =
      "unsupported_command_type"`
