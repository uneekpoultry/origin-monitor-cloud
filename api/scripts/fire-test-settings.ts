/**
 * Fire a distinctive test settings write to "OP - Room Ambient" via
 * service role. Marker: calibration_temp_offset = 0.7. Used to verify
 * whether Primus and/or App pick up settings changes from the cloud.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const TARGET_NAME = "OP- Room Ambient";
const MARKER_OFFSET = 0.7;

(async () => {
  console.log(`=== Firing test settings write ===\n`);
  console.log(`Target sensor name: ${TARGET_NAME}`);
  console.log(`Marker: calibration_temp_offset = ${MARKER_OFFSET}\n`);

  const { data: sensor, error: lookupErr } = await sb
    .from("sensors")
    .select("id, name, settings, settings_updated_at, last_seen, user_id")
    .eq("name", TARGET_NAME)
    .single();

  if (lookupErr || !sensor) {
    console.log(`❌ Sensor "${TARGET_NAME}" not found:`, lookupErr?.message);
    process.exit(1);
  }

  console.log(`Sensor id: ${sensor.id}`);
  console.log(`Last seen: ${sensor.last_seen}`);
  console.log(`Before — settings: ${JSON.stringify(sensor.settings)}`);
  console.log(`Before — settings_updated_at: ${sensor.settings_updated_at ?? "(never)"}\n`);

  const merged = {
    ...((sensor.settings as Record<string, unknown>) ?? {}),
    version: 1,
    calibration_temp_offset: MARKER_OFFSET,
  };
  const now = new Date().toISOString();

  const { data: updated, error: updateErr } = await sb
    .from("sensors")
    .update({
      settings: merged,
      settings_updated_at: now,
    })
    .eq("id", sensor.id)
    .select("id, name, settings, settings_updated_at")
    .single();

  if (updateErr) {
    console.log(`❌ UPDATE failed: ${updateErr.message}`);
    process.exit(2);
  }

  console.log(`✅ Wrote at ${now}`);
  console.log(`After — settings: ${JSON.stringify(updated.settings)}`);
  console.log(`After — settings_updated_at: ${updated.settings_updated_at}\n`);

  console.log("=== Now check both sides ===\n");
  console.log(`PRIMUS:`);
  console.log(`  - Within ~60s, the Primus's next /primus/sensors poll should fetch this.`);
  console.log(`  - If firmware sync is shipped: local sensor state for "${TARGET_NAME}"`);
  console.log(`    should show calibration_temp_offset = 0.7.`);
  console.log(`  - On the LCD's calibration screen for that sensor: "+0.7°C" offset visible.`);
  console.log();
  console.log(`APP:`);
  console.log(`  - Realtime sub on \`sensors\` should fire within seconds.`);
  console.log(`  - If app sync is shipped: sensor settings UI should show 0.7°C offset.`);
  console.log(`  - On the live readings: corrected = raw + 0.7°C visible.`);
  console.log();
  console.log(`If neither picks it up after ~2 minutes: both sides still need to ship.`);
  console.log(`If only one picks it up: the other side hasn't shipped yet.`);
})();
