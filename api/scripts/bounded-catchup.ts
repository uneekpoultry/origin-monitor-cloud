/**
 * Bounded catch-up: unstick the multi-day opportunistic resync that's
 * monopolising the Primus, then queue a tractable 12h window the
 * firmware can actually finish in one BLE session.
 *
 * Why bounded: the stalled command covers the entire multi-day outage.
 * The KBeacon sensors only hold a finite on-device ring buffer — the
 * deepest part of that gap was overwritten days ago and is
 * unrecoverable. A 12h window (~144 readings @5-min sensor resolution)
 * is well within one drain and recovers everything the buffers still
 * hold.
 *
 * Steps:
 *   1. Find the stalled open opportunistic resync command. If it's
 *      delivered and clearly past draining (no result, old), mark it
 *      completed as superseded — equivalent to the natural 60-min
 *      command-timeout cascade, just admin-initiated and clean — and
 *      cascade its linked requests to cancelled+error so the retry
 *      sweep and dedup guard see a terminal state.
 *   2. Cancel any other open/errored unclaimed requests for the
 *      active-hatch sensors (clean slate, no pile-up).
 *   3. Insert fresh 12h sensor_resync_requests (reason admin_manual).
 *   4. Queue ONE bounded primus_commands resync linked to them.
 *
 * Both readers can fulfil it: Primus on its next heartbeat, App via
 * Realtime — whichever finishes first. fine_status wiring (deployed)
 * will categorise the outcome honestly.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const WINDOW_HOURS = 12;
const STALLED_MIN_DELIVERED_MIN = 30; // an open delivered cmd older than this is stalled

const nowMs = Date.now();
const ageMin = (d: string | null) =>
  d ? Math.round((nowMs - new Date(d).getTime()) / 60000) : null;

async function main() {
  const { data: hatch } = await sb
    .from("hatch_logs")
    .select("id, user_id, name, ambient_sensor_id")
    .eq("status", "active")
    .limit(1)
    .single();
  if (!hatch) {
    console.log("No active hatch — aborting.");
    return;
  }
  const { data: links } = await sb
    .from("hatch_sensors")
    .select("sensor_id")
    .eq("hatch_id", hatch.id);
  const sensorIds = [...new Set((links ?? []).map((l) => l.sensor_id))];
  if (hatch.ambient_sensor_id) sensorIds.push(hatch.ambient_sensor_id);
  const { data: sensors } = await sb
    .from("sensors")
    .select("id, name")
    .in("id", sensorIds);
  const nm = new Map((sensors ?? []).map((s) => [s.id, s.name]));
  console.log(`Active hatch: ${hatch.name}`);
  console.log(`Sensors: ${sensorIds.map((i) => nm.get(i) ?? i).join(", ")}\n`);

  const { data: primus } = await sb
    .from("primus_devices")
    .select("id, name, last_seen")
    .eq("user_id", hatch.user_id)
    .order("last_seen", { ascending: false, nullsFirst: false })
    .limit(1)
    .single();
  if (!primus) {
    console.log("No Primus for user — aborting.");
    return;
  }
  console.log(
    `Primus: ${primus.name} (heartbeat ${ageMin(primus.last_seen)}m ago)\n`,
  );

  // ── 1. Unstick the stalled opportunistic command ───────────────────
  const { data: openCmds } = await sb
    .from("primus_commands")
    .select("id, params, delivered_at, created_at, completed_at, result")
    .eq("primus_id", primus.id)
    .eq("type", "resync")
    .is("completed_at", null);

  console.log("=".repeat(72));
  console.log(`  Step 1 — stalled open resync commands: ${openCmds?.length ?? 0}`);
  console.log("=".repeat(72));
  for (const c of openCmds ?? []) {
    const dMin = ageMin(c.delivered_at);
    const p = c.params as { reason?: string; resync_request_ids?: string[] };
    console.log(
      `  cmd=${c.id} reason=${p?.reason ?? "-"} created ${ageMin(c.created_at)}m ago delivered ${dMin ?? "-"}m ago linked=${p?.resync_request_ids?.length ?? 0}`,
    );
    const stalled =
      c.delivered_at != null &&
      (dMin ?? 0) >= STALLED_MIN_DELIVERED_MIN;
    if (!stalled) {
      console.log("    -> not stalled yet, leaving as-is");
      continue;
    }
    await sb
      .from("primus_commands")
      .update({
        completed_at: new Date().toISOString(),
        result: {
          status: "timeout",
          error: "superseded_admin_bounded_catchup",
        },
      })
      .eq("id", c.id);
    const linked = p?.resync_request_ids ?? [];
    if (linked.length > 0) {
      await sb
        .from("sensor_resync_requests")
        .update({
          cancelled_at: new Date().toISOString(),
          fulfilled_error: "superseded_admin_bounded_catchup",
        })
        .in("id", linked)
        .is("fulfilled_at", null)
        .is("cancelled_at", null);
    }
    console.log(
      `    -> marked completed (superseded) + cascaded ${linked.length} linked request(s)`,
    );
  }
  console.log();

  // ── 2. Clean slate: cancel other open/errored unclaimed requests ───
  const { data: cancelled } = await sb
    .from("sensor_resync_requests")
    .update({
      cancelled_at: new Date().toISOString(),
      fulfilled_error: "superseded_by_bounded_catchup",
    })
    .in("sensor_id", sensorIds)
    .is("claimed_at", null)
    .is("fulfilled_at", null)
    .is("cancelled_at", null)
    .select("id");
  console.log("=".repeat(72));
  console.log(`  Step 2 — cancelled ${cancelled?.length ?? 0} stale unclaimed request(s)`);
  console.log("=".repeat(72) + "\n");

  // ── 3. Fresh bounded requests ──────────────────────────────────────
  const rangeEnd = new Date(nowMs).toISOString();
  const rangeStart = new Date(nowMs - WINDOW_HOURS * 3600_000).toISOString();
  const { data: inserted } = await sb
    .from("sensor_resync_requests")
    .insert(
      sensorIds.map((sid) => ({
        sensor_id: sid,
        user_id: hatch.user_id,
        range_start: rangeStart,
        range_end: rangeEnd,
        reason: "admin_manual" as const,
      })),
    )
    .select("id, sensor_id");
  console.log("=".repeat(72));
  console.log(
    `  Step 3 — queued ${inserted?.length ?? 0} fresh ${WINDOW_HOURS}h request(s)`,
  );
  console.log(`  window: ${rangeStart}  →  ${rangeEnd}`);
  console.log("=".repeat(72) + "\n");

  // ── 4. One bounded primus_commands resync ──────────────────────────
  const { error: cmdErr } = await sb.from("primus_commands").insert({
    primus_id: primus.id,
    type: "resync",
    params: {
      since: Math.floor(new Date(rangeStart).getTime() / 1000),
      auto: false,
      reason: "admin_bounded_catchup",
      window_hours: WINDOW_HOURS,
      resync_request_ids: (inserted ?? []).map((r) => r.id),
    },
    issued_by: null,
  });
  console.log("=".repeat(72));
  if (cmdErr) {
    console.log(`  Step 4 — ERROR queueing command: ${cmdErr.message}`);
  } else {
    console.log(
      `  Step 4 — bounded ${WINDOW_HOURS}h resync command queued.`,
    );
    console.log("  Primus picks it up next heartbeat (~10 min cadence);");
    console.log("  App can also fulfil it via Realtime. fine_status will");
    console.log("  report the outcome honestly; the breaker arbitrates.");
  }
  console.log("=".repeat(72));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
