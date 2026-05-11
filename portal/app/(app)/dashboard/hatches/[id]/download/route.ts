import ExcelJS from "exceljs";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { speciesPreset, addDays } from "@/lib/hatches/species";
import { batteryStatus } from "@/lib/battery";

// Origin brand palette — ARGB (alpha F-F + RGB).
const INK = "FF0A0F0A";
const GOLD = "FFC49A46";
const BRONZE = "FF8A6818";
const CREAM = "FFE5C880";
const WHITE = "FFFFFFFF";
const OFFWHITE = "FFF7F7F5";
const GREY = "FF8A928A";
const HAIRLINE = "FFE5E7E3";

const REFERENCE_SPECIES = [
  { name: "Chicken",           days: 21, lockdown: 18, tempC: 37.5, humLo: "50–55", humHi: "65–75" },
  { name: "Duck (Pekin)",      days: 28, lockdown: 25, tempC: 37.5, humLo: "55–58", humHi: "65–75" },
  { name: "Duck (Muscovy)",    days: 35, lockdown: 32, tempC: 37.5, humLo: "55–60", humHi: "65–75" },
  { name: "Goose",             days: 30, lockdown: 27, tempC: 37.3, humLo: "55–65", humHi: "75–85" },
  { name: "Turkey",            days: 28, lockdown: 25, tempC: 37.5, humLo: "55–60", humHi: "65–75" },
  { name: "Quail (Japanese)",  days: 17, lockdown: 14, tempC: 37.5, humLo: "45–55", humHi: "65–70" },
  { name: "Quail (Bobwhite)",  days: 23, lockdown: 20, tempC: 37.5, humLo: "45–55", humHi: "65–70" },
  { name: "Pheasant",          days: 24, lockdown: 21, tempC: 37.5, humLo: "55–60", humHi: "65–70" },
  { name: "Guinea fowl",       days: 28, lockdown: 25, tempC: 37.5, humLo: "50–55", humHi: "65–70" },
  { name: "Peafowl",           days: 28, lockdown: 25, tempC: 37.3, humLo: "55–60", humHi: "65–75" },
  { name: "Emu",               days: 52, lockdown: 49, tempC: 36.0, humLo: "20–30", humHi: "38–42" },
];

const TROUBLESHOOTING = [
  { issue: "Early quitters (days 1–7)",     cause: "Temp spikes, rough handling, genetic weakness" },
  { issue: "Blood ring on candling",        cause: "Early embryo death — often from temp too high" },
  { issue: "Fully developed, died in shell", cause: "Humidity too low during lockdown, or low O₂" },
  { issue: "Pipped but didn't hatch",       cause: "Humidity too high in lockdown — membrane wet, chick drowns" },
  { issue: "Sticky / shrink-wrapped chicks", cause: "Humidity crashed during pip; keep lid closed during hatch" },
  { issue: "Late hatches",                   cause: "Average temp too low — check calibration on multiple points" },
  { issue: "Early hatches",                  cause: "Average temp too high" },
  { issue: "Spraddle leg",                   cause: "Slippery hatcher floor, humidity too low at hatch, or genetic" },
  { issue: "Unabsorbed yolk",                cause: "Hatched too early or humidity too high — do not assist early" },
];

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Internal-auth path: service-role callers (our own server actions and the
  // Node.js API proxying Primus) can bypass session auth by passing the
  // service key and a user_id query param. This lets the XLSX generator be
  // called from outside a user's browser session.
  const internalAuth = req.headers.get("x-internal-auth");
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  const isInternal =
    !!serviceKey &&
    !!internalAuth &&
    internalAuth === `Bearer ${serviceKey}`;

  let supabase: Awaited<ReturnType<typeof createClient>>;
  let userId: string;

  if (isInternal) {
    const url = new URL(req.url);
    const uid = url.searchParams.get("user_id");
    if (!uid) return new Response("Missing user_id", { status: 400 });
    // Admin client bypasses RLS; filter explicitly by user_id.
    supabase = createAdminClient() as unknown as Awaited<
      ReturnType<typeof createClient>
    >;
    userId = uid;
  } else {
    supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return new Response("Unauthorized", { status: 401 });
    userId = user.id;
  }

  const { data: hatch } = await supabase
    .from("hatch_logs")
    .select(
      "id, name, species, egg_count, start_date, expected_hatch_date, actual_hatch_date, hatched_count, fertile_count, died_in_shell, pipped_not_hatched, early_deaths, notes, status, created_at, breed, egg_source, egg_source_detail, incubator_model, target_temp, target_humid_turn_min, target_humid_turn_max, target_humid_lock_min, target_humid_lock_max, first_pip_at, hatch_complete_at, chick_assessment, ambient_sensor_id",
    )
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!hatch) return new Response("Not found", { status: 404 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, timezone")
    .eq("id", userId)
    .maybeSingle();
  const tz = profile?.timezone || "UTC";

  const { data: links } = await supabase
    .from("hatch_sensors")
    .select("sensors(id, name, serial_number, model)")
    .eq("hatch_id", id);

  type LinkedSensor = {
    id: string;
    name: string | null;
    serial_number: string;
    model: string;
  };
  const sensors: LinkedSensor[] = (links ?? [])
    .map((l) => l.sensors as unknown as LinkedSensor | null)
    .filter((s): s is LinkedSensor => !!s);

  type Reading = {
    sensor_id: string;
    recorded_at: string;
    temperature: number | null;
    humidity: number | null;
    battery_mv: number | null;
  };
  let readings: Reading[] = [];
  if (sensors.length > 0) {
    const sensorIds = sensors.map((s) => s.id);
    // Supabase max-rows caps single-response rows at 1000 on managed
    // projects. Paginate so the XLSX captures every reading since hatch
    // start — otherwise the Daily Log + Raw readings sheets silently miss
    // whatever falls past the 1000-row threshold.
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("sensor_readings")
        .select("sensor_id, recorded_at, temperature, humidity, battery_mv")
        .in("sensor_id", sensorIds)
        .gte("recorded_at", hatch.start_date + "T00:00:00Z")
        .order("recorded_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      readings.push(...(data as Reading[]));
      if (data.length < PAGE) break;
      from += PAGE;
      if (from > 200000) break; // safety cap
    }
  }

  // Fetch ambient (room) sensor + its readings if the hatch has one linked.
  // Ambient readings are kept separate from incubator readings — they're
  // room context, not part of the incubator averages.
  type AmbientSensor = { id: string; name: string; serial_number: string };
  let ambientSensor: AmbientSensor | null = null;
  let ambientReadings: Reading[] = [];
  if (hatch.ambient_sensor_id) {
    const { data: aSensor } = await supabase
      .from("sensors")
      .select("id, name, serial_number")
      .eq("id", hatch.ambient_sensor_id)
      .maybeSingle();
    if (aSensor) {
      ambientSensor = {
        id: (aSensor as { id: string }).id,
        name: (aSensor as { name: string | null }).name ?? "",
        serial_number: (aSensor as { serial_number: string }).serial_number,
      };
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("sensor_readings")
          .select("sensor_id, recorded_at, temperature, humidity, battery_mv")
          .eq("sensor_id", ambientSensor.id)
          .gte("recorded_at", hatch.start_date + "T00:00:00Z")
          .order("recorded_at", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error || !data || data.length === 0) break;
        ambientReadings.push(...(data as Reading[]));
        if (data.length < PAGE) break;
        from += PAGE;
        if (from > 200000) break;
      }
    }
  }

  const preset = speciesPreset(hatch.species);

  // Bucket ambient readings per-day (dayIdx 1-based, aligned to hatch.start_date).
  // Uses the same user-TZ bucketing as the incubator Daily Log sheet.
  let ambient: {
    sensor: AmbientSensor;
    readingsByDay: Map<number, { tempAvg: number | null; humAvg: number | null }>;
  } | null = null;
  if (ambientSensor) {
    const byDate = new Map<string, { temps: number[]; hums: number[] }>();
    for (const r of ambientReadings) {
      const d = tzDate(r.recorded_at, tz);
      let bucket = byDate.get(d);
      if (!bucket) {
        bucket = { temps: [], hums: [] };
        byDate.set(d, bucket);
      }
      if (r.temperature != null && Number.isFinite(r.temperature))
        bucket.temps.push(r.temperature);
      if (r.humidity != null && Number.isFinite(r.humidity))
        bucket.hums.push(r.humidity);
    }
    const readingsByDay = new Map<
      number,
      { tempAvg: number | null; humAvg: number | null }
    >();
    const totalDays = (preset.days ?? 21) + 3;
    for (let dayIdx = 1; dayIdx <= totalDays; dayIdx++) {
      const dateIso = addDays(hatch.start_date, dayIdx - 1);
      const dateLocal = tzDate(dateIso + "T12:00:00Z", tz);
      const bucket = byDate.get(dateLocal);
      const tempAvg = bucket?.temps.length
        ? bucket.temps.reduce((a, b) => a + b, 0) / bucket.temps.length
        : null;
      const humAvg = bucket?.hums.length
        ? bucket.hums.reduce((a, b) => a + b, 0) / bucket.hums.length
        : null;
      readingsByDay.set(dayIdx, { tempAvg, humAvg });
    }
    ambient = { sensor: ambientSensor, readingsByDay };
  }

  // Fetch milestones (including daily_log entries for per-day turnings/notes)
  const { data: milestoneRows } = await supabase
    .from("hatch_milestones")
    .select(
      "id, milestone_type, occurred_at, day_number, fertile_count, removed_count, eggs_remaining, turning_count, notes",
    )
    .eq("hatch_id", id);
  const milestones = (milestoneRows ?? []) as MilestoneRow[];

  const wb = new ExcelJS.Workbook();
  wb.creator = "Origin Monitor";
  wb.company = "Uneek Poultry";
  wb.created = new Date();

  buildSummarySheet(wb, hatch, sensors, readings, preset, profile, tz, ambient);
  buildDailyLogSheet(wb, hatch, sensors, readings, milestones, preset, tz, ambient);
  buildRawReadingsSheet(wb, sensors, readings, tz);
  buildMilestonesSheet(wb, milestones, tz);
  buildReferenceSheet(wb);

  const buffer = await wb.xlsx.writeBuffer();
  const safe = (hatch.name || "hatch").replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 48);
  const filename = `${safe}-${hatch.start_date}.xlsx`;

  return new Response(buffer, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// -----------------------------------------------------------------------------

type HatchRow = {
  name: string;
  species: string | null;
  egg_count: number | null;
  start_date: string;
  expected_hatch_date: string | null;
  actual_hatch_date: string | null;
  hatched_count: number | null;
  fertile_count: number | null;
  died_in_shell: number | null;
  pipped_not_hatched: number | null;
  early_deaths: number | null;
  notes: string | null;
  status: string;
  breed: string | null;
  egg_source: string | null;
  egg_source_detail: string | null;
  incubator_model: string | null;
  target_temp: number | null;
  target_humid_turn_min: number | null;
  target_humid_turn_max: number | null;
  target_humid_lock_min: number | null;
  target_humid_lock_max: number | null;
  first_pip_at: string | null;
  hatch_complete_at: string | null;
  chick_assessment: string | null;
  ambient_sensor_id: string | null;
};

type MilestoneRow = {
  id: string;
  milestone_type:
    | "daily_log"
    | "candling_1"
    | "candling_2"
    | "lockdown"
    | "observation"
    | "custom";
  occurred_at: string;
  day_number: number | null;
  fertile_count: number | null;
  removed_count: number | null;
  eggs_remaining: number | null;
  turning_count: number | null;
  notes: string | null;
};

type LinkedSensor = {
  id: string;
  name: string | null;
  serial_number: string;
  model: string;
};

type Reading = {
  sensor_id: string;
  recorded_at: string;
  temperature: number | null;
  humidity: number | null;
  battery_mv: number | null;
};

function fmtDate(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  return new Date(iso + (iso.length === 10 ? "T00:00:00Z" : "")).toLocaleDateString(
    "en-GB",
    { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz },
  );
}

function fmtDateTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  });
}

function tzDate(iso: string, tz: string): string {
  // Returns yyyy-mm-dd in the given timezone (stable for grouping).
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

// -----------------------------------------------------------------------------

function buildSummarySheet(
  wb: ExcelJS.Workbook,
  hatch: HatchRow,
  sensors: LinkedSensor[],
  readings: Reading[],
  preset: {
    label: string;
    days: number;
    lockdown: number;
    targetTemp: number;
    humTurnMin: number;
    humTurnMax: number;
    humLockMin: number;
    humLockMax: number;
  },
  profile: { full_name: string | null; timezone: string } | null,
  tz: string,
  ambient?: {
    sensor: { id: string; name: string; serial_number: string };
    readingsByDay: Map<number, { tempAvg: number | null; humAvg: number | null }>;
  } | null,
) {
  const ws = wb.addWorksheet("Summary", {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9, // A4
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      margins: {
        left: 0.5,
        right: 0.5,
        top: 0.6,
        bottom: 0.6,
        header: 0.3,
        footer: 0.3,
      },
      horizontalCentered: true,
    },
  });

  // Total width kept tight for A4 portrait with half-inch margins.
  ws.columns = [
    { width: 20 },
    { width: 22 },
    { width: 5 },
    { width: 20 },
    { width: 22 },
  ];

  // Header block --------------------------------------------------
  ws.mergeCells("A1:E1");
  const title = ws.getCell("A1");
  title.value = "ORIGIN MONITOR";
  title.font = { name: "Calibri", size: 24, bold: true, color: { argb: GOLD } };
  title.alignment = { horizontal: "center", vertical: "middle" };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
  ws.getRow(1).height = 42;

  ws.mergeCells("A2:E2");
  const subtitle = ws.getCell("A2");
  subtitle.value = "Hatch report";
  subtitle.font = {
    name: "Calibri",
    size: 12,
    color: { argb: CREAM },
    italic: true,
  };
  subtitle.alignment = { horizontal: "center" };
  subtitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
  ws.getRow(2).height = 20;

  ws.mergeCells("A3:E3");
  const gen = ws.getCell("A3");
  gen.value = `Generated ${fmtDateTime(new Date().toISOString(), tz)} · ${profile?.full_name ?? ""}`;
  gen.font = { name: "Calibri", size: 9, color: { argb: GREY } };
  gen.alignment = { horizontal: "center" };
  ws.getRow(3).height = 18;

  let row = 5;

  row = sectionHeader(ws, row, "Hatch details");
  labelValue(ws, row++, "Name", hatch.name);
  labelValue(ws, row++, "Species", preset.label);
  labelValuePair(
    ws,
    row++,
    "Eggs set",
    hatch.egg_count,
    "Status",
    capitalize(hatch.status),
  );
  labelValuePair(
    ws,
    row++,
    "Started",
    fmtDate(hatch.start_date, tz),
    "Lockdown",
    fmtDate(addDays(hatch.start_date, preset.lockdown), tz),
  );
  labelValuePair(
    ws,
    row++,
    "Expected hatch",
    fmtDate(hatch.expected_hatch_date, tz),
    "Actual hatch",
    fmtDate(hatch.actual_hatch_date, tz),
  );

  if (hatch.breed) {
    labelValue(ws, row++, "Breed", hatch.breed);
  }
  if (hatch.egg_source) {
    labelValue(ws, row++, "Egg source", formatEggSource(hatch));
  }
  if (hatch.incubator_model) {
    labelValue(ws, row++, "Incubator", hatch.incubator_model);
  }

  const targetTemp = hatch.target_temp ?? preset.targetTemp;
  const humTMin = hatch.target_humid_turn_min ?? preset.humTurnMin;
  const humTMax = hatch.target_humid_turn_max ?? preset.humTurnMax;
  const humLMin = hatch.target_humid_lock_min ?? preset.humLockMin;
  const humLMax = hatch.target_humid_lock_max ?? preset.humLockMax;
  labelValuePair(
    ws,
    row++,
    "Target temp",
    `${targetTemp.toFixed(1)} °C`,
    "Humidity turning",
    `${humTMin}–${humTMax}%`,
  );
  labelValue(
    ws,
    row++,
    "Humidity lockdown",
    `${humLMin}–${humLMax}%`,
  );

  const sensorLabels =
    sensors.length === 0
      ? "— no sensors linked —"
      : sensors
          .map(
            (s) =>
              `${s.name || s.serial_number} (${s.model === "pro" ? "Pro" : "Lite"})`,
          )
          .join(", ");
  labelValueMerged(ws, row++, "Sensors", sensorLabels);
  if (ambient) {
    labelValueMerged(
      ws,
      row++,
      "Room sensor",
      ambient.sensor.name || ambient.sensor.serial_number,
    );
  }

  row++;
  row = sectionHeader(ws, row, "Incubation environment");
  // Headings
  ws.getCell(`A${row}`).value = "";
  ws.getCell(`B${row}`).value = "Temperature (°C)";
  ws.getCell(`D${row}`).value = "Humidity (%)";
  [`B${row}`, `D${row}`].forEach((r) => {
    const c = ws.getCell(r);
    c.font = { bold: true, color: { argb: BRONZE } };
    c.alignment = { horizontal: "center" };
  });
  row++;

  const stats = computeStats(readings);
  const envRows: [string, number | null, number | null][] = [
    ["Minimum", stats.tempMin, stats.humMin],
    ["Average", stats.tempAvg, stats.humAvg],
    ["Maximum", stats.tempMax, stats.humMax],
  ];
  envRows.forEach(([label, t, h]) => {
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).font = { color: { argb: GREY } };
    ws.mergeCells(`B${row}:C${row}`);
    const tc = ws.getCell(`B${row}`);
    tc.value = t;
    tc.numFmt = t == null ? "@" : "0.00";
    tc.alignment = { horizontal: "center" };
    ws.mergeCells(`D${row}:E${row}`);
    const hc = ws.getCell(`D${row}`);
    hc.value = h;
    hc.numFmt = h == null ? "@" : "0.0";
    hc.alignment = { horizontal: "center" };
    row++;
  });
  labelValue(ws, row++, "Total readings", readings.length);

  row++;
  row = sectionHeader(ws, row, "Results");
  labelValue(ws, row, "Eggs set", hatch.egg_count);
  const eggsSetRow = row;
  row++;
  labelValue(
    ws,
    row,
    "Fertile eggs (from candling)",
    hatch.fertile_count,
    hatch.fertile_count == null,
  );
  const fertileRow = row;
  row++;
  labelValue(
    ws,
    row,
    "Hatched alive",
    hatch.hatched_count,
    hatch.hatched_count == null,
  );
  const hatchedRow = row;
  row++;
  labelValue(
    ws,
    row,
    "Died in shell",
    hatch.died_in_shell,
    hatch.died_in_shell == null,
  );
  row++;
  labelValue(
    ws,
    row,
    "Pipped but didn't hatch",
    hatch.pipped_not_hatched,
    hatch.pipped_not_hatched == null,
  );
  row++;
  labelValue(
    ws,
    row,
    "Early deaths (quitters)",
    hatch.early_deaths,
    hatch.early_deaths == null,
  );
  row++;
  row++;

  // Formulas — let the user paste in fertile / hatched and rates recalculate
  const eggsRef = `B${eggsSetRow}`;
  const fertileRef = `B${fertileRow}`;
  const hatchedRef = `B${hatchedRow}`;
  formulaRow(
    ws,
    row++,
    "Hatch rate (of set)",
    `=IFERROR(${hatchedRef}/${eggsRef},"")`,
    "0.0%",
  );
  formulaRow(
    ws,
    row++,
    "Fertility rate (of set)",
    `=IFERROR(${fertileRef}/${eggsRef},"")`,
    "0.0%",
  );
  formulaRow(
    ws,
    row++,
    "Hatch of fertile",
    `=IFERROR(${hatchedRef}/${fertileRef},"")`,
    "0.0%",
  );

  // --- Hatch timing ---
  if (hatch.first_pip_at || hatch.hatch_complete_at) {
    row++;
    row = sectionHeader(ws, row, "Hatch timing");
    labelValue(
      ws,
      row++,
      "First pip",
      hatch.first_pip_at ? fmtDateTime(hatch.first_pip_at, tz) : null,
      !hatch.first_pip_at,
    );
    labelValue(
      ws,
      row++,
      "Hatch complete",
      hatch.hatch_complete_at
        ? fmtDateTime(hatch.hatch_complete_at, tz)
        : null,
      !hatch.hatch_complete_at,
    );
    if (hatch.first_pip_at && hatch.hatch_complete_at) {
      const a = new Date(hatch.first_pip_at).getTime();
      const b = new Date(hatch.hatch_complete_at).getTime();
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
        const mins = Math.round((b - a) / 60000);
        const d = Math.floor(mins / 1440);
        const h = Math.floor((mins % 1440) / 60);
        const m = mins % 60;
        const parts: string[] = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        if (m > 0 || parts.length === 0) parts.push(`${m}m`);
        labelValue(ws, row++, "Hatch window", parts.join(" "));
      }
    }
    if (hatch.chick_assessment) {
      labelValueMerged(ws, row++, "Chick assessment", hatch.chick_assessment);
    }
  }

  // --- Incubation quality ---
  row++;
  row = sectionHeader(ws, row, "Incubation quality");
  const quality = computeQuality(readings, targetTemp, humTMin, humTMax);
  labelValue(
    ws,
    row++,
    "Temp stability (±0.5 °C)",
    quality.tempStability != null
      ? `${quality.tempStability.toFixed(1)}%`
      : "— no data —",
  );
  labelValue(
    ws,
    row++,
    "Humidity stability (±3%)",
    quality.humStability != null
      ? `${quality.humStability.toFixed(1)}%`
      : "— no data —",
  );
  labelValue(
    ws,
    row++,
    "Temperature excursions",
    quality.tempExcursions.toLocaleString(),
  );
  labelValue(
    ws,
    row++,
    "Longest temp excursion",
    quality.longestExcursionMin > 0
      ? `${quality.longestExcursionMin} min`
      : "—",
  );

  row++;
  row = sectionHeader(ws, row, "Notes");
  ws.mergeCells(`A${row}:E${row + 4}`);
  const notesCell = ws.getCell(`A${row}`);
  notesCell.value = hatch.notes ?? "";
  notesCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
  notesCell.font = { color: { argb: INK } };
  notesCell.border = borderAll(HAIRLINE);
  for (let i = 0; i < 5; i++) ws.getRow(row + i).height = 22;
  row += 5;

  row++;
  const footer = ws.getCell(`A${row}`);
  ws.mergeCells(`A${row}:E${row}`);
  footer.value =
    "Powered by Origin Monitor · uneekpoultry.com.au · originmonitor.com";
  footer.font = { italic: true, color: { argb: GREY }, size: 9 };
  footer.alignment = { horizontal: "center" };
}

// -----------------------------------------------------------------------------

function buildDailyLogSheet(
  wb: ExcelJS.Workbook,
  hatch: HatchRow,
  _sensors: LinkedSensor[],
  readings: Reading[],
  milestones: MilestoneRow[],
  preset: { label: string; days: number; lockdown: number; targetTemp: number },
  tz: string,
  ambient?: {
    sensor: { id: string; name: string; serial_number: string };
    readingsByDay: Map<number, { tempAvg: number | null; humAvg: number | null }>;
  } | null,
) {
  // Amber palette for room (ambient) sensor columns — matches the amber
  // treatment used in the web dashboard so "room context" reads as distinct
  // from main incubator columns.
  const AMBER_DARK = "FFB8731E";
  const AMBER_LIGHT = "FFFDF4E3";
  const hasAmbient = !!ambient;
  // Room columns sit to the right of the incubator columns but before the
  // existing Turnings/Candling/Observations/Excursion text columns. Easiest
  // layout: append them at the far right so we don't shift existing column
  // letters used by conditional formatting and lockdown-row styling.
  // Index milestones for quick per-day lookup
  const dailyLogByDay = new Map<number, MilestoneRow>();
  const candlingByDay = new Map<number, MilestoneRow>();
  const observationsByDay = new Map<number, MilestoneRow[]>();
  for (const m of milestones) {
    if (m.day_number == null) continue;
    if (m.milestone_type === "daily_log") {
      dailyLogByDay.set(m.day_number, m);
    } else if (
      m.milestone_type === "candling_1" ||
      m.milestone_type === "candling_2"
    ) {
      candlingByDay.set(m.day_number, m);
    } else if (m.notes) {
      const list = observationsByDay.get(m.day_number) ?? [];
      list.push(m);
      observationsByDay.set(m.day_number, list);
    }
  }
  const ws = wb.addWorksheet("Daily log", {
    views: [{ state: "frozen", xSplit: 0, ySplit: 2 }],
    pageSetup: {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      margins: {
        left: 0.4,
        right: 0.4,
        top: 0.5,
        bottom: 0.5,
        header: 0.3,
        footer: 0.3,
      },
      horizontalCentered: true,
      printTitlesRow: "1:2",
    },
  });

  // Row 1 — banner. Span all columns (including optional ambient pair).
  const totalCols = hasAmbient ? 14 : 12;
  const lastColLetter = hasAmbient ? "N" : "L";
  ws.mergeCells(`A1:${lastColLetter}1`);
  const banner = ws.getCell("A1");
  banner.value = `${hatch.name} · ${preset.label} · target ${String(preset.days === 21 ? "37.5 °C" : preset.days > 25 ? "37.5 °C" : "37.5 °C")}`;
  banner.font = { bold: true, color: { argb: WHITE } };
  banner.fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
  banner.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 24;

  // Row 2 — column headers
  const headers = [
    "Day",
    "Date",
    "Temp avg (°C)",
    "Temp min (°C)",
    "Temp max (°C)",
    "Humid avg (%)",
    "Humid min (%)",
    "Humid max (%)",
    "Turnings",
    "Candling notes",
    "Observations",
    "Excursion",
  ];
  if (hasAmbient) {
    headers.push("Room °C", "Room %RH");
  }
  ws.getRow(2).values = headers;
  ws.getRow(2).eachCell((c, colNumber) => {
    const isRoomCol = hasAmbient && (colNumber === 13 || colNumber === 14);
    c.font = { bold: true, color: { argb: WHITE } };
    c.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: isRoomCol ? AMBER_DARK : BRONZE },
    };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.border = borderAll(HAIRLINE);
  });
  ws.getRow(2).height = 32;

  const colWidths: Partial<ExcelJS.Column>[] = [
    { width: 5 },
    { width: 11 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 9 },
    { width: 18 },
    { width: 26 },
    { width: 9 },
  ];
  if (hasAmbient) {
    colWidths.push({ width: 10 }, { width: 11 });
  }
  ws.columns = colWidths;

  // Group readings by local date
  const byDate = new Map<
    string,
    { temps: number[]; hums: number[] }
  >();
  for (const r of readings) {
    const d = tzDate(r.recorded_at, tz);
    let bucket = byDate.get(d);
    if (!bucket) {
      bucket = { temps: [], hums: [] };
      byDate.set(d, bucket);
    }
    if (r.temperature != null && Number.isFinite(r.temperature))
      bucket.temps.push(r.temperature);
    if (r.humidity != null && Number.isFinite(r.humidity))
      bucket.hums.push(r.humidity);
  }

  // Generate rows for day 1 .. expected + 3
  const totalDays = (preset.days ?? 21) + 3;
  for (let dayIdx = 1; dayIdx <= totalDays; dayIdx++) {
    const dateIso = addDays(hatch.start_date, dayIdx - 1);
    const dateLocal = tzDate(dateIso + "T12:00:00Z", tz); // use noon to avoid TZ drift
    const bucket = byDate.get(dateLocal);
    const tempAvg = bucket?.temps.length
      ? bucket.temps.reduce((a, b) => a + b, 0) / bucket.temps.length
      : null;
    const tempMin = bucket?.temps.length ? Math.min(...bucket.temps) : null;
    const tempMax = bucket?.temps.length ? Math.max(...bucket.temps) : null;
    const humAvg = bucket?.hums.length
      ? bucket.hums.reduce((a, b) => a + b, 0) / bucket.hums.length
      : null;
    const humMin = bucket?.hums.length ? Math.min(...bucket.hums) : null;
    const humMax = bucket?.hums.length ? Math.max(...bucket.hums) : null;

    const rowIdx = 2 + dayIdx;

    // Pull turnings / candling / observations for this day from milestones
    const dl = dailyLogByDay.get(dayIdx);
    const c = candlingByDay.get(dayIdx);
    const candlingText = c
      ? [
          c.fertile_count != null ? `Fertile: ${c.fertile_count}` : "",
          c.removed_count != null ? `Removed: ${c.removed_count}` : "",
          c.notes ? c.notes : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    const obs = observationsByDay.get(dayIdx) ?? [];
    const obsText = obs
      .map((o) => o.notes)
      .filter(Boolean)
      .join(" / ");
    const observationsText = [dl?.notes, obsText].filter(Boolean).join(" / ");

    // Temperature excursion for the day — was any reading outside ±0.5 °C?
    const targetT = hatch.target_temp ?? preset.targetTemp;
    const hadExcursion =
      (bucket?.temps ?? []).some((t) => Math.abs(t - targetT) > 0.5);

    const rowValues: (string | number | null)[] = [
      dayIdx,
      fmtDate(dateIso, tz),
      tempAvg,
      tempMin,
      tempMax,
      humAvg,
      humMin,
      humMax,
      dl?.turning_count ?? null,
      candlingText || null,
      observationsText || null,
      bucket?.temps.length ? (hadExcursion ? "Y" : "N") : null,
    ];
    if (hasAmbient && ambient) {
      const roomDay = ambient.readingsByDay.get(dayIdx);
      rowValues.push(
        roomDay?.tempAvg ?? null,
        roomDay?.humAvg ?? null,
      );
    }
    ws.getRow(rowIdx).values = rowValues;

    // Format temp cells
    ["C", "D", "E"].forEach((col) => {
      const c = ws.getCell(`${col}${rowIdx}`);
      c.numFmt = "0.00";
      c.alignment = { horizontal: "center" };
    });
    ["F", "G", "H"].forEach((col) => {
      const c = ws.getCell(`${col}${rowIdx}`);
      c.numFmt = "0.0";
      c.alignment = { horizontal: "center" };
    });
    ws.getCell(`A${rowIdx}`).alignment = { horizontal: "center" };
    ws.getCell(`B${rowIdx}`).alignment = { horizontal: "center" };

    // Room (ambient) cells — amber tint so they read as "room context"
    // distinct from the main incubator columns.
    if (hasAmbient) {
      const roomTemp = ws.getCell(`M${rowIdx}`);
      roomTemp.numFmt = "0.00";
      roomTemp.alignment = { horizontal: "center" };
      roomTemp.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: AMBER_LIGHT },
      };
      const roomHum = ws.getCell(`N${rowIdx}`);
      roomHum.numFmt = "0.0";
      roomHum.alignment = { horizontal: "center" };
      roomHum.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: AMBER_LIGHT },
      };
    }

    // Highlight lockdown row with a cream band. Skip the ambient/room
    // columns so their amber tint stays intact.
    if (dayIdx === preset.lockdown) {
      const fill: ExcelJS.Fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFBF1DA" },
      };
      for (let col = 1; col <= 12; col++) {
        const c = ws.getRow(rowIdx).getCell(col);
        c.fill = fill;
        if (col === 1 || col === 2) c.font = { bold: true };
      }
      const lockCell = ws.getCell(`J${rowIdx}`);
      if (!lockCell.value) lockCell.value = "LOCKDOWN begins";
      lockCell.font = { bold: true, color: { argb: BRONZE } };
    }
    if (dayIdx === preset.days) {
      const fill: ExcelJS.Fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEAF6DC" },
      };
      for (let col = 1; col <= 12; col++) {
        const c = ws.getRow(rowIdx).getCell(col);
        c.fill = fill;
        if (col === 1 || col === 2) c.font = { bold: true };
      }
      const hatchCell = ws.getCell(`J${rowIdx}`);
      if (!hatchCell.value) hatchCell.value = "Expected hatch day";
      hatchCell.font = { bold: true, color: { argb: BRONZE } };
    }
  }
  // Silence unused-variable lint — totalCols reserved for future full-width
  // features (e.g. row borders spanning ambient cols).
  void totalCols;

  // Conditional formatting for out-of-range temp (37.2 – 37.8 target typical)
  const lastRow = 2 + totalDays;
  ws.addConditionalFormatting({
    ref: `C3:E${lastRow}`,
    rules: [
      {
        type: "cellIs",
        operator: "lessThan",
        priority: 1,
        formulae: ["37.0"],
        style: { font: { color: { argb: "FFB42323" } } },
      },
      {
        type: "cellIs",
        operator: "greaterThan",
        priority: 2,
        formulae: ["37.9"],
        style: { font: { color: { argb: "FFB42323" } } },
      },
    ],
  });
}

// -----------------------------------------------------------------------------

function buildRawReadingsSheet(
  wb: ExcelJS.Workbook,
  sensors: LinkedSensor[],
  readings: Reading[],
  tz: string,
) {
  const ws = wb.addWorksheet("Raw readings", {
    views: [{ state: "frozen", xSplit: 0, ySplit: 1 }],
    pageSetup: {
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      margins: {
        left: 0.4,
        right: 0.4,
        top: 0.5,
        bottom: 0.5,
        header: 0.3,
        footer: 0.3,
      },
      printTitlesRow: "1:1",
    },
  });

  ws.columns = [
    { header: "Timestamp", key: "ts", width: 22 },
    { header: "Sensor", key: "sn", width: 26 },
    { header: "Temperature (°C)", key: "t", width: 18 },
    { header: "Humidity (%)", key: "h", width: 14 },
    { header: "Battery", key: "b", width: 12 },
  ];

  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: WHITE } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRONZE } };
    c.alignment = { horizontal: "center", vertical: "middle" };
  });
  ws.getRow(1).height = 22;

  const byId = new Map(sensors.map((s) => [s.id, s]));

  // addRows is much faster than cell-by-cell for big tables
  const rows = readings.map((r) => {
    const s = byId.get(r.sensor_id);
    const bat = batteryStatus(r.battery_mv);
    return {
      ts: fmtDateTime(r.recorded_at, tz),
      sn: s ? s.name || s.serial_number : r.sensor_id,
      t: r.temperature,
      h: r.humidity,
      b: bat ? `${bat.percent}% (${bat.label})` : "—",
    };
  });
  ws.addRows(rows);

  // Number formats + alignment for data rows
  for (let i = 2; i <= readings.length + 1; i++) {
    ws.getCell(`C${i}`).numFmt = "0.00";
    ws.getCell(`D${i}`).numFmt = "0.0";
    ws.getCell(`C${i}`).alignment = { horizontal: "center" };
    ws.getCell(`D${i}`).alignment = { horizontal: "center" };
    ws.getCell(`E${i}`).alignment = { horizontal: "center" };
  }

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: 5 },
  };
}

// -----------------------------------------------------------------------------

function buildMilestonesSheet(
  wb: ExcelJS.Workbook,
  milestones: MilestoneRow[],
  tz: string,
) {
  const ws = wb.addWorksheet("Milestones", {
    views: [{ state: "frozen", xSplit: 0, ySplit: 1 }],
    pageSetup: {
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      margins: {
        left: 0.4,
        right: 0.4,
        top: 0.5,
        bottom: 0.5,
        header: 0.3,
        footer: 0.3,
      },
      printTitlesRow: "1:1",
    },
  });

  ws.columns = [
    { header: "Milestone", key: "m", width: 24 },
    { header: "Date", key: "d", width: 20 },
    { header: "Day", key: "day", width: 6 },
    { header: "Fertile", key: "f", width: 10 },
    { header: "Removed", key: "r", width: 10 },
    { header: "Remaining", key: "rem", width: 12 },
    { header: "Turnings", key: "t", width: 10 },
    { header: "Notes", key: "n", width: 40 },
  ];

  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: WHITE } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRONZE } };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  ws.getRow(1).height = 22;

  const labels: Record<string, string> = {
    candling_1: "Candling — Day 7",
    candling_2: "Candling — Day 14",
    lockdown: "Lockdown",
    daily_log: "Daily log",
    observation: "Observation",
    custom: "Custom",
  };

  // Sort by day_number, then occurred_at
  const sorted = [...milestones].sort((a, b) => {
    const da = a.day_number ?? 999;
    const db = b.day_number ?? 999;
    if (da !== db) return da - db;
    return new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime();
  });

  sorted.forEach((m, i) => {
    const baseLabel = labels[m.milestone_type] ?? m.milestone_type;
    const mlabel =
      m.milestone_type === "daily_log" && m.day_number != null
        ? `Daily log — Day ${m.day_number}`
        : baseLabel;
    ws.addRow({
      m: mlabel,
      d: fmtDateTime(m.occurred_at, tz),
      day: m.day_number,
      f: m.fertile_count,
      r: m.removed_count,
      rem: m.eggs_remaining,
      t: m.turning_count,
      n: m.notes ?? "",
    });
    const rowIdx = 2 + i;
    const r = ws.getRow(rowIdx);
    if (i % 2 === 0) {
      r.eachCell((c) => {
        c.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: OFFWHITE },
        };
      });
    }
    ["C", "D", "E", "F", "G"].forEach((col) => {
      ws.getCell(`${col}${rowIdx}`).alignment = { horizontal: "center" };
    });
    ws.getCell(`H${rowIdx}`).alignment = {
      horizontal: "left",
      vertical: "top",
      wrapText: true,
    };
  });

  if (sorted.length === 0) {
    ws.mergeCells("A2:H2");
    const c = ws.getCell("A2");
    c.value = "No milestones logged yet.";
    c.alignment = { horizontal: "center" };
    c.font = { italic: true, color: { argb: GREY } };
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 } };
}

// -----------------------------------------------------------------------------

function buildReferenceSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Reference", {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      margins: {
        left: 0.5,
        right: 0.5,
        top: 0.5,
        bottom: 0.5,
        header: 0.3,
        footer: 0.3,
      },
    },
  });

  ws.columns = [
    { width: 22 },
    { width: 10 },
    { width: 12 },
    { width: 14 },
    { width: 28 },
    { width: 28 },
  ];

  ws.mergeCells("A1:F1");
  const title = ws.getCell("A1");
  title.value = "Incubation reference";
  title.font = { bold: true, size: 16, color: { argb: INK } };
  ws.getRow(1).height = 28;

  ws.getRow(3).values = [
    "Species",
    "Days",
    "Lockdown",
    "Target temp (°C)",
    "Humidity — turning phase (%)",
    "Humidity — lockdown (%)",
  ];
  ws.getRow(3).eachCell((c) => {
    c.font = { bold: true, color: { argb: WHITE } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRONZE } };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  ws.getRow(3).height = 34;

  REFERENCE_SPECIES.forEach((s, i) => {
    const row = 4 + i;
    ws.getRow(row).values = [
      s.name,
      s.days,
      s.lockdown,
      s.tempC,
      s.humLo,
      s.humHi,
    ];
    ws.getCell(`D${row}`).numFmt = "0.0";
    for (let col = 2; col <= 6; col++) {
      ws.getRow(row).getCell(col).alignment = { horizontal: "center" };
    }
    if (i % 2 === 0) {
      ws.getRow(row).eachCell((c) => {
        c.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: OFFWHITE },
        };
      });
    }
  });

  let row = 4 + REFERENCE_SPECIES.length + 2;
  ws.mergeCells(`A${row}:F${row}`);
  const h2 = ws.getCell(`A${row}`);
  h2.value = "Common problems & likely causes";
  h2.font = { bold: true, size: 14, color: { argb: INK } };
  row += 2;

  ws.getRow(row).values = ["Issue", "Likely cause"];
  ws.mergeCells(`A${row}:B${row}`);
  ws.mergeCells(`C${row}:F${row}`);
  [`A${row}`, `C${row}`].forEach((r) => {
    const c = ws.getCell(r);
    c.font = { bold: true, color: { argb: WHITE } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRONZE } };
    c.alignment = { horizontal: "left", vertical: "middle" };
  });
  ws.getRow(row).height = 22;
  row++;

  TROUBLESHOOTING.forEach((t, i) => {
    ws.mergeCells(`A${row}:B${row}`);
    ws.mergeCells(`C${row}:F${row}`);
    ws.getCell(`A${row}`).value = t.issue;
    ws.getCell(`A${row}`).font = { bold: true };
    ws.getCell(`C${row}`).value = t.cause;
    if (i % 2 === 0) {
      [`A${row}`, `C${row}`].forEach((r) => {
        ws.getCell(r).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: OFFWHITE },
        };
      });
    }
    ws.getRow(row).height = 22;
    ws.getCell(`A${row}`).alignment = { vertical: "middle", wrapText: true };
    ws.getCell(`C${row}`).alignment = { vertical: "middle", wrapText: true };
    row++;
  });

  row += 2;
  ws.mergeCells(`A${row}:F${row}`);
  const foot = ws.getCell(`A${row}`);
  foot.value =
    "These are typical industry targets. Your incubator, altitude, and breed can shift them. Log your own results over several hatches to tune.";
  foot.font = { italic: true, color: { argb: GREY } };
  foot.alignment = { wrapText: true };
  ws.getRow(row).height = 40;
}

// -----------------------------------------------------------------------------
// Helpers

function sectionHeader(
  ws: ExcelJS.Worksheet,
  row: number,
  text: string,
): number {
  ws.mergeCells(`A${row}:E${row}`);
  const c = ws.getCell(`A${row}`);
  c.value = text.toUpperCase();
  c.font = { bold: true, size: 10, color: { argb: WHITE } };
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRONZE } };
  c.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
  ws.getRow(row).height = 22;
  return row + 1;
}

function labelValue(
  ws: ExcelJS.Worksheet,
  row: number,
  label: string,
  value: string | number | null,
  emptyIsUserFill = false,
) {
  const lbl = ws.getCell(`A${row}`);
  lbl.value = label;
  lbl.font = { color: { argb: GREY } };
  ws.mergeCells(`B${row}:E${row}`);
  const val = ws.getCell(`B${row}`);
  val.value = value == null ? "" : (value as string | number);
  val.font = {
    color: { argb: INK },
    italic: emptyIsUserFill && value == null,
  };
  if (emptyIsUserFill && value == null) {
    val.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFBF7EF" },
    };
  }
}

function labelValuePair(
  ws: ExcelJS.Worksheet,
  row: number,
  labelA: string,
  valueA: string | number | null,
  labelB: string,
  valueB: string | number | null,
) {
  ws.getCell(`A${row}`).value = labelA;
  ws.getCell(`A${row}`).font = { color: { argb: GREY } };
  ws.getCell(`B${row}`).value = valueA == null ? "" : (valueA as string | number);
  ws.getCell(`D${row}`).value = labelB;
  ws.getCell(`D${row}`).font = { color: { argb: GREY } };
  ws.getCell(`E${row}`).value = valueB == null ? "" : (valueB as string | number);
}

function labelValueMerged(
  ws: ExcelJS.Worksheet,
  row: number,
  label: string,
  value: string,
) {
  const lbl = ws.getCell(`A${row}`);
  lbl.value = label;
  lbl.font = { color: { argb: GREY } };
  ws.mergeCells(`B${row}:E${row}`);
  const val = ws.getCell(`B${row}`);
  val.value = value;
  val.alignment = { wrapText: true, vertical: "top" };
}

function formulaRow(
  ws: ExcelJS.Worksheet,
  row: number,
  label: string,
  formula: string,
  numFmt: string,
) {
  const lbl = ws.getCell(`A${row}`);
  lbl.value = label;
  lbl.font = { color: { argb: GREY } };
  ws.mergeCells(`B${row}:E${row}`);
  const v = ws.getCell(`B${row}`);
  v.value = { formula };
  v.numFmt = numFmt;
  v.font = { bold: true, color: { argb: BRONZE } };
}

function borderAll(color: string): Partial<ExcelJS.Borders> {
  const side: Partial<ExcelJS.Border> = {
    style: "thin",
    color: { argb: color },
  };
  return { top: side, bottom: side, left: side, right: side };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatEggSource(hatch: HatchRow): string {
  if (!hatch.egg_source) return "";
  const labels: Record<string, string> = {
    own_flock: "Own flock",
    purchased: "Purchased",
    shipped: "Shipped",
    other: "Other",
  };
  const base = labels[hatch.egg_source] ?? hatch.egg_source;
  return hatch.egg_source_detail ? `${base} — ${hatch.egg_source_detail}` : base;
}

function computeQuality(
  readings: Reading[],
  targetTemp: number,
  humTurnMin: number,
  humTurnMax: number,
): {
  tempStability: number | null;
  humStability: number | null;
  tempExcursions: number;
  longestExcursionMin: number;
} {
  const temps = readings.filter(
    (r) => r.temperature != null && Number.isFinite(r.temperature),
  );
  const hums = readings.filter(
    (r) => r.humidity != null && Number.isFinite(r.humidity),
  );

  const tempStability =
    temps.length === 0
      ? null
      : (temps.filter(
          (r) => Math.abs((r.temperature as number) - targetTemp) <= 0.5,
        ).length /
          temps.length) *
        100;

  const humCenter = (humTurnMin + humTurnMax) / 2;
  const humStability =
    hums.length === 0
      ? null
      : (hums.filter(
          (r) => Math.abs((r.humidity as number) - humCenter) <= 3,
        ).length /
          hums.length) *
        100;

  // Count excursions — consecutive out-of-range readings are one excursion.
  let tempExcursions = 0;
  let longestMin = 0;
  let runStart: number | null = null;
  for (const r of temps) {
    const out = Math.abs((r.temperature as number) - targetTemp) > 0.5;
    const t = new Date(r.recorded_at).getTime();
    if (out) {
      if (runStart == null) {
        runStart = t;
        tempExcursions++;
      }
    } else {
      if (runStart != null) {
        const dur = Math.round((t - runStart) / 60000);
        if (dur > longestMin) longestMin = dur;
        runStart = null;
      }
    }
  }
  if (runStart != null && temps.length > 0) {
    const last = new Date(temps[temps.length - 1].recorded_at).getTime();
    const dur = Math.round((last - runStart) / 60000);
    if (dur > longestMin) longestMin = dur;
  }

  return {
    tempStability,
    humStability,
    tempExcursions,
    longestExcursionMin: longestMin,
  };
}

function computeStats(readings: Reading[]) {
  const temps = readings
    .map((r) => r.temperature)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const hums = readings
    .map((r) => r.humidity)
    .filter((v): v is number => v != null && Number.isFinite(v));

  const stats = (arr: number[]) =>
    arr.length === 0
      ? { min: null, max: null, avg: null }
      : {
          min: Math.min(...arr),
          max: Math.max(...arr),
          avg: arr.reduce((s, v) => s + v, 0) / arr.length,
        };

  const t = stats(temps);
  const h = stats(hums);
  return {
    tempMin: t.min,
    tempAvg: t.avg,
    tempMax: t.max,
    humMin: h.min,
    humAvg: h.avg,
    humMax: h.max,
  };
}
