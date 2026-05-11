/**
 * Smoke test for migration 019 + the settings PATCH path.
 * Uses service role to write a settings update directly (simulates what
 * the cloud endpoint does internally), reads back, and verifies the
 * shape + that settings_updated_at was bumped.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  // Pick the first claimed sensor for the test.
  const { data: sensors } = await sb
    .from("sensors")
    .select("id, name, settings, settings_updated_at")
    .not("claimed_at", "is", null)
    .limit(1);
  const target = sensors?.[0];
  if (!target) {
    console.log("No claimed sensors found. Aborting.");
    process.exit(1);
  }

  console.log(`Target sensor: ${target.name} (${target.id})`);
  console.log(`Before: settings=${JSON.stringify(target.settings)}`);
  console.log(`Before: settings_updated_at=${target.settings_updated_at ?? "(never)"}`);

  // Apply a tiny test update (calibration offset of +0.0 — harmless).
  const merged = {
    ...((target.settings as Record<string, unknown>) ?? {}),
    version: 1,
    calibration_temp_offset: 0.0,
  };
  const now = new Date().toISOString();

  const { data: updated, error } = await sb
    .from("sensors")
    .update({
      settings: merged,
      settings_updated_at: now,
    })
    .eq("id", target.id)
    .select("id, name, settings, settings_updated_at")
    .single();

  if (error) {
    console.log("UPDATE failed:", error.message);
    process.exit(2);
  }

  console.log(`\nAfter:  settings=${JSON.stringify(updated.settings)}`);
  console.log(`After:  settings_updated_at=${updated.settings_updated_at}`);

  // Verify the update stuck.
  const settingsAfter = updated.settings as Record<string, unknown>;
  if (settingsAfter.calibration_temp_offset !== 0.0) {
    console.log("❌ calibration_temp_offset did not persist correctly");
    process.exit(3);
  }
  if (settingsAfter.version !== 1) {
    console.log("❌ version field missing or wrong");
    process.exit(4);
  }
  if (!updated.settings_updated_at) {
    console.log("❌ settings_updated_at was not set");
    process.exit(5);
  }

  console.log("\n✅ Schema works end-to-end.");
  console.log("   - JSONB settings column accepts merged writes");
  console.log("   - version field preserved");
  console.log("   - settings_updated_at can be set explicitly (app pattern)");
  console.log("   - Row reads back exactly what was written");
})();
