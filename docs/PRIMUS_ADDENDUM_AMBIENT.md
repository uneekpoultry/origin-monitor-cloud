# Primus addendum — ambient (room) sensor display

> **Read `docs/ARCHITECTURE_SYNC.md` first.** Paste into the Primus Claude
> Code session.

## Product context

Every incubator lives in a room. That room has its own temperature and
humidity, and when the room is too cold, too hot, too dry, or too humid,
the incubator struggles — which is one of the single biggest causes of
failed hatches. Customers almost never realise this, because they don't
measure it.

Origin Monitor now supports designating any sensor as an **ambient / room
sensor** on the cloud side. It's linked to a specific hatch via
`hatch_logs.ambient_sensor_id`. The web portal and XLSX report render
ambient readings in **amber** so customers visually distinguish "room"
from "incubator" at a glance.

The Primus LCD needs the same treatment — ambient shown as context,
visually distinct, never mixed with incubator readings.

## Cloud endpoint change (already live)

`GET /primus/hatches` now returns an `ambient` object per active hatch.
The shape:

```json
{
  "active": [
    {
      "id": "...",
      "name": "Test Hatch",
      "species_label": "Chicken",
      "day": 3,
      "total_days": 21,
      "current": {
        "temperature_c": 37.52,
        "humidity_pct": 55.2,
        "updated_at": "2026-04-23T07:32:11+00:00"
      },
      "today": { ... },
      "target": { "temp_min": 37.25, "temp_max": 37.75, "hum_min": 50, "hum_max": 55 },
      "sensors_online": 3,
      "sensors_total": 3,
      "alerts": [],
      "ambient": {
        "name": "Shed — Room Temp",
        "temperature_c": 22.4,
        "humidity_pct": 58.0,
        "updated_at": "2026-04-23T07:32:18+00:00"
      }
    }
  ]
}
```

`ambient` is `null` when the hatch has no ambient sensor linked. Render
nothing in that case (or a subtle "No room sensor linked" note — your
call on UX).

## What to render on the LCD

### Hatches screen — active hatch card

Right now the card probably shows:
```
Test Hatch · Chicken · Day 3 of 21
Temp:   37.52°C  ✓
Humid:  55.2%    ✓
```

Add ambient as a **distinct secondary row** below, in **amber / gold**
(whatever colour the customer will read as "this is different — this is
the room"):

```
Test Hatch · Chicken · Day 3 of 21
Incubator
  Temp:   37.52°C  ✓
  Humid:  55.2%    ✓
Room  (Shed — Room Temp)                  ← amber / gold text
  Temp:   22.4°C
  Humid:  58.0%
```

Key rules:
- **Never average ambient with incubator.** The incubator target is
  37.5°C; the room might be 22°C. Mixing them is meaningless.
- **Colour ambient amber/gold** (not green, not the incubator accent).
  That colour is the instant visual cue "this is room context, not your
  incubator's reading."
- **Label it "Room"** (short, clear). Suffix the sensor's user-given
  name if screen space allows — users often have multiple hatches in
  different rooms, so "Shed" vs "Office" matters.
- **Show the sensor name from `ambient.name`** — user-controlled text,
  up to 60 chars.

### Card variants

If `ambient` is `null` (hatch has no ambient sensor linked), either:
- Render nothing extra (cleanest for existing hatches)
- OR render a small faded "+ Add room sensor" hint that links to the
  Settings flow if the user has a spare sensor

### Dashboard / summary views

If you have an overall "at-a-glance" view, a small amber dot next to each
hatch showing the room temp is a genuinely differentiating bit of polish.
Something like `37.5°C · 55% (Room 22°C)`.

## Why this matters for the product

Commercial context Andrew shared: **this is one of Origin Monitor's key
market differentiators.** No consumer incubator monitoring product
surfaces ambient conditions. Customers call support about "my hatch
isn't working" and the ambient reading is the answer 80% of the time
— cold shed in winter, humid basement in summer. Making this visible
turns support calls into "oh, that makes sense" moments.

New Primus + sensor bundles will ship with at least one Origin Lite
designated as the room sensor, so for most customers this will be
populated by default once they set it up.

## What NOT to change

- **Don't mix ambient into the alarm thresholds.** Alarms on the
  incubator sensor only. Room-temp alarms are a separate future feature.
- **Don't rely on `ambient` being present.** Older/existing hatches
  won't have one. Render gracefully without it.
- **Don't average across multiple ambient sensors.** The cloud only
  links ONE per hatch via `ambient_sensor_id`. If the user has two
  ambient sensors, they pick one for this hatch.

## Short version for the code

1. Parse `ambient` object out of each `/primus/hatches` active-hatch item.
2. If non-null, render a second data block on the hatch card with the
   label **"Room"** in **amber / gold**.
3. Show `ambient.temperature_c` and `ambient.humidity_pct` formatted
   like the incubator row but with the amber colour and "°C" / "%" units.
4. Show the sensor's `ambient.name` as a small subtitle so users know
   which room's data they're looking at.
5. If `ambient.updated_at` is stale (>10 min), dim the row or show a
   small "stale" note — user should trust the reading.

## References

- Migration: `supabase/migrations/013_ambient_sensors.sql`
- Cloud endpoint: `api/src/routes/primus.ts` `buildHatchDashboard()`
- Web rendering (for UX inspiration):
  - Hatch detail page ambient banner: amber border/bg, "Room context" label
  - XLSX Daily Log: "Room °C" / "Room %RH" columns with amber fill
- Architecture: `docs/ARCHITECTURE_SYNC.md`
