# Origin Monitor — Hatch report & hatch management, current state

> Snapshot of what's already built for hatch logging, editing, and the downloaded spreadsheet — so a separate planning conversation can produce a brief that *extends* this rather than re-specifies it. Accurate as of 2026-04-21.

---

## 1. Data model — what the cloud stores about a hatch

### `hatch_logs` (Postgres, Supabase)

```
id                   uuid
user_id              uuid                         -- owner
name                 text                         -- user-assigned, required
species              text                         -- enum value (see below)
egg_count            integer                      -- required
start_date           date                         -- required
expected_hatch_date  date                         -- auto-calc from species + start, user can override
actual_hatch_date    date                         -- set when hatch is recorded
hatched_count        integer                      -- required at completion
fertile_count        integer                      -- optional (from candling)
died_in_shell        integer                      -- optional
pipped_not_hatched   integer                      -- optional
early_deaths         integer                      -- optional
notes                text                         -- free-form
status               text                         -- 'active' | 'completed' | 'failed'
is_pro               boolean                      -- unused today; reserved for paywall
created_at           timestamptz
```

### Species enum values (matches the `SPECIES_PRESETS` list in code)

Each has a canonical label, standard incubation `days`, and `lockdown` day:

| Value        | Label                 | Days | Lockdown |
|--------------|-----------------------|-----:|---------:|
| `chicken`    | Chicken               | 21   | 18       |
| `duck`       | Duck (Pekin)          | 28   | 25       |
| `muscovy`    | Duck (Muscovy)        | 35   | 32       |
| `goose`      | Goose                 | 30   | 27       |
| `turkey`     | Turkey                | 28   | 25       |
| `quail_jap`  | Quail (Japanese)      | 17   | 14       |
| `quail_bw`   | Quail (Bobwhite)      | 23   | 20       |
| `pheasant`   | Pheasant              | 24   | 21       |
| `guinea`     | Guinea fowl           | 28   | 25       |
| `peafowl`    | Peafowl               | 28   | 25       |
| `other`      | Other / custom        | 21   | 18       |

### `hatch_sensors` — junction (one hatch → many sensors)

```
hatch_id    uuid
sensor_id   uuid
added_at    timestamptz
primary key (hatch_id, sensor_id)
```

### `sensors` — referenced (read-only in the hatch context)

Relevant fields: `id`, `user_id`, `serial_number` (MAC), `model` (`'pro'` | `'lite'`), `name`, `last_seen`, `claimed_at`.

### `sensor_readings` — readings stream

`sensor_id`, `temperature` (°C), `humidity` (%), `battery_mv`, `recorded_at`.

---

## 2. Web portal — what the user can do today

### Hatch list on the dashboard (`/dashboard`)
- Active hatches shown as cards with phase label (Turning / Lockdown / Hatch day / Overdue) + a gold progress bar + days-to-hatch countdown.
- Recent completed / failed hatches shown as a compact table with species, start date, and result (e.g. "22/24 (92%)").
- **+ New hatch** button opens a modal (name, species, egg count, start date, expected hatch date auto-calc with manual override, optional multi-sensor picker, notes).

### Hatch detail (`/dashboard/hatches/{id}`)
- Header: hatch title + species + egg count + status badge + phase label.
- **Edit details** button — opens a modal to edit name, species, egg count, start date, expected hatch date. Changing species prompts before recalculating lockdown/hatch dates.
- **↓ Download report** button — streams an XLSX (see section 3).
- Progress card (if active): day X of N, gold bar with Set / Lockdown / Hatch date markers.
- Completed panel (if completed): 3 big stats + **inline editable breakdown** for the 5 result fields. Live hatch-rate, fertility-rate, hatch-of-fertile recalculate as you type. Save / Reset buttons.
- Details card: species, egg count, started, lockdown, expected hatch (all display; editing is via the modal).
- Linked sensors section with **Edit sensors** button (checkbox list of all claimed sensors, instant save).
- Recent readings table (last 20 from all linked sensors, interleaved).
- Notes card (editable textarea, save button).
- Sidebar controls: "Record hatch results" (for active hatches — opens modal to capture all 5 fields + mark completed), "Mark as failed", "Reopen" (when completed/failed), "Delete hatch".

### Server actions (in `hatches/actions.ts`)
- `createHatch` — inserts a hatch + links selected sensors
- `updateHatch` — partial update incl. sensor-link replacement
- `recordHatchResults` — sets all 5 result counts, marks completed, sets `actual_hatch_date` on first completion
- `failHatch`, `reopenHatch`, `deleteHatch`

---

## 3. Downloaded XLSX — what's in it today

Filename: `{hatch-name}-{start-date}.xlsx`. Four sheets.

### Sheet 1 — **Summary** (A4 portrait, fit-to-page, horizontally centred)

- Brand header band: "ORIGIN MONITOR" (gold on black) + "Hatch report" subtitle + "Generated {datetime} · {user name}".
- **Hatch details** section:
  - Name · Species · Eggs set · Status
  - Started · Lockdown · Expected hatch · Actual hatch
  - Sensors (comma-joined list with model tag)
- **Incubation environment** section: Minimum / Average / Maximum for Temperature (°C) and Humidity (%) — calculated from the readings across the hatch period.
- **Results** section — pre-filled from the cloud:
  - Eggs set · Fertile · Hatched alive · Died in shell · Pipped but didn't hatch · Early deaths
  - Formulas below: Hatch rate, Fertility rate, Hatch of fertile (recalculate if user edits numbers in Excel)
- **Notes** block — multi-row merged cell, pre-filled with the cloud notes.
- Footer: "Powered by Origin Monitor · uneekpoultry.com.au · originmonitor.com".

### Sheet 2 — **Daily log** (A4 landscape)

- Banner row (hatch name · species · target temp).
- Frozen header row with columns:
  `Day | Date | Temp avg | Temp min | Temp max | Humid avg | Humid min | Humid max | Turnings | Candling notes | Observations`
- One row per day from Day 1 through expected hatch + 3 buffer days.
- **Auto-populated**: day, date, temp/humidity avg/min/max per day (grouped in user's timezone).
- **Manual**: Turnings, Candling notes, Observations columns (blank — user fills in).
- **Lockdown day** row highlighted cream with "LOCKDOWN begins" marker.
- **Hatch day** row highlighted green with "Expected hatch day" marker.
- Conditional formatting: temperatures outside 37.0–37.9 °C displayed in red.
- Header rows repeat on every printed page.

### Sheet 3 — **Raw readings** (A4 portrait, autofilter enabled)

- Frozen header row. Columns: Timestamp · Sensor · Temperature (°C) · Humidity (%) · Battery (e.g. "78% (Good)").
- One row per reading, chronological, every linked sensor.
- Limit: 50,000 rows per report. (A 21-day hatch with 4 sensors at 1 reading/minute ≈ 121k — hits the cap; an aggregated / downsampled variant may be a future need.)

### Sheet 4 — **Reference** (A4 portrait, read-only reference)

- Species incubation table (10 rows): target temp °C, humidity turning phase, humidity lockdown phase, days, lockdown day.
- Common problems table: blood ring, sticky chicks, spraddle leg, unabsorbed yolk, late/early hatches, pipped-but-stuck, etc. with likely causes.
- Disclaimer: "These are typical industry targets. Your incubator, altitude, and breed can shift them."

### Brand tokens used throughout the XLSX

| Token   | ARGB hex   | Use                                    |
|---------|------------|----------------------------------------|
| INK     | FF0A0F0A   | Brand dark background                  |
| GOLD    | FFC49A46   | Primary accent, temperature line       |
| BRONZE  | FF8A6818   | Section headers, column headers        |
| CREAM   | FFE5C880   | Subtitle, soft highlights              |
| WHITE   | FFFFFFFF   | Text on dark, table body               |
| OFFWHITE| FFF7F7F5   | Zebra striping                         |
| GREY    | FF8A928A   | Meta text, footers                     |
| HAIRLINE| FFE5E7E3   | Borders                                |

---

## 4. Known gaps — what is NOT captured in the cloud today

These Daily-log columns are **blank in the spreadsheet for the user to fill in**, because there's no data model for them yet:

- **Turnings** (per day — count and/or time)
- **Candling notes** (day 7, 14, etc. — observations and fertile / clear counts)
- **General observations** (anything noteworthy that day)

When we build these, the **app is the right primary surface** (user is at the incubator with the phone in hand; one-tap "turned now" is the best UX). Web should also support them for desktop users. Primus should NOT be involved in entering them — it's read-only for hatch data by design.

Other hatch data types the cloud does not capture yet:
- Incubator make/model
- Breed / strain / egg source
- Humidity target overrides (user may run dry / higher humidity schemes)
- Individual hatch event timing (first pip, last hatch, hatch window duration)
- Photos attached to the hatch

---

## 5. Three surfaces, one dataset — who does what

Origin Monitor has three customer-facing surfaces. All read the same cloud dataset; each one plays a different role because of its form factor and context.

### 5.1 Roles at a glance

| Surface | Where it lives | Primary use | Form factor |
|---|---|---|---|
| **Web portal** `originmonitor.com` | Laptop / desktop browser | Deep record-keeping, admin tasks, printing reports, managing many hatches | Big screen, keyboard |
| **Origin Monitor app** | Android phone (iOS later) | Daily driver for the breeder — tend the incubator, log turning/candling inline, get push alerts | Phone in the user's hand, near the incubator |
| **Origin Primus** | ESP32-S3 + 4.3" LCD sitting next to the incubator | Always-on status display — "at a glance, is my hatch OK?" | Small touchscreen, no keyboard |

### 5.2 What each surface can do

| Action | Web | App | Primus |
|---|---|---|---|
| Sign up / sign in | ✓ | ✓ | — (device-bonded, not user-bonded) |
| Pair a new sensor over BLE | — | ✓ | — (Primus only passively observes) |
| Register a sensor manually | ✓ | ✓ | — |
| Claim a sensor Primus has discovered | ✓ | ✓ | — |
| Rename a sensor | ✓ | ✓ | ✓ (on-device name edit) |
| See live sensor readings | ✓ (from cloud) | ✓ (BLE directly, cloud fallback) | ✓ (BLE directly) |
| See temp / humidity chart | ✓ (full 24h/7d/30d) | ✓ | ✓ (short-window live graph) |
| Create a new hatch | ✓ | ✓ | — |
| Edit hatch details | ✓ | ✓ | — |
| Record hatch results | ✓ | ✓ | — |
| Log turning / candling / observations | ✓ (cloud-side, future) | ✓ **(primary surface)** | — |
| Delete / reopen a hatch | ✓ | ✓ | — |
| See active hatch status at a glance | ✓ | ✓ | ✓ (dashboard tile) |
| Download XLSX report | ✓ | ✓ (share sheet / downloads) | ✗ no filesystem |
| **Trigger email of latest report** | ✓ | ✓ | ✓ **(proposed — see 5.5)** |
| Cloud sync realtime subscription | — (re-fetch on nav) | ✓ (realtime channel) | — (60s poll) |

**The design principle:** the app is the richest surface for the user because it's the one they're holding when they walk up to the incubator. The web is the richest surface for a laptop — bigger charts, easier multi-hatch comparison, easier printing. The Primus is deliberately read-only for hatch management — its job is *"I'm here, glance at me, know everything's fine"*, not *"enter data here"*.

### 5.3 Communication — how the three surfaces talk

All three surfaces share a single source of truth: the Supabase database. They reach it different ways:

```
┌───────────────────┐      direct Supabase SDK       ┌────────────┐
│ Web portal        │ ─────  (user JWT cookie)  ───▶ │            │
└───────────────────┘                                │            │
                                                     │  Supabase  │
┌───────────────────┐      direct Supabase SDK       │  Postgres  │
│ Origin Monitor    │ ─────  (user JWT)         ───▶ │  + Auth    │
│ app               │                                │  + Realtime│
└─────────┬─────────┘                                │            │
          │ BLE scan / connect                       │            │
          ▼                                          │            │
   ┌────────────┐                                    │            │
   │ Sensors    │◀── BLE advertisement ────┐         │            │
   └────────────┘                          │         │            │
                                           │         │            │
┌───────────────────┐                      │         │            │
│ Origin Primus     │ ─── BLE central ─────┘         │            │
│ (ESP32-S3)        │                                │            │
│                   │──── HTTPS ──▶ Origin API ─────▶│            │
│                   │   (device API key)             │            │
└───────────────────┘                                └────────────┘
```

- **Web portal ↔ Supabase** — direct, authenticated with the user's JWT cookie. Reads respect RLS; writes likewise. For admin pages, a server-side service-role client is used to see across users.
- **App ↔ Supabase** — direct, via `supabase_flutter`. Same RLS as web. Plus: the app talks BLE directly to sensors, so it shows live readings even with no internet.
- **App ↔ Sensors (BLE)** — the app's BLE stack reads advertisement packets for live data (no sensor connection required) and can open an active connection to write config (rename, turning schedule, etc.).
- **Primus ↔ Origin API (`api.originmonitor.com`)** — the Primus is device-authenticated with a per-device Bearer token, not a user JWT. A small Node.js/Express service at `api.originmonitor.com` validates the token and performs writes to Supabase using the service role. The Primus cannot speak directly to Supabase. Endpoints available today:
  - `POST /primus/heartbeat` — every 60s, updates `primus_devices.last_seen` and (optionally) the owner's `profiles.timezone`.
  - `POST /primus/readings` — every 60s, batches sensor readings; auto-creates pending sensor rows for unknown MACs so the customer can claim them in the app/web.
  - `GET /primus/sensors` — list of the Primus's owner's sensors, used by the Primus to learn name/model updates made elsewhere.
  - `PATCH /primus/sensors/:id` — rename a sensor from the Primus UI.
- **Primus ↔ Sensors (BLE)** — passive scan every ~1.3s (30 ms window) to catch advertisements. Primus doesn't connect to sensors for config; the app does that.
- **Realtime sync** — `public.sensors` is published on `supabase_realtime`. The app subscribes to changes scoped to `auth.uid()` and updates its UI instantly when a name change happens on another surface. The web re-fetches on navigation; the Primus polls `GET /primus/sensors` every minute.

### 5.4 What each surface writes to the cloud

| Dataset | Web writes | App writes | Primus writes |
|---|---|---|---|
| `profiles.timezone` | on signup + first login (browser IANA) | on every login (device IANA) | via heartbeat (if still default) |
| `sensors` insert | manual registration | BLE pairing OR manual | — (auto-created as *pending* by the API when readings arrive) |
| `sensors.name / model` | ✓ | ✓ | ✓ (`PATCH /primus/sensors/:id`) |
| `sensors.claimed_at` | ✓ (claim / unclaim) | ✓ | — |
| `sensor_readings` | — | ✓ (if user has no Primus) | ✓ (primary writer) |
| `hatch_logs` any field | ✓ | ✓ | — |
| `hatch_sensors` link | ✓ | ✓ | — |

**Rule of thumb:** Primus only writes sensor-adjacent data. Every hatch record field is a human decision, so only surfaces with a human at a keyboard write it.

### 5.5 Proposed: Primus-triggered email report

Andrew's idea, agreed to add:

> Primus can't open a PDF or save an XLSX, but it *can* press a cloud button. Put an **"Email current report"** action on the Primus UI. The Primus calls the cloud, the cloud builds the same XLSX we already generate for web downloads, and emails it as an attachment to the account owner. Handy for: the owner isn't in the hatch room but wants to see the latest; or they're showing the hatch progress to someone and want to send them a snapshot.

Proposed API endpoint to add:

```
POST /primus/email-report
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "hatch_id": "<uuid>"    // optional; if omitted, server picks the user's most recent active hatch
}

→ 200 {"ok":true,"emailed_to":"owner@example.com","hatch_name":"Sussex batch 1"}
→ 404 no active hatch for that user
```

Cloud does:
1. Resolve hatch (provided ID or most-recent-active for the Primus's user).
2. Build the workbook — **exact same `buildWorkbook` used by `/dashboard/hatches/:id/download`** so web downloads and emailed reports are byte-identical.
3. Send via Zoho SMTP (already configured for Supabase auth emails) using nodemailer — `From: hatch@originmonitor.com`, subject `"Origin Monitor hatch report — {hatch name}"`, attachment `{name}-{date}.xlsx`, body is a short branded HTML summary (name, day, current stats, "full report attached").
4. Log an event in a new `report_emails` table: `user_id`, `hatch_id`, `source` (`'primus'` | `'app'` | `'web'`), `sent_at`, `email_address` — audit trail + rate limit (no more than 1 per hatch per 10 minutes).

The same endpoint (or a twin) should be triggerable from web and app — a "📧 Email me this report" button next to the Download button. Useful for sending to oneself for archive or to someone else.

**Not yet built** — flag this to the planning-side Claude as *"proposed feature, please include in plan with storage, rate-limit, and UX details"*.

### 5.6 Proposed: Primus hatch-status dashboard

Primus is the best-placed surface for "glance at it from across the room". A dedicated dashboard, 4 big cards, designed for a 4.3" LCD. Not yet built.

**Design principle:** show *current state* as the headline (with target range colour-coding for instant pass/fail reading), and today's avg/min/max as smaller supporting context. Don't lead with averages — a 24h average can hide a spike happening right now.

#### Proposed endpoint

```
GET /primus/hatches
Authorization: Bearer <api_key>

→ 200
{
  "active": [
    {
      "id": "…",
      "name": "Sussex batch 1",
      "species_label": "Chicken",
      "day": 12,
      "total_days": 21,
      "days_to_lockdown": 6,
      "days_to_hatch": 9,
      "phase": "turning",                 // turning | lockdown | hatch | overdue | completed | failed
      "current": {
        "temperature_c": 37.52,
        "humidity_pct": 54.1,
        "updated_at": "2026-04-21T05:01:02Z"
      },
      "today": {
        "temp_avg": 37.48, "temp_min": 37.32, "temp_max": 37.61,
        "hum_avg": 53.7,   "hum_min": 52.0,   "hum_max": 55.3
      },
      "target": {
        "temp_min": 37.3, "temp_max": 37.8,   // from species, fixed
        "hum_min": 50,    "hum_max": 55       // shifts to 65/75 automatically during lockdown
      },
      "sensors_online": 2,
      "sensors_total": 2,
      "alerts": []                            // ["temp_high","humidity_low"] when outside target
    }
  ]
}
```

`current.temperature_c` / `current.humidity_pct` are the most recent reading across the hatch's linked sensors (average of latest per sensor if multiple).

Primus polls every 5 minutes. Recompute on the cloud each call — no DB table needed.

#### Four-card layout on the Primus LCD

| Card | Headline (big, bold) | Supporting context (small) | Colour |
|---|---|---|---|
| **1. Hatch** | `Day 12 / 21` | Hatch name · species · phase badge · progress bar | Brand gold |
| **2. Temperature** | `37.52 °C` | "Target 37.3–37.8" · today min · avg · max | **Green** if in target, **amber** if within ±0.3 °C of edge, **red** if outside |
| **3. Humidity** | `54 %` | "Target 50–55" (turning) or "Target 65–75" (lockdown) · today min · avg · max | Same traffic-light logic |
| **4. Countdown / status** | `6d to lockdown` | Sensors 2/2 online · "Last reading 30s ago" · ←/→ arrows if >1 active hatch | Brand gold |

If multiple active hatches exist, cycle between them with on-screen arrow buttons (preferred) or auto-rotate every 20 s.

**What the user can do from this screen:**
- View only — no hatch editing (small screen, no keyboard).
- Tap a card to drill into a slightly richer single-hatch view (bigger graph, readings list).
- Tap a dedicated **"Email report"** button (section 5.5) to get the current spreadsheet delivered to their inbox.

**What it deliberately does NOT show:** result counts, notes, raw readings table — those belong on web/app.

### 5.7 Origin Monitor app — current scope reminder

The app is being built in a parallel Claude Code session. Its hatch-side responsibilities, as briefed in `docs/APP_INTEGRATION.md`:

- Pair new sensors over BLE and register them in the cloud.
- Create, edit, complete, fail, reopen hatches — same schema as the web.
- **Primary surface for daily-log entries** (turnings, candling counts, observations) — once those fields exist in the cloud.
- Show live readings from BLE with cloud fallback for history.
- Push notifications for alerts (temperature out of range, lockdown reminder, expected-hatch-today).

The web exists in parallel — a customer can use either, and the two see the same data. Most customers will live in the app day-to-day but use the web to print / share / archive reports and to do more detailed review. Andrew (as support) uses the web admin pages to help customers.

---

## 6. Brand + tone

- **Name:** Origin Monitor (product line) · Origin Pro / Origin Lite (sensors) · Origin Primus (basestation) · Origin Arca (incubator, future) — **not** "Origin Genesis" (spec doc is stale on this).
- **Palette:** gold (`#C49A46`) on black (`#0A0F0A`), with cream highlights (`#E5C880`) and bronze section headers (`#8A6818`).
- **Voice:** premium, technical, direct. No fluff.
- **Owner:** Andrew Burfitt, Uneek Poultry (`uneekpoultry.com.au`). Australian market first; international customers from day one (the site timezone-detects per-user).

---

## 7. How to brief the other Claude

When asking the other conversation to spec its hatch-report plan against this:

- **Prefer additive changes.** The web UI, data model, and XLSX structure above are live in production. Change them only when the better version is meaningfully better — not for stylistic preference.
- **Call out new data fields explicitly.** Any field the plan needs that's not in section 1 is a new migration — name it, type it, and note who writes it (web / app / Primus) and how it propagates.
- **Map plan sections to existing sheets.** If the plan has, say, "daily turning log", say clearly whether it extends Sheet 2's manual columns or replaces them.
- **Flag anything that conflicts.** If the plan says "don't show X" but section 2 already shows X, resolve it — keep, remove, or change.
- **Respect the multi-sensor model.** A hatch can have any number of linked sensors. Summary stats are aggregated across all of them.
- **Respect the page-print targets.** Sheet 1 (Summary) must fit A4 portrait one page; Sheet 2 (Daily log) is landscape. Don't add columns that blow this out without a reason.
- **Assume the file is opened in Excel / Google Sheets / Numbers.** Formulas and formatting survive. Charts can be added (ExcelJS supports them); we haven't yet.
