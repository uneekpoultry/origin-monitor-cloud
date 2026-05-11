/**
 * Targeted check: is the App actually filling the gaps?
 *
 * Looks at:
 *  - sensor_resync_requests claimed_by patterns (app:* vs primus:*)
 *  - whether the historical gap hours have been backfilled since
 *  - any new reading inserts in the last 30 min that would indicate
 *    a successful gap-fill ran
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const now = new Date();
function fmtAge(iso: string | null): string {
  if (!iso) return "never";
  const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h${m % 60}m`;
  return `${Math.round(m / 1440)}d`;
}

(async () => {
  console.log(`Gap-fill check — ${now.toISOString()}\n`);

  // Sensor names
  const { data: sensors } = await supabase
    .from("sensors")
    .select("id, name");
  const nameById = new Map(sensors?.map((s) => [s.id, s.name]) ?? []);

  // 1. All resync requests last 48h, broken down by claimed_by source
  console.log("=".repeat(78));
  console.log("  1. Who's been claiming resync requests (last 48h)?");
  console.log("=".repeat(78));
  const dayAgo48 = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const { data: reqs } = await supabase
    .from("sensor_resync_requests")
    .select(
      "id, sensor_id, requested_at, reason, claimed_at, claimed_by, fulfilled_at, fulfilled_count, fulfilled_error, cancelled_at, retry_count",
    )
    .gte("requested_at", dayAgo48)
    .order("requested_at", { ascending: false });

  const claimSummary = new Map<string, { ok: number; err: number; total: number }>();
  for (const r of reqs ?? []) {
    let key = "unclaimed";
    if (r.claimed_by) {
      key = r.claimed_by.startsWith("app:")
        ? "app"
        : r.claimed_by.startsWith("primus:")
        ? "primus"
        : r.claimed_by;
    }
    const s = claimSummary.get(key) ?? { ok: 0, err: 0, total: 0 };
    s.total++;
    if (r.fulfilled_at && !r.fulfilled_error) s.ok++;
    if (r.fulfilled_error) s.err++;
    claimSummary.set(key, s);
  }
  console.log("  Summary:");
  for (const [k, v] of claimSummary) {
    console.log(`    ${k.padEnd(15)} total=${v.total}  fulfilled=${v.ok}  errored=${v.err}`);
  }

  console.log("\n  Detail (most recent first):");
  for (const r of (reqs ?? []).slice(0, 30)) {
    const sname = nameById.get(r.sensor_id) ?? r.sensor_id.slice(0, 8);
    const state = r.fulfilled_at && !r.fulfilled_error ? "OK"
      : r.fulfilled_error ? "ERR"
      : r.cancelled_at ? "CXL"
      : r.claimed_by ? "INF"
      : "OPN";
    const claim = r.claimed_by
      ? r.claimed_by.startsWith("app:") ? "app"
      : r.claimed_by.startsWith("primus:") ? "primus"
      : r.claimed_by.slice(0, 12)
      : "-";
    console.log(
      `  ${state.padEnd(3)} ${fmtAge(r.requested_at).padEnd(8)} ` +
      `${sname.padEnd(20)} ${r.reason.padEnd(20)} claim=${claim.padEnd(8)} ` +
      `count=${r.fulfilled_count ?? "-"} err=${(r.fulfilled_error ?? "").slice(0, 40)}`,
    );
  }

  // 2. For yesterday's worst gap hour (27 Apr 06:00Z), how many readings
  //    are now there? Compared to what we saw earlier (2 readings).
  console.log("\n" + "=".repeat(78));
  console.log("  2. Are the bad gap hours getting backfilled?");
  console.log("=".repeat(78));
  const gapHours = [
    "2026-04-27T06:00:00Z",
    "2026-04-27T23:00:00Z",
    "2026-04-28T00:00:00Z",
    "2026-04-28T02:00:00Z",
    "2026-04-28T05:00:00Z",
  ];
  for (const hourStart of gapHours) {
    const start = new Date(hourStart);
    const end = new Date(start.getTime() + 3600_000);
    const counts: Record<string, number> = {};
    for (const s of sensors ?? []) {
      const { count } = await supabase
        .from("sensor_readings")
        .select("id", { count: "exact", head: true })
        .eq("sensor_id", s.id)
        .gte("recorded_at", start.toISOString())
        .lt("recorded_at", end.toISOString());
      counts[s.name] = count ?? 0;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const expected = (sensors?.length ?? 0) * 60;
    const pct = expected > 0 ? Math.round((total / expected) * 100) : 0;
    console.log(`  ${hourStart}  total ${total}/${expected} (${pct}%)`);
    for (const [name, n] of Object.entries(counts)) {
      console.log(`     ${name.padEnd(20)} ${n}/60`);
    }
  }

  // 3. Latest reading per sensor — is everything currently fresh?
  console.log("\n" + "=".repeat(78));
  console.log("  3. Latest reading per sensor right now");
  console.log("=".repeat(78));
  for (const s of sensors ?? []) {
    const { data: latest } = await supabase
      .from("sensor_readings")
      .select("recorded_at, temperature, humidity")
      .eq("sensor_id", s.id)
      .order("recorded_at", { ascending: false })
      .limit(1);
    const r = latest?.[0];
    if (!r) {
      console.log(`  ${s.name.padEnd(20)} no readings ever`);
      continue;
    }
    console.log(
      `  ${s.name.padEnd(20)} ${fmtAge(r.recorded_at).padEnd(6)} ago  ` +
      `T=${r.temperature?.toFixed(2) ?? "?"}°C  H=${r.humidity?.toFixed(1) ?? "?"}%`,
    );
  }

  // 4. Insert volume in the last 30 min — is the cadence healthy now?
  console.log("\n" + "=".repeat(78));
  console.log("  4. Insert cadence in the last 30 min (per 5-min bucket)");
  console.log("=".repeat(78));
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60000);
  const { data: recent } = await supabase
    .from("sensor_readings")
    .select("sensor_id, recorded_at")
    .gte("recorded_at", thirtyMinAgo.toISOString())
    .order("recorded_at", { ascending: false })
    .limit(2000);
  const buckets = new Map<string, number>();
  for (const r of recent ?? []) {
    const t = new Date(r.recorded_at);
    const bucket = `${t.getUTCHours().toString().padStart(2, "0")}:${(Math.floor(t.getUTCMinutes() / 5) * 5).toString().padStart(2, "0")}`;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const sortedBuckets = [...buckets.entries()].sort();
  const expectedPerBucket = (sensors?.length ?? 0) * 5; // 4 sensors × 5 min
  for (const [b, n] of sortedBuckets) {
    const pct = Math.round((n / expectedPerBucket) * 100);
    const flag = pct >= 90 ? "OK  " : pct >= 50 ? "PARTIAL" : "GAP ";
    console.log(`  ${b}Z  ${flag.padEnd(8)} ${n}/${expectedPerBucket} (${pct}%)`);
  }

  console.log("\nDone.");
})();
