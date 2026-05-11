# Primus addendum — report the customer's timezone on heartbeat

> Paste into the Primus firmware Claude Code session. Small, optional, one-line change to the heartbeat payload — but important for international customers.

## What changed on the cloud

Each user account now stores an IANA timezone (e.g. `"Australia/Perth"`, `"Pacific/Auckland"`, `"Europe/London"`). The web portal and the Origin Monitor app both auto-populate it from the browser / phone, but **Primus-only customers** (who set up via the basestation before visiting the web or installing the app) have no browser available to auto-detect from.

So: Primus should tell the cloud its timezone on each heartbeat. The cloud will adopt it for the owner's profile if they haven't set one yet, and leave it alone if they have.

## Change to heartbeat payload

**One new optional field**: `timezone`.

```
POST /primus/heartbeat
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "firmware_version": "1.0.3",
  "wifi_ssid": "HatchingRoom",
  "timezone": "Australia/Perth"
}
```

### Rules for `timezone`

- **IANA timezone name** — `"Australia/Perth"`, `"Pacific/Auckland"`, `"Europe/London"`, etc. Not abbreviations like `"AWST"`. Not `"UTC+8"`. The IANA database name.
- **Optional** — if Primus doesn't know, omit the field. The cloud won't complain.
- **Sent every heartbeat is fine** — the cloud only applies it if the user's profile is still the default. Sending it repeatedly is free.
- **Max 60 characters**, trimmed. Empty strings are treated as absent.

### Where Primus gets this value

Ideally from the ESP-IDF NTP / time configuration. When the customer first sets up the Primus, they pick their timezone (or it's detected from their IP / WiFi BSSID / GPS if you have any of that). Store it in NVS under `origin.timezone` and include it with every heartbeat.

If you don't have a TZ picker UI yet, the minimum viable implementation is:

1. On first boot, default `origin.timezone = "UTC"` in NVS.
2. Add a small "Timezone" screen in the Primus LVGL settings with a scroll list of common IANA names (the ~30 used in AU, NZ, UK, US, EU covers most customers). Save to NVS.
3. Send the NVS value in every heartbeat. If the user hasn't picked one, don't send the field (or send `"UTC"` — cloud will treat it as unset).

For an even lighter first pass: hard-code `"Australia/Perth"` or whatever suits your first customers, ship it, and add the picker in a later firmware revision.

## Response

Unchanged — still `{"ok":true}`.

## What the cloud does with it

Looks up the Primus's owner (via the Bearer token → `primus_devices.user_id`). If that user's `profiles.timezone` is still the `"UTC"` default (meaning they never signed up via web/app), the cloud sets it to the Primus's reported TZ. If the profile already has a real TZ (user set it themselves, or a prior heartbeat set it), the cloud leaves it untouched — Primus won't override a manual choice.

## Verification

After adding the field to your heartbeat:

1. Make sure you have a test user whose profile has `timezone = 'UTC'` (new signup, never opened the web portal).
2. Heartbeat once with `"timezone": "Australia/Perth"`.
3. In Supabase SQL editor, `select id, timezone from public.profiles;` — that user should now read `Australia/Perth`.
4. Change the profile manually to `Australia/Sydney` and heartbeat again. It should stay `Australia/Sydney` (Primus doesn't override a set value).

---

No other Primus changes required. No new endpoints, no payload restructuring, no schema change on your side.
