/**
 * Poll the experiment requests every 20s, print status changes.
 * Stops when all 4 are fulfilled/cancelled, or after 6 minutes.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const REQUEST_IDS = [
  "f1418f41-7e4a-4a71-994f-60af64c27f56",
  "7b4928f0-bc71-4d69-8add-c46cb00c626e",
  "fcb9c502-3846-4bba-8549-f6bf12a8dc22",
  "b8898f05-a7a8-49e2-9df5-2515626b3c7a",
];

async function check() {
  const { data: rows } = await sb
    .from("sensor_resync_requests")
    .select(
      "id, sensor_id, claimed_by, claimed_at, fulfilled_at, fulfilled_count, fulfilled_error, cancelled_at",
    )
    .in("id", REQUEST_IDS);

  const { data: sensors } = await sb.from("sensors").select("id, name");
  const nameById = new Map(sensors?.map((s) => [s.id, s.name]) ?? []);

  let settled = 0;
  console.log(`\n--- ${new Date().toISOString()} ---`);
  for (const r of rows ?? []) {
    const sname = nameById.get(r.sensor_id) ?? "?";
    let state = "OPEN";
    if (r.fulfilled_at && !r.fulfilled_error) state = "FULFILLED";
    else if (r.fulfilled_error) state = "ERR";
    else if (r.cancelled_at) state = "CANCELLED";
    else if (r.claimed_at) state = "CLAIMED";

    if (state !== "OPEN" && state !== "CLAIMED") settled++;

    const claim = r.claimed_by
      ? r.claimed_by.startsWith("app:") ? "app"
      : r.claimed_by.startsWith("primus:") ? "primus"
      : r.claimed_by.slice(0, 12)
      : "-";
    console.log(
      `  ${state.padEnd(10)} ${sname.padEnd(20)} claim=${claim.padEnd(8)} ` +
      `count=${r.fulfilled_count ?? "-"} err=${(r.fulfilled_error ?? "").slice(0, 50)}`,
    );
  }
  return settled;
}

(async () => {
  const startMs = Date.now();
  const MAX_WAIT_MS = 6 * 60 * 1000;
  const POLL_INTERVAL_MS = 20_000;

  while (Date.now() - startMs < MAX_WAIT_MS) {
    const settled = await check();
    if (settled === REQUEST_IDS.length) {
      console.log(`\nAll ${settled} requests settled.`);
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Final density check on the gap hours
  console.log("\n" + "=".repeat(78));
  console.log("  Density of target gap window after experiment");
  console.log("=".repeat(78));
  const gapHours = [
    "2026-04-28T22:00:00Z",
    "2026-04-28T23:00:00Z",
    "2026-04-29T00:00:00Z",
    "2026-04-29T01:00:00Z",
    "2026-04-29T02:00:00Z",
    "2026-04-29T03:00:00Z",
    "2026-04-29T04:00:00Z",
    "2026-04-29T05:00:00Z",
  ];
  const { data: sensors } = await sb.from("sensors").select("id, name");
  for (const hour of gapHours) {
    const start = new Date(hour);
    const end = new Date(start.getTime() + 3600_000);
    let total = 0;
    for (const s of sensors ?? []) {
      const { count } = await sb
        .from("sensor_readings")
        .select("id", { count: "exact", head: true })
        .eq("sensor_id", s.id)
        .gte("recorded_at", start.toISOString())
        .lt("recorded_at", end.toISOString());
      total += count ?? 0;
    }
    const expected = (sensors?.length ?? 0) * 60;
    console.log(`  ${hour}  ${total}/${expected} (${Math.round((total / expected) * 100)}%)`);
  }
})();
