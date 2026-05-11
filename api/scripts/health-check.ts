/**
 * One-off cloud health check. Reads service-role creds from .env and
 * runs the diagnostic queries we'd otherwise run in the SQL editor.
 *
 * Run: npx tsx scripts/health-check.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY in env");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const now = new Date();
const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();

function fmtAge(iso: string | null): string {
  if (!iso) return "never";
  const ms = now.getTime() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ${m % 60}m ago`;
  return `${Math.round(m / 1440)}d ago`;
}

async function section(title: string, fn: () => Promise<void>) {
  console.log("\n" + "=".repeat(78));
  console.log("  " + title);
  console.log("=".repeat(78));
  try {
    await fn();
  } catch (e) {
    console.error("  ERROR:", e);
  }
}

(async () => {
  console.log(`Cloud health check — ${now.toISOString()}\n`);

  // 1. Sensors + freshness + 24h reading count
  await section("1. Sensor freshness + 24h reading count", async () => {
    const { data: sensors } = await supabase
      .from("sensors")
      .select("id, name, is_ambient, last_seen, claimed_at")
      .not("claimed_at", "is", null)
      .order("name");

    if (!sensors || sensors.length === 0) {
      console.log("  (no claimed sensors)");
      return;
    }

    for (const s of sensors) {
      const { count } = await supabase
        .from("sensor_readings")
        .select("id", { count: "exact", head: true })
        .eq("sensor_id", s.id)
        .gte("recorded_at", dayAgo);

      const expected = 1440; // 1/min
      const density = count != null ? Math.round((count / expected) * 100) : 0;
      const flag =
        density >= 95 ? "OK   " :
        density >= 70 ? "WARN " :
                        "GAP  ";

      console.log(
        `  ${flag} ${s.name.padEnd(20)} ${s.is_ambient ? "(amb)" : "     "} ` +
        `last_seen ${fmtAge(s.last_seen).padEnd(12)} ` +
        `${count ?? 0}/${expected} (${density}%)`,
      );
    }
  });

  // 2. Hourly density — find the actual gaps
  await section(
    "2. Hourly density (last 24h) — gap times by sensor",
    async () => {
      const { data: rows } = await supabase
        .from("sensor_readings")
        .select("sensor_id, recorded_at")
        .gte("recorded_at", dayAgo)
        .limit(50000);

      const { data: sensors } = await supabase
        .from("sensors")
        .select("id, name");
      const nameById = new Map(sensors?.map((s) => [s.id, s.name]) ?? []);

      // Bucket per sensor per hour
      const buckets = new Map<string, Map<string, number>>();
      for (const r of rows ?? []) {
        const hour = r.recorded_at.slice(0, 13) + ":00";
        const sname = nameById.get(r.sensor_id) ?? r.sensor_id;
        if (!buckets.has(sname)) buckets.set(sname, new Map());
        const b = buckets.get(sname)!;
        b.set(hour, (b.get(hour) ?? 0) + 1);
      }

      // For each sensor, list any hour with < 30 readings (half-density)
      let foundGap = false;
      for (const [sname, hours] of [...buckets.entries()].sort()) {
        const lowHours = [...hours.entries()]
          .filter(([, n]) => n < 30)
          .sort();
        if (lowHours.length === 0) continue;
        foundGap = true;
        console.log(`  ${sname}:`);
        for (const [h, n] of lowHours) {
          console.log(`    ${h}Z  ${n}/60 readings`);
        }
      }
      if (!foundGap) {
        console.log("  No hours with < 30 readings/hour. Density is healthy.");
      }
    },
  );

  // 3. sensor_resync_requests — last 24h
  await section(
    "3. Resync queue (last 24h) — open / failed / cancelled",
    async () => {
      const { data: reqs } = await supabase
        .from("sensor_resync_requests")
        .select(
          "id, sensor_id, requested_at, reason, claimed_by, fulfilled_at, fulfilled_count, fulfilled_error, cancelled_at, retry_count",
        )
        .gte("requested_at", dayAgo)
        .order("requested_at", { ascending: false });

      if (!reqs || reqs.length === 0) {
        console.log("  (no resync requests in last 24h)");
        return;
      }

      const { data: sensors } = await supabase
        .from("sensors")
        .select("id, name");
      const nameById = new Map(sensors?.map((s) => [s.id, s.name]) ?? []);

      let ok = 0, err = 0, cancelled = 0, inflight = 0, open = 0;
      for (const r of reqs) {
        let state = "OPEN";
        if (r.fulfilled_at && !r.fulfilled_error) { state = "OK"; ok++; }
        else if (r.fulfilled_error) { state = "ERROR"; err++; }
        else if (r.cancelled_at) { state = "CANCELLED"; cancelled++; }
        else if (r.claimed_by) { state = "IN_FLIGHT"; inflight++; }
        else open++;

        // Print non-OK rows (more interesting)
        if (state !== "OK") {
          console.log(
            `  ${state.padEnd(10)} ${fmtAge(r.requested_at).padEnd(10)} ` +
            `${(nameById.get(r.sensor_id) ?? "?").padEnd(20)} ` +
            `${r.reason.padEnd(20)} ` +
            `retry=${r.retry_count ?? 0} ` +
            `${r.fulfilled_error ? "err=" + r.fulfilled_error : ""}`,
          );
        }
      }
      console.log(
        `\n  Totals: OK=${ok}  ERROR=${err}  CANCELLED=${cancelled}  IN_FLIGHT=${inflight}  OPEN=${open}  (total=${reqs.length})`,
      );
    },
  );

  // 4. primus_events — recent warn / error
  await section("4. Primus events — last 24h, severity warn or error", async () => {
    const { data: events } = await supabase
      .from("primus_events")
      .select("observed_at, severity, source, message")
      .in("severity", ["warn", "error"])
      .gte("observed_at", dayAgo)
      .order("observed_at", { ascending: false })
      .limit(50);

    if (!events || events.length === 0) {
      console.log("  No warnings or errors in last 24h.");
      return;
    }
    for (const e of events) {
      console.log(
        `  ${fmtAge(e.observed_at).padEnd(10)} ${e.severity.padEnd(5)} ` +
        `${e.source.padEnd(20)} ${e.message.slice(0, 100)}`,
      );
    }
  });

  // 5. primus_devices heartbeat freshness
  await section("5. Primus heartbeat freshness", async () => {
    const { data: pds } = await supabase
      .from("primus_devices")
      .select("id, name, last_seen, firmware_version, wifi_ssid")
      .order("last_seen", { ascending: false, nullsFirst: false });

    if (!pds || pds.length === 0) {
      console.log("  (no Primus devices registered)");
      return;
    }
    for (const p of pds) {
      const age = p.last_seen
        ? (now.getTime() - new Date(p.last_seen).getTime()) / 60000
        : null;
      const flag = age == null ? "NEVER" : age < 2 ? "OK   " : age < 10 ? "WARN " : "DEAD ";
      console.log(
        `  ${flag} ${(p.name ?? "?").padEnd(25)} ` +
        `last_seen ${fmtAge(p.last_seen).padEnd(15)} ` +
        `fw=${p.firmware_version ?? "?"} ssid=${p.wifi_ssid ?? "?"}`,
      );
    }
  });

  // 6. Active hatches
  await section("6. Active hatches", async () => {
    const { data: hatches } = await supabase
      .from("hatch_logs")
      .select("id, name, species, start_date, expected_hatch_date, ambient_sensor_id, status")
      .eq("status", "active")
      .order("start_date", { ascending: false });

    if (!hatches || hatches.length === 0) {
      console.log("  (no active hatches)");
      return;
    }
    for (const h of hatches) {
      const { count: linkedCount } = await supabase
        .from("hatch_sensors")
        .select("sensor_id", { count: "exact", head: true })
        .eq("hatch_id", h.id);

      console.log(
        `  ${h.name.padEnd(30)} species=${h.species ?? "?"} ` +
        `started ${h.start_date} expected ${h.expected_hatch_date ?? "?"} ` +
        `${linkedCount ?? 0} incubator sensors${h.ambient_sensor_id ? " + ambient" : ""}`,
      );
    }
  });

  // 7. pg_cron — recent runs
  await section("7. pg_cron job runs (last hour, origin_*)", async () => {
    // Use the cron schema directly — service role can read it.
    const { data, error } = await supabase
      .schema("cron" as never)
      .from("job_run_details")
      .select("jobid, start_time, end_time, status, return_message")
      .gte("start_time", hourAgo)
      .order("start_time", { ascending: false })
      .limit(30);

    if (error) {
      console.log(`  (could not read cron.job_run_details: ${error.message})`);
      console.log("  Likely PostgREST schema not exposed — query manually if needed.");
      return;
    }
    if (!data || data.length === 0) {
      console.log("  (no cron runs in the last hour)");
      return;
    }
    const failed = data.filter((r) => r.status === "failed").length;
    const succeeded = data.filter((r) => r.status === "succeeded").length;
    console.log(`  Total runs (last 1h): ${data.length}  succeeded=${succeeded} failed=${failed}`);
    for (const r of data.slice(0, 10)) {
      console.log(
        `  ${fmtAge(r.start_time).padEnd(10)} jobid=${r.jobid} ` +
        `${r.status} ${r.return_message?.slice(0, 80) ?? ""}`,
      );
    }
  });

  // 8. Recent insert activity — sanity check
  await section("8. sensor_readings — last 5 min insert volume", async () => {
    const fiveMinAgo = new Date(now.getTime() - 5 * 60000).toISOString();
    const { count, data } = await supabase
      .from("sensor_readings")
      .select("sensor_id, recorded_at", { count: "exact" })
      .gte("recorded_at", fiveMinAgo)
      .order("recorded_at", { ascending: false })
      .limit(1000);

    if (!data) {
      console.log("  (no recent readings)");
      return;
    }
    const bySensor = new Map<string, number>();
    for (const r of data) {
      bySensor.set(r.sensor_id, (bySensor.get(r.sensor_id) ?? 0) + 1);
    }
    console.log(`  Total inserts last 5 min: ${count ?? 0}`);
    const { data: sensors } = await supabase
      .from("sensors")
      .select("id, name");
    const nameById = new Map(sensors?.map((s) => [s.id, s.name]) ?? []);
    for (const [sid, n] of [...bySensor.entries()].sort((a, b) =>
      (nameById.get(a[0]) ?? "").localeCompare(nameById.get(b[0]) ?? ""),
    )) {
      console.log(`    ${(nameById.get(sid) ?? sid).padEnd(20)} ${n} rows`);
    }
  });

  console.log("\nDone.");
})();
