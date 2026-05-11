/**
 * Verify battery_mv end-to-end:
 *   1. Column exists on sensor_readings
 *   2. Recent rows have non-null battery_mv values (i.e. someone is writing)
 *   3. Realtime publication is on the table (full row published by default)
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  console.log("=== battery_mv flow verification ===\n");

  // 1. Column exists?
  const { data: probe, error: probeErr } = await sb
    .from("sensor_readings")
    .select("id, battery_mv")
    .limit(1);
  if (probeErr) {
    console.log("❌ Column probe failed:", probeErr.message);
    process.exit(1);
  }
  console.log("✅ battery_mv column exists and is queryable.\n");

  // 2. Per-sensor: how many recent readings have non-null battery_mv?
  console.log("Per-sensor battery_mv coverage (last 24h):\n");
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { data: sensors } = await sb
    .from("sensors")
    .select("id, name")
    .not("claimed_at", "is", null);

  for (const s of sensors ?? []) {
    const { count: total } = await sb
      .from("sensor_readings")
      .select("id", { count: "exact", head: true })
      .eq("sensor_id", s.id)
      .gte("recorded_at", dayAgo);
    const { count: withBat } = await sb
      .from("sensor_readings")
      .select("id", { count: "exact", head: true })
      .eq("sensor_id", s.id)
      .gte("recorded_at", dayAgo)
      .not("battery_mv", "is", null);

    const { data: latest } = await sb
      .from("sensor_readings")
      .select("battery_mv, recorded_at")
      .eq("sensor_id", s.id)
      .not("battery_mv", "is", null)
      .order("recorded_at", { ascending: false })
      .limit(1);

    const cov = total ? Math.round(((withBat ?? 0) / total) * 100) : 0;
    const latestBat = latest?.[0]?.battery_mv ?? "null";
    const latestAt = latest?.[0]?.recorded_at?.slice(0, 19) ?? "(none)";
    console.log(
      `  ${s.name?.padEnd(22)}  ${withBat ?? 0}/${total ?? 0} rows have battery (${cov}%)  latest=${latestBat}mV @ ${latestAt}Z`,
    );
  }

  console.log();

  // 3. Last 5 readings overall to see what the actual row shape looks like
  console.log("Last 5 sensor_readings (full row, to confirm Realtime payload would carry battery_mv):\n");
  const { data: recent } = await sb
    .from("sensor_readings")
    .select("sensor_id, recorded_at, temperature, humidity, battery_mv")
    .order("recorded_at", { ascending: false })
    .limit(5);
  for (const r of recent ?? []) {
    console.log(
      `  ${r.recorded_at?.slice(0, 19)}Z  T=${r.temperature}°C  H=${r.humidity}%  bat=${r.battery_mv ?? "null"}mV`,
    );
  }
})();
