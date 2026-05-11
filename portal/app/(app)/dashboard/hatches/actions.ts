"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { addDays, speciesPreset } from "@/lib/hatches/species";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export type HatchMetadata = {
  breed?: string | null;
  egg_source?: "own_flock" | "purchased" | "shipped" | "other" | null;
  egg_source_detail?: string | null;
  incubator_model?: string | null;
  target_temp?: number | null;
  target_humid_turn_min?: number | null;
  target_humid_turn_max?: number | null;
  target_humid_lock_min?: number | null;
  target_humid_lock_max?: number | null;
};

export type CreateHatchInput = {
  name: string;
  species: string;
  egg_count: number;
  start_date: string; // yyyy-mm-dd
  sensor_ids?: string[];
  ambient_sensor_id?: string | null;
  notes?: string | null;
  expected_hatch_date?: string | null;
} & HatchMetadata;

export async function createHatch(input: CreateHatchInput) {
  const { supabase, user } = await requireUser();

  const name = input.name.trim();
  if (!name) return { error: "Name is required." };
  if (!input.start_date) return { error: "Start date is required." };
  if (!Number.isInteger(input.egg_count) || input.egg_count < 1) {
    return { error: "Egg count must be at least 1." };
  }

  const preset = speciesPreset(input.species);
  const expected =
    input.expected_hatch_date || addDays(input.start_date, preset.days);

  const { data, error } = await supabase
    .from("hatch_logs")
    .insert({
      user_id: user.id,
      name,
      species: input.species,
      egg_count: input.egg_count,
      start_date: input.start_date,
      expected_hatch_date: expected,
      notes: input.notes?.trim() || null,
      status: "active",
      breed: input.breed?.trim() || null,
      egg_source: input.egg_source ?? null,
      egg_source_detail: input.egg_source_detail?.trim() || null,
      incubator_model: input.incubator_model?.trim() || null,
      target_temp: input.target_temp ?? preset.targetTemp,
      target_humid_turn_min: input.target_humid_turn_min ?? preset.humTurnMin,
      target_humid_turn_max: input.target_humid_turn_max ?? preset.humTurnMax,
      target_humid_lock_min: input.target_humid_lock_min ?? preset.humLockMin,
      target_humid_lock_max: input.target_humid_lock_max ?? preset.humLockMax,
      ambient_sensor_id: input.ambient_sensor_id ?? null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };

  // Link any selected sensors.
  const sensorIds = (input.sensor_ids ?? []).filter(Boolean);
  if (sensorIds.length > 0) {
    const { error: linkErr } = await supabase
      .from("hatch_sensors")
      .insert(sensorIds.map((sid) => ({ hatch_id: data.id, sensor_id: sid })));
    if (linkErr) {
      console.warn("hatch sensor link failed:", linkErr.message);
    }
  }

  revalidatePath("/dashboard");
  return { ok: true, id: data.id };
}

export type UpdateHatchInput = {
  name?: string;
  species?: string;
  egg_count?: number;
  start_date?: string;
  expected_hatch_date?: string;
  sensor_ids?: string[]; // if provided, fully replaces the set of links
  ambient_sensor_id?: string | null;
  notes?: string | null;
  first_pip_at?: string | null;
  hatch_complete_at?: string | null;
  chick_assessment?: string | null;
} & HatchMetadata;

export async function updateHatch(id: string, input: UpdateHatchInput) {
  const { supabase } = await requireUser();

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.species !== undefined) patch.species = input.species;
  if (input.egg_count !== undefined) patch.egg_count = input.egg_count;
  if (input.start_date !== undefined) patch.start_date = input.start_date;
  if (input.expected_hatch_date !== undefined)
    patch.expected_hatch_date = input.expected_hatch_date;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  if (input.breed !== undefined) patch.breed = input.breed?.trim() || null;
  if (input.egg_source !== undefined) patch.egg_source = input.egg_source ?? null;
  if (input.egg_source_detail !== undefined)
    patch.egg_source_detail = input.egg_source_detail?.trim() || null;
  if (input.incubator_model !== undefined)
    patch.incubator_model = input.incubator_model?.trim() || null;
  if (input.target_temp !== undefined) patch.target_temp = input.target_temp;
  if (input.target_humid_turn_min !== undefined)
    patch.target_humid_turn_min = input.target_humid_turn_min;
  if (input.target_humid_turn_max !== undefined)
    patch.target_humid_turn_max = input.target_humid_turn_max;
  if (input.target_humid_lock_min !== undefined)
    patch.target_humid_lock_min = input.target_humid_lock_min;
  if (input.target_humid_lock_max !== undefined)
    patch.target_humid_lock_max = input.target_humid_lock_max;
  if (input.first_pip_at !== undefined) patch.first_pip_at = input.first_pip_at;
  if (input.hatch_complete_at !== undefined)
    patch.hatch_complete_at = input.hatch_complete_at;
  if (input.chick_assessment !== undefined)
    patch.chick_assessment = input.chick_assessment?.trim() || null;
  if (input.ambient_sensor_id !== undefined)
    patch.ambient_sensor_id = input.ambient_sensor_id;

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from("hatch_logs")
      .update(patch)
      .eq("id", id);
    if (error) return { error: error.message };
  }

  if (input.sensor_ids !== undefined) {
    // Fully replace the set of linked sensors.
    const { error: delErr } = await supabase
      .from("hatch_sensors")
      .delete()
      .eq("hatch_id", id);
    if (delErr) return { error: delErr.message };

    const newIds = input.sensor_ids.filter(Boolean);
    if (newIds.length > 0) {
      const { error: insErr } = await supabase
        .from("hatch_sensors")
        .insert(newIds.map((sid) => ({ hatch_id: id, sensor_id: sid })));
      if (insErr) return { error: insErr.message };
    }
  }

  revalidatePath(`/dashboard/hatches/${id}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

export type HatchResultsInput = {
  fertile_count?: number | null;
  hatched_count: number;
  died_in_shell?: number | null;
  pipped_not_hatched?: number | null;
  early_deaths?: number | null;
  first_pip_at?: string | null;
  hatch_complete_at?: string | null;
  chick_assessment?: string | null;
};

export async function recordHatchResults(
  id: string,
  input: HatchResultsInput,
) {
  const { supabase } = await requireUser();

  const nonNegInt = (v: number | null | undefined) =>
    v == null || (Number.isInteger(v) && v >= 0);

  if (!Number.isInteger(input.hatched_count) || input.hatched_count < 0) {
    return { error: "Hatched count must be 0 or greater." };
  }
  if (
    !nonNegInt(input.fertile_count) ||
    !nonNegInt(input.died_in_shell) ||
    !nonNegInt(input.pipped_not_hatched) ||
    !nonNegInt(input.early_deaths)
  ) {
    return { error: "All counts must be whole numbers, 0 or greater." };
  }

  // Fetch current status to decide whether to set actual_hatch_date
  const { data: current } = await supabase
    .from("hatch_logs")
    .select("status, actual_hatch_date")
    .eq("id", id)
    .maybeSingle();

  const patch: Record<string, unknown> = {
    status: "completed",
    hatched_count: input.hatched_count,
    fertile_count: input.fertile_count ?? null,
    died_in_shell: input.died_in_shell ?? null,
    pipped_not_hatched: input.pipped_not_hatched ?? null,
    early_deaths: input.early_deaths ?? null,
  };
  if (input.first_pip_at !== undefined)
    patch.first_pip_at = input.first_pip_at;
  if (input.hatch_complete_at !== undefined)
    patch.hatch_complete_at = input.hatch_complete_at;
  if (input.chick_assessment !== undefined)
    patch.chick_assessment = input.chick_assessment?.trim() || null;
  if (!current?.actual_hatch_date) {
    patch.actual_hatch_date = new Date().toISOString().substring(0, 10);
  }

  const { error } = await supabase
    .from("hatch_logs")
    .update(patch)
    .eq("id", id);

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/hatches/${id}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

// Deprecated shim — keeps older callers working. Prefer recordHatchResults.
export async function completeHatch(id: string, hatchedCount: number) {
  return recordHatchResults(id, { hatched_count: hatchedCount });
}

export async function failHatch(id: string, notes?: string) {
  const { supabase } = await requireUser();

  const patch: Record<string, unknown> = { status: "failed" };
  if (notes) patch.notes = notes;

  const { error } = await supabase
    .from("hatch_logs")
    .update(patch)
    .eq("id", id);

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/hatches/${id}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function reopenHatch(id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("hatch_logs")
    .update({
      status: "active",
      actual_hatch_date: null,
      hatched_count: null,
      fertile_count: null,
      died_in_shell: null,
      pipped_not_hatched: null,
      early_deaths: null,
    })
    .eq("id", id);

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/hatches/${id}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteHatch(id: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("hatch_logs").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

// ============================================================
// Milestones
// ============================================================

export type MilestoneType =
  | "daily_log"
  | "candling_1"
  | "candling_2"
  | "lockdown"
  | "observation"
  | "custom";

export type MilestoneInput = {
  hatch_id: string;
  milestone_type: MilestoneType;
  occurred_at?: string; // ISO
  day_number?: number | null;
  fertile_count?: number | null;
  removed_count?: number | null;
  eggs_remaining?: number | null;
  turning_count?: number | null;
  notes?: string | null;
};

export async function addMilestone(input: MilestoneInput) {
  const { supabase, user } = await requireUser();
  if (!input.hatch_id) return { error: "Missing hatch_id." };

  const { data, error } = await supabase
    .from("hatch_milestones")
    .insert({
      hatch_id: input.hatch_id,
      user_id: user.id,
      milestone_type: input.milestone_type,
      occurred_at: input.occurred_at || new Date().toISOString(),
      day_number: input.day_number ?? null,
      fertile_count: input.fertile_count ?? null,
      removed_count: input.removed_count ?? null,
      eggs_remaining: input.eggs_remaining ?? null,
      turning_count: input.turning_count ?? null,
      notes: input.notes?.trim() || null,
    })
    .select("id")
    .single();

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/hatches/${input.hatch_id}`);
  return { ok: true, id: data.id };
}

/**
 * Upsert a daily_log milestone for a given (hatch, day). One row per day.
 * Used by the inline Daily Log table's Save button.
 */
export async function upsertDailyLog(
  hatchId: string,
  day: number,
  fields: { turning_count?: number | null; notes?: string | null },
) {
  const { supabase, user } = await requireUser();

  // Check existing
  const { data: existing } = await supabase
    .from("hatch_milestones")
    .select("id")
    .eq("hatch_id", hatchId)
    .eq("milestone_type", "daily_log")
    .eq("day_number", day)
    .maybeSingle();

  const payload = {
    hatch_id: hatchId,
    user_id: user.id,
    milestone_type: "daily_log" as const,
    day_number: day,
    turning_count: fields.turning_count ?? null,
    notes: fields.notes?.trim() || null,
  };

  if (existing) {
    const { error } = await supabase
      .from("hatch_milestones")
      .update(payload)
      .eq("id", existing.id);
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase
      .from("hatch_milestones")
      .insert({ ...payload, occurred_at: new Date().toISOString() });
    if (error) return { error: error.message };
  }

  revalidatePath(`/dashboard/hatches/${hatchId}`);
  return { ok: true };
}

export async function deleteMilestone(id: string, hatchId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("hatch_milestones")
    .delete()
    .eq("id", id);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/hatches/${hatchId}`);
  return { ok: true };
}

// ============================================================
// Egg weights
// ============================================================

export type EggWeightInput = {
  hatch_id: string;
  weighed_at?: string;
  day_number?: number | null;
  weight_grams: number;
  stage?: "set" | "lockdown" | "other" | null;
  notes?: string | null;
};

export async function addEggWeight(input: EggWeightInput) {
  const { supabase, user } = await requireUser();
  if (!input.hatch_id) return { error: "Missing hatch_id." };
  if (!Number.isFinite(input.weight_grams) || input.weight_grams <= 0) {
    return { error: "Weight must be a positive number." };
  }
  const { data, error } = await supabase
    .from("egg_weights")
    .insert({
      hatch_id: input.hatch_id,
      user_id: user.id,
      weighed_at: input.weighed_at || new Date().toISOString(),
      day_number: input.day_number ?? null,
      weight_grams: input.weight_grams,
      stage: input.stage ?? null,
      notes: input.notes?.trim() || null,
    })
    .select("id")
    .single();
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/hatches/${input.hatch_id}`);
  return { ok: true, id: data.id };
}

export async function deleteEggWeight(id: string, hatchId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("egg_weights").delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/hatches/${hatchId}`);
  return { ok: true };
}

// ============================================================
// Email hatch report
// ============================================================

export async function emailHatchReport(hatchId: string) {
  const { supabase, user } = await requireUser();

  // Import server-only modules inside the function so this file is safe to
  // import from client component files that do `"use server"` directives.
  const { headers } = await import("next/headers");
  const { sendMail } = await import("@/lib/mailer");
  const { createAdminClient } = await import("@/lib/supabase/admin");

  // Fetch the hatch to verify ownership + get display info (RLS enforces user)
  const { data: hatch } = await supabase
    .from("hatch_logs")
    .select("id, name, start_date")
    .eq("id", hatchId)
    .maybeSingle();
  if (!hatch) return { error: "Hatch not found." };

  if (!user.email) return { error: "No email address on account." };

  // Rate limit: max 1 email per hatch per 10 minutes
  const admin = createAdminClient();
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("report_emails")
    .select("*", { count: "exact", head: true })
    .eq("hatch_id", hatchId)
    .gte("sent_at", tenMinAgo);
  if ((count ?? 0) > 0) {
    return {
      error: "Report already sent recently — try again in a few minutes.",
    };
  }

  // Generate the XLSX by calling our own download route with the user's cookies
  const cookieHeader = (await headers()).get("cookie") ?? "";
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://originmonitor.com";
  const xlsxRes = await fetch(
    `${origin}/dashboard/hatches/${hatchId}/download`,
    { headers: { cookie: cookieHeader }, cache: "no-store" },
  );
  if (!xlsxRes.ok) {
    return { error: `Failed to build report (${xlsxRes.status}).` };
  }
  const xlsxBuffer = Buffer.from(await xlsxRes.arrayBuffer());
  const safeName = (hatch.name || "hatch").replace(/[^a-zA-Z0-9-]+/g, "-");
  const filename = `${safeName}-${hatch.start_date}.xlsx`;

  // Load user profile for the email greeting
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .maybeSingle();

  // Build email and send via Resend
  const html = buildReportEmailHtml({
    hatchName: hatch.name,
    firstName: profile?.full_name?.split(" ")[0] || null,
  });
  const sendResult = await sendMail({
    to: user.email,
    subject: `Origin Monitor hatch report — ${hatch.name}`,
    html,
    attachments: [{ filename, content: xlsxBuffer }],
  });
  if ("error" in sendResult) {
    console.error("email send failed", sendResult.error);
    return { error: `Email failed: ${sendResult.error}` };
  }

  // Log to audit table
  await admin.from("report_emails").insert({
    user_id: user.id,
    hatch_id: hatchId,
    source: "web",
    email_address: user.email,
  });

  return { ok: true, message: `Sent to ${user.email}` };
}

function buildReportEmailHtml({
  hatchName,
  firstName,
}: {
  hatchName: string;
  firstName: string | null;
}): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0f0a;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6f4;padding:40px 12px;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(10,15,10,0.06);">
      <tr>
        <td style="background:#0a0f0a;padding:24px 32px;">
          <span style="display:inline-block;width:14px;height:14px;background:#c49a46;border-radius:3px;margin-right:10px;vertical-align:middle;"></span>
          <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:-0.2px;vertical-align:middle;">Origin <span style="color:#e5c880;">Monitor</span></span>
        </td>
      </tr>
      <tr>
        <td style="padding:40px 40px 8px 40px;">
          <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;font-weight:700;color:#0a0f0a;">Your hatch report</h1>
          <p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;color:#3a423a;">${firstName ? `Hi ${escapeHtml(firstName)},` : "Hi,"}</p>
          <p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;color:#3a423a;">
            Your latest report for <strong>${escapeHtml(hatchName)}</strong> is attached as a spreadsheet.
          </p>
          <p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;color:#3a423a;">
            Open the file for the full summary, daily log, raw readings and milestones — or head back to the dashboard to update results and get a fresh report.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:0 40px 32px 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:#c49a46;border-radius:8px;">
              <a href="https://originmonitor.com/dashboard" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#0a0f0a;text-decoration:none;">Open dashboard</a>
            </td>
          </tr></table>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 40px 32px 40px;border-top:1px solid #eef0ee;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#8a928a;">Origin Monitor · Uneek Poultry · Australia · <a href="https://originmonitor.com" style="color:#8a928a;">originmonitor.com</a></p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
