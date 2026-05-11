# Primus addendum — active-hatch dashboard

> Adds a new endpoint so the Primus LCD can show "at a glance" hatch status. No hatch data entry on Primus — view only. Paste this into the Primus Claude Code session.

---

## New endpoint

```
GET /primus/hatches
Authorization: Bearer <api_key>
```

Returns every active hatch belonging to this Primus's owner, with everything needed to draw a dashboard. Poll every **5 minutes** (or on manual refresh).

### Response

```json
{
  "active": [
    {
      "id": "b1f9…",
      "name": "Sussex batch 1",
      "species_label": "Chicken",
      "day": 12,
      "total_days": 21,
      "days_to_lockdown": 6,
      "days_to_hatch": 9,
      "phase": "turning",
      "current": {
        "temperature_c": 37.52,
        "humidity_pct": 54.1,
        "updated_at": "2026-04-21T05:01:02Z"
      },
      "today": {
        "temp_avg": 37.48,
        "temp_min": 37.32,
        "temp_max": 37.61,
        "hum_avg": 53.7,
        "hum_min": 52.0,
        "hum_max": 55.3
      },
      "target": {
        "temp_min": 37.3,
        "temp_max": 37.8,
        "hum_min": 50,
        "hum_max": 55
      },
      "sensors_online": 2,
      "sensors_total": 2,
      "alerts": []
    }
  ]
}
```

If the user has no active hatches, `active` is an empty array — show a polite "No active hatches" state on the Primus.

### Field notes

- `phase` — one of `"turning"`, `"lockdown"`, `"hatch"`, `"overdue"`. Drives the `target.hum_min/max` values (humidity targets change between turning and lockdown phases).
- `current` — latest reading per-sensor, averaged across sensors. `updated_at` is the most recent reading across all linked sensors. If no readings exist yet, all three fields are `null`.
- `today` — min/avg/max across the **last 24 hours** of readings. We call it "today" for human clarity; it's actually a rolling window. Values are `null` if no readings in that window.
- `target` — numeric min/max for the current `phase`. Use for colour-coding (see below).
- `sensors_online` — count of linked sensors that reported in the last 5 minutes.
- `sensors_total` — count of sensors linked to this hatch.
- `alerts` — current violations. Possible values: `"temp_high"`, `"temp_low"`, `"humidity_high"`, `"humidity_low"`.

### Edge cases

- **No linked sensors**: `current` / `today` all `null`, `sensors_total: 0`. Draw the card with "— awaiting sensor —" state.
- **No readings in 24h**: same as above; sensor is offline. Surface it with `sensors_online: 0`.
- **Day 0** (started today): `day: 1`.
- **Overdue**: `days_to_hatch` will be negative (e.g. `-2`). Display as "2d overdue".

---

## Four-card layout on the 4.3" LCD

The design target is big fonts readable from across the hatching room.

| Card | Headline (big) | Supporting context (small) | Tint |
|---|---|---|---|
| **1. Hatch** | `Day 12 / 21` | `name` · `species_label` · phase badge · progress bar (day / total_days) | brand gold |
| **2. Temperature** | `37.52 °C` | `"Target {target.temp_min}–{target.temp_max}"` · today avg / min / max | see colour rule |
| **3. Humidity** | `54 %` | `"Target {target.hum_min}–{target.hum_max}"` · today avg / min / max | see colour rule |
| **4. Countdown** | `6d to lockdown` (turning) / `9d to hatch` (lockdown or later) | `sensors_online/total` · "Last reading {seconds} ago" · ←/→ arrows if multiple hatches | brand gold |

### Colour rule for cards 2 and 3

Compare `current` to `target`:

```
in_range = current >= target.min && current <= target.max
edge_min = target.min - 0.3 (for temp) / target.min - 3 (for humidity)
edge_max = target.max + 0.3 (for temp) / target.max + 3 (for humidity)

if in_range               → GREEN
elif current in edge band → AMBER
else                      → RED
```

A RED card from across the room means "go check the incubator now".

### Multiple active hatches

If `active.length > 1`, let the user cycle with on-screen ←/→ arrows. Or auto-rotate every 20s. Don't try to show multiple hatches at once — the screen is too small.

---

## What Primus must NOT do on this screen

- Editing hatch name, species, eggs, dates, results — those are app/web only.
- Showing raw readings tables, notes, completed results breakdowns — those are app/web only.
- Logging turnings, candling, observations — those go on the app (coming soon).

Keep the Primus read-only for hatch data. Its role is the always-visible status display.

---

## Companion: "Email current report" button

When the user taps an "Email report" button on the Primus, call (endpoint coming — not live yet):

```
POST /primus/email-report
Authorization: Bearer <api_key>
Content-Type: application/json

{ "hatch_id": "<id of the hatch currently shown>" }

→ 200 {"ok":true,"emailed_to":"owner@example.com"}
```

Cloud generates the same XLSX the web portal offers and emails it to the account holder. Use this so a Primus user can grab the current report without needing to be at the computer.

Status: **proposed, not yet implemented**. Build the UI button now but stub the call with a "coming soon" toast until the endpoint is live.

---

## Sanity check

Once the GET call is wired up:

1. Create a hatch on https://originmonitor.com with a species and link a sensor that's reporting.
2. Hit `GET /primus/hatches` — you should get one item in `active` with `day: 1`, `phase: "turning"`, and `current` populated.
3. Wait a minute, hit again — `updated_at` should be recent; `today` populated.

If the hatch goes into lockdown, `target.hum_min/max` shifts automatically to the lockdown values.
