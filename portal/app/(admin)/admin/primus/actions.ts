"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";

function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

export async function registerPrimus(userId: string, name: string) {
  await requireAdmin();
  if (!userId) return { error: "User is required." };
  if (!name || name.trim().length === 0) {
    return { error: "Device name is required." };
  }

  const admin = createAdminClient();

  // Check user exists
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (!profile) return { error: "User not found." };

  const token = newToken();
  const { data, error } = await admin
    .from("primus_devices")
    .insert({
      user_id: userId,
      name: name.trim(),
      api_key_hash: sha256(token),
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  revalidatePath("/admin/primus");
  return {
    ok: true,
    deviceId: data.id,
    apiKey: token,
    message:
      "Copy this API key now — it won't be shown again. Paste it into the Primus device config.",
  };
}

export async function revokePrimus(deviceId: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from("primus_devices")
    .delete()
    .eq("id", deviceId);
  if (error) return { error: error.message };

  revalidatePath("/admin/primus");
  return { ok: true, message: "Device revoked." };
}

export async function rotatePrimusKey(deviceId: string) {
  await requireAdmin();
  const admin = createAdminClient();

  const token = newToken();
  const { error } = await admin
    .from("primus_devices")
    .update({ api_key_hash: sha256(token) })
    .eq("id", deviceId);

  if (error) return { error: error.message };

  revalidatePath("/admin/primus");
  return {
    ok: true,
    apiKey: token,
    message:
      "New key issued. The old key is now invalid. Copy this value now.",
  };
}

// Queue a resync command for a Primus. Next heartbeat, the device
// receives the command in its response and pulls the specified window
// (or its full sensor buffer if `since` is null) and uploads to
// /primus/readings. Cloud dedups on insert.
//
// Dual-write: also inserts sensor_resync_requests rows (reason='admin_manual')
// for each linked sensor, so the Origin Monitor app sees the request via
// Realtime and can take over if it's in BLE range and the Primus can't
// fulfil. params.resync_request_ids links the rows; when the Primus
// completes, all linked sensor_resync_requests rows get marked together.
export async function requestResync(
  deviceId: string,
  sinceIso: string | null,
) {
  const { user } = await requireAdmin();
  const admin = createAdminClient();

  // Verify the device exists so we don't create orphan commands.
  const { data: device } = await admin
    .from("primus_devices")
    .select("id, name, user_id")
    .eq("id", deviceId)
    .maybeSingle();
  if (!device) return { error: "Device not found." };

  // If a resync is already pending (undelivered), don't queue another —
  // the Primus will pick up the existing one on next heartbeat. Avoids
  // button-mash creating a pile-up.
  const { data: existing } = await admin
    .from("primus_commands")
    .select("id")
    .eq("primus_id", deviceId)
    .eq("type", "resync")
    .is("delivered_at", null)
    .maybeSingle();
  if (existing) {
    return {
      ok: true,
      message:
        "A resync is already queued for this device — it'll run on the next heartbeat.",
    };
  }

  // Find sensors linked to any active hatch for this user — these are
  // the sensors a manual resync is meaningful for. Same selection the
  // heartbeat handler uses for gap-fill verification.
  const { data: linkedSensors } = await admin
    .from("hatch_sensors")
    .select("sensor_id, hatch_logs!inner(status, user_id)")
    .eq("hatch_logs.user_id", device.user_id)
    .eq("hatch_logs.status", "active");
  const linkedSensorIds = Array.from(
    new Set((linkedSensors ?? []).map((l) => l.sensor_id)),
  );

  const nowIso = new Date().toISOString();
  const rangeStart = sinceIso ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Insert one sensor_resync_requests row per linked sensor that doesn't
  // already have an open request. Admin override is intentional — if
  // the auto-detect path queued one for this sensor 5 min ago and admin
  // is hitting the button manually, admin's intent is to refresh that
  // request, not stack on top. So we mark any existing open rows
  // cancelled with a clear reason before inserting the new ones.
  let createdReqIds: string[] = [];
  if (linkedSensorIds.length > 0) {
    await admin
      .from("sensor_resync_requests")
      .update({
        cancelled_at: nowIso,
        fulfilled_error: "superseded_by_admin_manual",
      })
      .in("sensor_id", linkedSensorIds)
      .is("claimed_at", null)
      .is("fulfilled_at", null)
      .is("cancelled_at", null);

    const reqRows = linkedSensorIds.map((sid) => ({
      sensor_id: sid,
      user_id: device.user_id,
      range_start: rangeStart,
      range_end: nowIso,
      reason: "admin_manual" as const,
      requested_by: user.id,
    }));
    const { data: insertedReqs } = await admin
      .from("sensor_resync_requests")
      .insert(reqRows)
      .select("id");
    createdReqIds = (insertedReqs ?? []).map((r) => r.id);
  }

  const params: Record<string, unknown> = {
    since: sinceIso,
    reason: "admin_manual",
    resync_request_ids: createdReqIds,
  };

  const { error } = await admin.from("primus_commands").insert({
    primus_id: deviceId,
    type: "resync",
    params,
    issued_by: user.id,
  });
  if (error) return { error: error.message };

  revalidatePath("/admin/primus");
  revalidatePath(`/admin/primus/${deviceId}/events`);
  return {
    ok: true,
    message: sinceIso
      ? `Resync queued from ${sinceIso}. Primus will run it on the next heartbeat (~60s). ${createdReqIds.length} sensor request(s) also visible to the app.`
      : `Resync queued (full sensor buffer). Primus will run it on the next heartbeat (~60s). ${createdReqIds.length} sensor request(s) also visible to the app.`,
  };
}
