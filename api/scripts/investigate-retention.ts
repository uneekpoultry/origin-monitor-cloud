/**
 * Investigate why sensor_readings retention is short.
 * Checks:
 *  1. Earliest and latest reading per sensor (what range exists?)
 *  2. Total row count
 *  3. pg_cron jobs that might be purging
 *  4. Triggers on sensor_readings
 *  5. Row-level density across the past 30 days
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  console.log("=== sensor_readings retention investigation ===\n");

  // 1. Per-sensor earliest + latest readings
  console.log("1. Earliest + latest reading per sensor:\n");
  const { data: sensors } = await sb
    .from("sensors")
    .select("id, name")
    .not("claimed_at", "is", null);

  for (const s of sensors ?? []) {
    const { data: earliest } = await sb
      .from("sensor_readings")
      .select("recorded_at")
      .eq("sensor_id", s.id)
      .order("recorded_at", { ascending: true })
      .limit(1);
    const { data: latest } = await sb
      .from("sensor_readings")
      .select("recorded_at")
      .eq("sensor_id", s.id)
      .order("recorded_at", { ascending: false })
      .limit(1);

    const e = earliest?.[0]?.recorded_at;
    const l = latest?.[0]?.recorded_at;
    if (!e || !l) {
      console.log(`  ${s.name?.padEnd(20)}  (no readings)`);
      continue;
    }
    const spanDays = Math.round(
      (new Date(l).getTime() - new Date(e).getTime()) / 86_400_000,
    );
    console.log(
      `  ${s.name?.padEnd(20)}  earliest=${e.slice(0, 19)}Z   latest=${l.slice(0, 19)}Z   span=${spanDays}d`,
    );
  }

  // 2. Row count distribution by day, last 35 days
  console.log("\n2. Reading count per day (last 35 days, all sensors combined):\n");
  const days: { day: string; count: number }[] = [];
  for (let i = 0; i < 35; i++) {
    const day = new Date(Date.now() - i * 86_400_000);
    const dayStart = new Date(day.toISOString().slice(0, 10) + "T00:00:00Z");
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const { count } = await sb
      .from("sensor_readings")
      .select("id", { count: "exact", head: true })
      .gte("recorded_at", dayStart.toISOString())
      .lt("recorded_at", dayEnd.toISOString());
    days.push({ day: dayStart.toISOString().slice(0, 10), count: count ?? 0 });
  }
  for (const d of days) {
    const bar = "█".repeat(Math.min(50, Math.floor(d.count / 100)));
    console.log(`  ${d.day}  ${d.count.toString().padStart(6)} ${bar}`);
  }

  // 3. Try to read pg_cron jobs (might be schema-restricted; doesn't matter if it fails)
  console.log("\n3. pg_cron jobs (if accessible):\n");
  try {
    const { data: jobs, error } = await (
      sb.schema("cron" as never) as ReturnType<typeof sb.schema>
    )
      .from("job")
      .select("jobid, jobname, schedule, command, active");
    if (error) {
      console.log(`  (couldn't read cron schema: ${error.message})`);
    } else {
      for (const j of (jobs ?? []) as Array<{
        jobname: string;
        schedule: string;
        command: string;
        active: boolean;
      }>) {
        console.log(`  ${j.jobname}  ${j.schedule}  active=${j.active}`);
        console.log(`    command: ${(j.command ?? "").slice(0, 200)}`);
      }
    }
  } catch (e) {
    console.log("  (couldn't read cron schema:", (e as Error).message, ")");
  }

  console.log("\n=== Done ===");
})();
