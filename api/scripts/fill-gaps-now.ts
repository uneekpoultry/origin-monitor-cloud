/**
 * Diagnose & fix: trigger a manual resync covering the last 36 hours
 * for all of Andrew's incubator-hatch sensors. Inserts both
 * sensor_resync_requests rows AND a primus_commands row so whichever
 * reader is around will fulfil it.
 *
 * Also reports the recent primus_commands history so we can see why
 * the previous gap-fill commands didn't run.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  // 1. Audit recent primus_commands for resync type
  console.log("=".repeat(78));
  console.log("  Recent resync primus_commands (last 48h)");
  console.log("=".repeat(78));
  const { data: cmds } = await sb
    .from("primus_commands")
    .select("id, type, params, created_at, delivered_at, completed_at, result, issued_by")
    .eq("type", "resync")
    .gte("created_at", new Date(Date.now() - 48 * 3600_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(20);
  const age = (d: string | null) =>
    d ? Math.round((Date.now() - new Date(d).getTime()) / 60000) + "m" : "-";
  for (const c of cmds ?? []) {
    const status = (c.result as { status?: string } | null)?.status ?? "-";
    const reason = (c.params as { reason?: string } | null)?.reason ?? "-";
    const issuedBy = c.issued_by ? "admin" : "auto";
    console.log(
      `  created=${age(c.created_at).padEnd(7)} delivered=${age(c.delivered_at).padEnd(7)} ` +
      `completed=${age(c.completed_at).padEnd(7)} status=${status.padEnd(8)} ` +
      `reason=${reason.padEnd(20)} ${issuedBy}`,
    );
  }

  // 2. Find the user, their primus device, and active-hatch sensors
  console.log("\n" + "=".repeat(78));
  console.log("  Finding active-hatch sensors to refill");
  console.log("=".repeat(78));
  const { data: hatch } = await sb
    .from("hatch_logs")
    .select("id, user_id, name, ambient_sensor_id")
    .eq("status", "active")
    .limit(1)
    .single();
  if (!hatch) {
    console.log("  No active hatch found — aborting");
    return;
  }
  console.log(`  Active hatch: ${hatch.name} (user_id=${hatch.user_id})`);

  const { data: links } = await sb
    .from("hatch_sensors")
    .select("sensor_id")
    .eq("hatch_id", hatch.id);
  const sensorIds = (links ?? []).map((l) => l.sensor_id);
  if (hatch.ambient_sensor_id) sensorIds.push(hatch.ambient_sensor_id);
  console.log(`  Sensors covered: ${sensorIds.length}`);

  const { data: sensors } = await sb
    .from("sensors")
    .select("id, name")
    .in("id", sensorIds);
  for (const s of sensors ?? []) console.log(`    - ${s.name}`);

  // 3. Find the user's Primus
  const { data: primus } = await sb
    .from("primus_devices")
    .select("id, name, last_seen")
    .eq("user_id", hatch.user_id)
    .order("last_seen", { ascending: false, nullsFirst: false })
    .limit(1)
    .single();
  if (!primus) {
    console.log("  No Primus for this user — aborting");
    return;
  }
  const primusAge = primus.last_seen
    ? Math.round((Date.now() - new Date(primus.last_seen).getTime()) / 60000)
    : null;
  console.log(`  Primus: ${primus.name} (heartbeat ${primusAge}m ago)`);

  // 4. Cancel any existing OPEN requests for these sensors (clean slate)
  console.log("\n" + "=".repeat(78));
  console.log("  Cancelling any existing open requests");
  console.log("=".repeat(78));
  const { data: cancelled } = await sb
    .from("sensor_resync_requests")
    .update({
      cancelled_at: new Date().toISOString(),
      fulfilled_error: "superseded_by_admin_manual_fill",
    })
    .in("sensor_id", sensorIds)
    .is("claimed_at", null)
    .is("fulfilled_at", null)
    .is("cancelled_at", null)
    .select("id");
  console.log(`  Cancelled ${cancelled?.length ?? 0} stale rows`);

  // 5. Insert fresh sensor_resync_requests covering 36h
  console.log("\n" + "=".repeat(78));
  console.log("  Queueing fresh resync requests (36h window)");
  console.log("=".repeat(78));
  const rangeEnd = new Date().toISOString();
  const rangeStart = new Date(Date.now() - 36 * 3600_000).toISOString();
  const reqRows = sensorIds.map((sid) => ({
    sensor_id: sid,
    user_id: hatch.user_id,
    range_start: rangeStart,
    range_end: rangeEnd,
    reason: "admin_manual" as const,
  }));
  const { data: inserted } = await sb
    .from("sensor_resync_requests")
    .insert(reqRows)
    .select("id, sensor_id");
  console.log(`  Inserted ${inserted?.length ?? 0} new rows`);

  // 6. Queue a primus_commands resync covering all of them
  console.log("\n" + "=".repeat(78));
  console.log("  Queueing primus_commands resync");
  console.log("=".repeat(78));
  const { error: cmdErr } = await sb.from("primus_commands").insert({
    primus_id: primus.id,
    type: "resync",
    params: {
      since: Math.floor(new Date(rangeStart).getTime() / 1000),
      auto: false,
      reason: "admin_manual_36h_fill",
      window_hours: 36,
      resync_request_ids: (inserted ?? []).map((r) => r.id),
    },
    issued_by: null,
  });
  if (cmdErr) {
    console.log(`  ERROR queueing primus_commands: ${cmdErr.message}`);
  } else {
    console.log(`  Primus will pick up command on next heartbeat (within ~60s)`);
    console.log(`  App will also see the requests via Realtime — whichever finishes first wins`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
