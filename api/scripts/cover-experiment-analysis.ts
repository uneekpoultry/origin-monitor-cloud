/**
 * Nurture Right neoprene cover A/B analysis — daily report.
 *
 * Outputs markdown to stdout. Pipe to a date-stamped file:
 *   npx tsx scripts/cover-experiment-analysis.ts > cover_analysis_YYYY-MM-DD.md
 *
 * Compares stability of:
 *   - OL - Cover         (Nurture Right with neoprene cover) — TEST
 *   - OL - NR No Cover   (Nurture Right without cover) — CONTROL
 *
 * Context sensors:
 *   - OP- Room Ambient   (room temp, indoor)
 *   - OriginPro Outside  (outside, weather-exposed)
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const HATCH_START = new Date("2026-05-07T00:00:00Z");
const NOW = new Date();
const SETPOINT_C = 37.5;
const COLD_NIGHT_PERCENTILE = 0.2;

interface Row {
  sensor_id: string;
  recorded_at: string;
  temperature: number | null;
  humidity: number | null;
}

interface Stat {
  count: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  range: number;
}

function stats(values: number[]): Stat {
  if (values.length === 0)
    return { count: 0, mean: NaN, sd: NaN, min: NaN, max: NaN, range: NaN };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    mean,
    sd: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    range: Math.max(...values) - Math.min(...values),
  };
}

const fmt = (n: number, d = 2) => (Number.isNaN(n) ? "—" : n.toFixed(d));

(async () => {
  // Markdown header
  console.log(`# Nurture Right Cover — Daily Analysis`);
  console.log();
  console.log(
    `**Window:** ${HATCH_START.toISOString().slice(0, 10)} → ${NOW.toISOString().slice(0, 10)}`,
  );
  console.log(`**Setpoint (chicken):** ${SETPOINT_C}°C`);
  console.log(`**Generated:** ${NOW.toISOString()}`);
  console.log();
  console.log(`---`);
  console.log();

  // Resolve sensor IDs.
  const { data: sensors } = await sb
    .from("sensors")
    .select("id, name")
    .in("name", [
      "OL - Cover",
      "OL - NR No Cover",
      "OP- Room Ambient",
      "OriginPro Outside",
    ]);

  const byName = new Map<string, string>();
  for (const s of sensors ?? []) byName.set(s.name, s.id);

  const sensorOrder = [
    "OL - Cover",
    "OL - NR No Cover",
    "OP- Room Ambient",
    "OriginPro Outside",
  ];

  async function pullAll(sensorId: string): Promise<Row[]> {
    const all: Row[] = [];
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data } = await sb
        .from("sensor_readings")
        .select("sensor_id, recorded_at, temperature, humidity")
        .eq("sensor_id", sensorId)
        .gte("recorded_at", HATCH_START.toISOString())
        .order("recorded_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      all.push(...(data as Row[]));
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  const readingsBySensor = new Map<string, Row[]>();
  for (const name of sensorOrder) {
    const id = byName.get(name);
    if (!id) continue;
    readingsBySensor.set(name, await pullAll(id));
  }

  // 1. Overall stats
  console.log(`## 1. Overall temperature stats (full hatch window so far)`);
  console.log();
  console.log(
    `| Sensor | Count | Mean °C | SD | Min | Max | Range | vs Setpoint |`,
  );
  console.log(
    `|---|---:|---:|---:|---:|---:|---:|---:|`,
  );
  for (const name of sensorOrder) {
    const rows = readingsBySensor.get(name) ?? [];
    const temps = rows
      .map((r) => r.temperature)
      .filter((t): t is number => t !== null && Number.isFinite(t));
    const s = stats(temps);
    const isContext =
      name === "OP- Room Ambient" || name === "OriginPro Outside";
    const offset = isContext
      ? "(context)"
      : `${s.mean > SETPOINT_C ? "+" : "−"}${fmt(Math.abs(s.mean - SETPOINT_C))}°C`;
    console.log(
      `| ${name} | ${s.count} | ${fmt(s.mean)} | ${fmt(s.sd)} | ${fmt(s.min)} | ${fmt(s.max)} | ${fmt(s.range)} | ${offset} |`,
    );
  }
  console.log();

  // 2. Cold-night isolation
  const outsideRows = readingsBySensor.get("OriginPro Outside") ?? [];
  const hourlyOutside = new Map<string, number[]>();
  for (const r of outsideRows) {
    if (r.temperature == null) continue;
    const hourKey = r.recorded_at.slice(0, 13) + ":00";
    if (!hourlyOutside.has(hourKey)) hourlyOutside.set(hourKey, []);
    hourlyOutside.get(hourKey)!.push(r.temperature);
  }
  const hourlyMeans = Array.from(hourlyOutside.entries())
    .map(([h, t]) => ({ hour: h, mean: t.reduce((a, b) => a + b, 0) / t.length }))
    .sort((a, b) => a.mean - b.mean);
  const coldIdx = Math.floor(hourlyMeans.length * COLD_NIGHT_PERCENTILE);
  const coldHours = new Set(hourlyMeans.slice(0, coldIdx).map((h) => h.hour));

  function statsDuringCold(rows: Row[]): Stat {
    const temps = rows
      .filter((r) => coldHours.has(r.recorded_at.slice(0, 13) + ":00"))
      .map((r) => r.temperature)
      .filter((t): t is number => t !== null && Number.isFinite(t));
    return stats(temps);
  }

  console.log(`## 2. Cold-hour isolation`);
  console.log();
  console.log(
    `Coldest ${(COLD_NIGHT_PERCENTILE * 100).toFixed(0)}% of hourly windows: **${coldHours.size} hours**, with outside temp at or below **${fmt(hourlyMeans[coldIdx]?.mean ?? NaN, 1)}°C**.`,
  );
  console.log();
  console.log(`> ⚠️ **Caveat:** the "cold hours" set can be contaminated by the warm-up period on 7 May when both sensors were sitting in room-temp air during initial heat-up. The per-day breakdown below (§3) is the clean signal.`);
  console.log();
  console.log(`Stats during cold-hour windows only:`);
  console.log();
  console.log(`| Sensor | Count | Mean °C | SD | Min | Max | Range |`);
  console.log(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const name of sensorOrder) {
    const rows = readingsBySensor.get(name) ?? [];
    const s = statsDuringCold(rows);
    console.log(
      `| ${name} | ${s.count} | ${fmt(s.mean)} | ${fmt(s.sd)} | ${fmt(s.min)} | ${fmt(s.max)} | ${fmt(s.range)} |`,
    );
  }
  console.log();

  // 3. Per-day breakdown
  function dailyBucket(rows: Row[]): Map<string, number[]> {
    const m = new Map<string, number[]>();
    for (const r of rows) {
      if (r.temperature == null) continue;
      const day = r.recorded_at.slice(0, 10);
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(r.temperature);
    }
    return m;
  }

  const days = new Set<string>();
  const allDaily: Record<string, Map<string, number[]>> = {};
  for (const name of sensorOrder) {
    const m = dailyBucket(readingsBySensor.get(name) ?? []);
    allDaily[name] = m;
    for (const d of m.keys()) days.add(d);
  }
  const sortedDays = [...days].sort();

  console.log(`## 3. Per-day breakdown — temperature mean ±SD (°C)`);
  console.log();
  console.log(`| Date | OL - Cover | OL - NR No Cover | OP- Room Ambient | OriginPro Outside |`);
  console.log(`|---|---:|---:|---:|---:|`);
  for (const day of sortedDays) {
    const cells = sensorOrder.map((name) => {
      const temps = allDaily[name].get(day) ?? [];
      const s = stats(temps);
      return temps.length === 0 ? "—" : `${fmt(s.mean, 1)} ±${fmt(s.sd, 2)}`;
    });
    console.log(
      `| ${day} | ${cells[0]} | ${cells[1]} | ${cells[2]} | ${cells[3]} |`,
    );
  }
  console.log();

  // 4. Cover vs No-Cover (steady-state, by day)
  console.log(`## 4. Cover vs No-Cover, day-by-day (steady-state only — ${'>'}33°C readings)`);
  console.log();
  console.log(`Filtering each sensor's readings to >33°C excludes the warm-up period.`);
  console.log();
  console.log(`| Date | Cover SD | NoCover SD | Cover Δ vs setpoint | NoCover Δ vs setpoint | Cover stability win? |`);
  console.log(`|---|---:|---:|---:|---:|:---:|`);
  for (const day of sortedDays) {
    const coverTemps = (allDaily["OL - Cover"].get(day) ?? []).filter((t) => t > 33);
    const ncTemps = (allDaily["OL - NR No Cover"].get(day) ?? []).filter((t) => t > 33);
    if (coverTemps.length === 0 || ncTemps.length === 0) continue;
    const cs = stats(coverTemps);
    const ncs = stats(ncTemps);
    const win =
      cs.sd < ncs.sd ? "✓" : cs.sd > ncs.sd ? "✗" : "=";
    console.log(
      `| ${day} | ${fmt(cs.sd, 3)} | ${fmt(ncs.sd, 3)} | ${fmt(cs.mean - SETPOINT_C, 2)}°C | ${fmt(ncs.mean - SETPOINT_C, 2)}°C | ${win} |`,
    );
  }
  console.log();
  console.log(`Legend: ✓ = cover sensor had lower SD that day; ✗ = no-cover had lower SD; = tie.`);
  console.log();

  // 5. Quick summary
  console.log(`## 5. Quick summary`);
  console.log();
  let coverWins = 0;
  let ncWins = 0;
  let ties = 0;
  for (const day of sortedDays) {
    const coverTemps = (allDaily["OL - Cover"].get(day) ?? []).filter((t) => t > 33);
    const ncTemps = (allDaily["OL - NR No Cover"].get(day) ?? []).filter((t) => t > 33);
    if (coverTemps.length === 0 || ncTemps.length === 0) continue;
    const cs = stats(coverTemps);
    const ncs = stats(ncTemps);
    if (cs.sd < ncs.sd - 0.005) coverWins++;
    else if (cs.sd > ncs.sd + 0.005) ncWins++;
    else ties++;
  }
  console.log(`- Days where **Cover** had lower SD: **${coverWins}**`);
  console.log(`- Days where **No-Cover** had lower SD: **${ncWins}**`);
  console.log(`- Days tied (within 0.005°C SD): **${ties}**`);
  console.log();
  console.log(`---`);
  console.log();
  console.log(
    `*Generated by \`api/scripts/cover-experiment-analysis.ts\` at ${NOW.toISOString()}.*`,
  );
})();
