/**
 * Two things in one run:
 *
 * 1. Battery snapshot — latest battery_mv per sensor + recent trend, so
 *    we can confirm whether the BC:57:29:05:D0:9E "low battery" warning
 *    was a glitch or real.
 *
 * 2. App-only resync experiment — queue fresh sensor_resync_requests
 *    rows targeting the specific gap window (28-Apr 23:00Z to 29-Apr
 *    07:00Z UTC, ~10pm to 5pm AWST overnight). DO NOT queue a
 *    primus_commands row, so only the App can claim during the first
 *    2-minute window before the cloud's opportunistic-backlog logic
 *    kicks in.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const now = new Date();
const fmtAge = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h${m % 60}m`;
  return `${Math.round(m / 1440)}d`;
};

(async () => {
  console.log(`Run @ ${now.toISOString()}\n`);

  // ============================================================
  // 1. BATTERY CHECK
  // ============================================================
  console.log("=".repeat(78));
  console.log("  Battery snapshot — latest reading per sensor");
  console.log("=".repeat(78));

  const { data: sensors } = await sb
    .from("sensors")
    .select("id, name, serial_number")
    .not("claimed_at", "is", null)
    .order("name");

  for (const s of sensors ?? []) {
    // Latest reading
    const { data: latest } = await sb
      .from("sensor_readings")
      .select("battery_mv, recorded_at")
      .eq("sensor_id", s.id)
      .not("battery_mv", "is", null)
      .order("recorded_at", { ascending: false })
      .limit(1);

    const r = latest?.[0];
    if (!r) {
      console.log(`  ${s.name.padEnd(20)} no battery readings ever`);
      continue;
    }

    // Min/max/avg battery in last 24h to spot trends
    const { data: recent } = await sb
      .from("sensor_readings")
      .select("battery_mv")
      .eq("sensor_id", s.id)
      .not("battery_mv", "is", null)
      .gte("recorded_at", new Date(now.getTime() - 24 * 3600_000).toISOString())
      .limit(5000);

    const vals = (recent ?? []).map((x) => x.battery_mv as number);
    const min = vals.length ? Math.min(...vals) : null;
    const max = vals.length ? Math.max(...vals) : null;
    const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;

    const flag =
      r.battery_mv == null ? "?" :
      r.battery_mv >= 2900 ? "OK  " :
      r.battery_mv >= 2700 ? "WARN" :
      "LOW ";

    console.log(
      `  ${flag} ${s.name.padEnd(20)} ${s.serial_number.padEnd(20)} ` +
      `now=${r.battery_mv}mV  ` +
      `24h: min=${min ?? "-"} avg=${avg ?? "-"} max=${max ?? "-"}  ` +
      `(${vals.length} samples)`,
    );
  }

  // ============================================================
  // 2. APP-ONLY RESYNC EXPERIMENT
  // ============================================================
  console.log("\n" + "=".repeat(78));
  console.log("  App-only resync experiment");
  console.log("=".repeat(78));

  // Find active hatch + its sensors
  const { data: hatch } = await sb
    .from("hatch_logs")
    .select("id, user_id, name, ambient_sensor_id")
    .eq("status", "active")
    .limit(1)
    .single();
  if (!hatch) {
    console.log("  No active hatch — aborting experiment");
    return;
  }

  const { data: links } = await sb
    .from("hatch_sensors")
    .select("sensor_id")
    .eq("hatch_id", hatch.id);
  const sensorIds = (links ?? []).map((l) => l.sensor_id);
  if (hatch.ambient_sensor_id) sensorIds.push(hatch.ambient_sensor_id);

  // Target the overnight gap window: 28-Apr 22:00Z to 29-Apr 06:00Z UTC
  // (= 06:00 AWST 28-Apr to 14:00 AWST 29-Apr — covers the outage hours
  // we care about)
  const rangeStart = "2026-04-28T22:00:00.000Z";
  const rangeEnd = "2026-04-29T06:00:00.000Z";

  console.log(`  Active hatch: ${hatch.name}`);
  console.log(`  Sensors: ${sensorIds.length}`);
  console.log(`  Range: ${rangeStart} → ${rangeEnd}`);
  console.log(
    `\n  Strategy: insert fresh sensor_resync_requests rows. NO primus_commands.\n` +
    `  Within ~5 sec the App should see the INSERT via Realtime and claim.\n` +
    `  After 2 minutes the cloud's opportunistic-backlog will pick up any\n` +
    `  unclaimed rows and queue a Primus command — but we WANT the App to win\n` +
    `  so we can compare what it pulls vs what the Primus pulled earlier.`,
  );

  // Insert one row per sensor
  const reqRows = sensorIds.map((sid) => ({
    sensor_id: sid,
    user_id: hatch.user_id,
    range_start: rangeStart,
    range_end: rangeEnd,
    reason: "admin_manual" as const,
  }));

  const { data: inserted, error: insErr } = await sb
    .from("sensor_resync_requests")
    .insert(reqRows)
    .select("id, sensor_id");

  if (insErr) {
    console.log(`\n  ERROR inserting requests: ${insErr.message}`);
    return;
  }

  console.log(`\n  Inserted ${inserted?.length ?? 0} fresh requests:`);
  for (const r of inserted ?? []) {
    const sname = sensors?.find((s) => s.id === r.sensor_id)?.name ?? r.sensor_id;
    console.log(`    ${r.id}  ${sname}`);
  }

  console.log(
    `\n  Now wait ~3 minutes, then re-run gap-fill-check.ts to see:\n` +
    `    - claimed_by: 'app:...' = App won; 'primus:...' = opportunistic backlog won\n` +
    `    - fulfilled_count: > 0 means actual readings backfilled\n` +
    `    - the gap-hour density should rise toward ~100% if the fulfill worked`,
  );
})();
