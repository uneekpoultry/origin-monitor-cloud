"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function registerSensor(formData: {
  serial_number: string;
  model: "pro" | "lite";
  name?: string;
}) {
  const { supabase, user } = await requireUser();

  const serial = formData.serial_number.trim().toUpperCase();
  if (serial.length < 4) {
    return { error: "Serial number looks too short." };
  }
  if (!["pro", "lite"].includes(formData.model)) {
    return { error: "Model must be Pro or Lite." };
  }

  const { data, error } = await supabase
    .from("sensors")
    .insert({
      user_id: user.id,
      serial_number: serial,
      model: formData.model,
      name: formData.name?.trim() || null,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      return {
        error:
          "That serial number is already registered. If you believe it belongs to you, contact support.",
      };
    }
    return { error: error.message };
  }

  revalidatePath("/dashboard");
  return { ok: true, id: data.id };
}

export async function updateSensor(
  sensorId: string,
  updates: {
    name?: string;
    model?: "pro" | "lite";
    is_ambient?: boolean;
  },
) {
  const { supabase } = await requireUser();

  const patch: Record<string, unknown> = {};
  if (updates.name !== undefined) patch.name = updates.name.trim() || null;
  if (updates.model !== undefined) {
    if (!["pro", "lite"].includes(updates.model)) {
      return { error: "Model must be Pro or Lite." };
    }
    patch.model = updates.model;
  }
  if (updates.is_ambient !== undefined) patch.is_ambient = updates.is_ambient;

  const { error } = await supabase
    .from("sensors")
    .update(patch)
    .eq("id", sensorId);
  if (error) return { error: error.message };

  revalidatePath(`/dashboard/sensors/${sensorId}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Remove a sensor from the dashboard (soft). Readings history is preserved
 * and the sensor moves back to the "pending" state — if Primus still sees
 * it over BLE, it'll reappear in the detected-sensors list within ~60s so
 * the user can re-add it (e.g. after picking the wrong model).
 */
export async function unclaimSensor(sensorId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("sensors")
    .update({ claimed_at: null })
    .eq("id", sensorId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

/**
 * Permanently delete a sensor and all of its readings. Irreversible.
 * Use for sensors the customer no longer owns.
 */
export async function deleteSensor(sensorId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("sensors").delete().eq("id", sensorId);
  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function claimSensor(
  sensorId: string,
  details: { name?: string; model: "pro" | "lite" },
) {
  const { supabase } = await requireUser();
  if (!["pro", "lite"].includes(details.model)) {
    return { error: "Model must be Pro or Lite." };
  }

  const { error } = await supabase
    .from("sensors")
    .update({
      name: details.name?.trim() || null,
      model: details.model,
      claimed_at: new Date().toISOString(),
    })
    .eq("id", sensorId)
    .is("claimed_at", null); // only claim unclaimed ones

  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function dismissSensor(sensorId: string) {
  // "Dismiss" a pending sensor you don't recognise (neighbour's sensor, etc).
  // We only allow deleting unclaimed sensors this way — a claimed sensor
  // must go through the Unregister flow on its detail page.
  const { supabase } = await requireUser();
  const { error } = await supabase
    .from("sensors")
    .delete()
    .eq("id", sensorId)
    .is("claimed_at", null);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { ok: true };
}
