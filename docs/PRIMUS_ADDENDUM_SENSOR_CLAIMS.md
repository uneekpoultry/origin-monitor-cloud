# Primus addendum — sensor claim flow (no firmware changes required)

> Clarifying answers for the Primus firmware session. Supersedes the relevant section of [PRIMUS_INTEGRATION.md](./PRIMUS_INTEGRATION.md) where they conflict.

## TL;DR

**Primus needs no changes.** Keep posting readings exactly as before. The cloud now auto-creates "pending" sensor rows when it sees a new serial_number, and the customer claims them from the web portal. The firmware is unaware of this.

---

## Direct answers to the four questions

### 1. Does `/primus/readings` now auto-create pending rows for unknown serials?

**Yes.** This replaces the previous "silently skip" behaviour described in the original brief. Concretely:

- Primus POSTs a reading with `serial_number = "AC:23:3F:EE:11:22"` (unknown to the cloud).
- The API looks it up in `public.sensors` — not found.
- The API **inserts a new row** with:
  - `user_id` = the user who owns this Primus (derived from the Bearer token)
  - `serial_number` = the posted serial
  - `model` = the `model` field from the reading if provided, else `"pro"`
  - `name` = `null`
  - `claimed_at` = `null` (= pending)
  - `discovered_by_primus` = this Primus's device id
- The API then writes the reading normally.
- The customer sees the pending sensor in their dashboard, names it, and clicks "Claim." That flips `claimed_at` from null to the current timestamp.

The only case readings still get skipped is when the serial belongs to **a different user's** sensor (rare — neighbour in BLE range). Primus still sees that in the response under `skipped`.

### 2. Is there a new `POST /primus/sensors/discover` endpoint?

**No.** Deliberately — an extra endpoint would mean Primus tracks which MACs it's "announced" vs. which it hasn't, and retry on failure, etc. Doing it inline with readings means:

- One code path in firmware
- No state-tracking in flash
- Works even if Primus reboots mid-stream
- No lag — sensor appears in the portal as soon as the first reading lands

### 3. Should Primus announce all sensor slots once per boot?

**No.** There's no separate announcement. Just post readings. A sensor becomes visible to the customer the moment its first reading arrives — usually within 60 seconds of being in BLE range.

### 4. Any new heartbeat fields?

**No.** `/primus/heartbeat` is unchanged:

```json
{ "firmware_version": "1.0.3", "wifi_ssid": "HatchingRoom" }
```

---

## Updated `/primus/readings` spec

Two optional fields were added per reading: `model` and `advertised_name`.

```
POST /primus/readings
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "readings": [
    {
      "serial_number": "AC:23:3F:EE:11:22",
      "model": "pro",                        // OPTIONAL: "pro" or "lite"
      "advertised_name": "Incubator 1",      // OPTIONAL: BLE Complete/Shortened Local Name
      "temperature": 37.62,
      "humidity": 55.4,
      "battery_mv": 2912,
      "recorded_at": "2026-04-21T01:23:45Z"
    }
  ]
}
```

### `model` field semantics

- **Omit it if Primus can't tell.** Default is `"pro"`, and the customer can change it at claim time.
- **Pass `"pro"` or `"lite"`** if the BLE advertisement tells you the model. For KBeacon advertisements: name prefix `K23_*` = `pro`, `S5_*` = `lite`. Set once at discovery; you don't need to send it on every subsequent reading for the same sensor (but it's harmless if you do).
- Invalid values (anything other than `"pro"` / `"lite"`) → 400 with a validation error.

### `advertised_name` field semantics

The **BLE Complete Local Name** (or Shortened Local Name if Complete isn't present) that the sensor broadcasts. Read this from the advertisement / scan response — don't invent anything. Examples:

- Factory-fresh sensor → advertises `"Origin Pro"` or `"Origin Lite"` → send as-is
- User renamed via the Origin Monitor app / Primus UI → e.g. `"Incubator 1"` → send the new name
- No local name broadcast at all → omit the field

What the cloud does with it:

1. On **first discovery** of an unknown serial, the cloud stores `advertised_name` as the sensor's `name` — so the pending-sensor card on the dashboard shows "Incubator 1" instead of just a MAC address. The claim modal pre-fills the name input with it, so if the user already named the sensor properly in the app, claiming is one click.
2. On **subsequent readings for a still-pending sensor**, if `advertised_name` differs from the stored name, the cloud updates it. (So if the user renames the sensor in the app before claiming on the web, the dashboard reflects that.)
3. Once the sensor is **claimed**, the web-side `name` is the source of truth — `advertised_name` on future readings is ignored for that sensor.

Max length 60 chars. Empty / whitespace-only strings are treated as absent. Sending it is harmless when not needed.

### Response

```json
{
  "ok": true,
  "accepted": 4,            // readings written to sensor_readings
  "pending_created": 1,     // how many new pending sensors were auto-created this call
  "skipped": []             // serials owned by a different user (not created, not written)
}
```

`pending_created` is a hint for UI / logging — no action required from Primus.

---

## cURL example — first time a new sensor is seen

```bash
curl -i -X POST https://api.originmonitor.com/primus/readings \
  -H "Authorization: Bearer sb_primus_token_XXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{
    "readings": [
      { "serial_number": "AC:23:3F:EE:11:22", "model": "pro", "temperature": 37.5, "humidity": 54.2, "battery_mv": 2920 }
    ]
  }'

HTTP/1.1 200 OK
{"ok":true,"accepted":1,"pending_created":1,"skipped":[]}
```

Next request for the same sensor:

```bash
# ...same curl as above, different reading values...
HTTP/1.1 200 OK
{"ok":true,"accepted":1,"pending_created":0,"skipped":[]}
```

---

## What this means for firmware work

- **Core firmware change required: none.** If the current code posts valid readings, the claim flow works end-to-end.
- **Recommended small enhancements** (both optional, trivial to add):
  - Detect Pro vs. Lite from the BLE advertisement. If the advertised name starts with `"Origin Pro"` → `pro`; starts with `"Origin Lite"` → `lite`. (Factory-fresh sensors broadcast these strings; once the user renames them via the app/Primus, that heuristic breaks — so also fall back to the manufacturer-specific data / service UUIDs your existing BLE parser uses.)
  - Pass the BLE Complete Local Name through as `advertised_name`. Dramatically improves the customer's first-run experience — claim is one click instead of "type a name from scratch."
- **Do NOT build:** a discovery cache, a per-boot announcement, a sensor-slot registry, or any new endpoint. All of that is handled server-side.

---

## Name sync — new endpoints (for Primus to learn and push name changes)

Customer names get set by any of: the web portal, the Origin Monitor app, or the Primus UI itself. To keep all three in sync, Primus uses two new endpoints alongside the existing ones.

### `GET /primus/sensors` — pull current names

Poll this every **60 seconds** (piggyback with your heartbeat if you like). Returns every sensor that belongs to this Primus's user — both claimed and pending.

```
GET /primus/sensors
Authorization: Bearer <api_key>

→ 200
{
  "sensors": [
    {
      "id": "b1f9…",
      "serial_number": "AC:23:3F:EE:11:22",
      "name": "Main incubator",        // may be null for pending sensors
      "model": "pro",
      "claimed_at": "2026-04-21T01:23:45Z",  // null = pending
      "last_seen": "2026-04-21T05:01:02Z",
      "firmware_version": "1.0.3"
    }
  ]
}
```

Cache the list locally. On each poll, diff against the cache:

- **Name changed** → update the LVGL label
- **New id** → add to display (up to 4-sensor limit)
- **Missing id** → remove from display (sensor was unregistered)

### `PATCH /primus/sensors/:id` — push a name from Primus UI

When the customer renames a sensor using the Primus on-screen keyboard:

```
PATCH /primus/sensors/b1f9…
Authorization: Bearer <api_key>
Content-Type: application/json

{ "name": "Bantam batch" }

→ 200 {"ok":true,"id":"b1f9…","name":"Bantam batch"}
→ 400 {"error":"invalid_body"}      // empty / >60 chars
→ 404 {"error":"not_found_or_pending"}  // sensor not claimed yet, or doesn't belong to this user
```

Use the sensor's `id` (not its serial_number) — you get this from the `GET /primus/sensors` response. On success, the app and web portal will see the update within seconds (app subscribes to Supabase Realtime; web re-fetches on navigation).

### Typical Primus loop pseudo-code

```c
every 60s:
  primus_heartbeat();
  primus_send_readings_batch();
  sensors = GET /primus/sensors;
  for each s in sensors:
    if local_cache[s.id].name != s.name:
      lvgl_update_label(s.id, s.name);
      local_cache[s.id].name = s.name;
```

---

## Sanity check

To verify the flow from Primus's side without changing anything:

1. Put a sensor in BLE range that the cloud has never seen before.
2. Let Primus post a reading for it.
3. Check `https://originmonitor.com/dashboard` as the user who owns that Primus — a "New sensors detected by your Primus" card should appear within ~30 seconds.
4. Click **Claim**, give it a name → the card moves to the main sensors list.

If steps 3 and 4 work, firmware is correct. If step 3 never shows a card, check the API response — it should say `pending_created: 1` on the first reading for an unknown MAC.
