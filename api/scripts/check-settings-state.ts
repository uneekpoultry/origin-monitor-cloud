/**
 * Diagnostic: who has actually written settings to the cloud?
 * Tells us whether Primus, App, or neither has shipped the sync yet.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  console.log("=== Sensor settings state ===\n");

  const { data: sensors } = await sb
    .from("sensors")
    .select("id, name, settings, settings_updated_at, last_seen")
    .not("claimed_at", "is", null)
    .order("name");

  for (const s of sensors ?? []) {
    const settings = (s.settings as Record<string, unknown>) ?? {};
    const keys = Object.keys(settings).filter((k) => k !== "version");
    const fields = keys.length === 0 ? "(empty - only version)" : keys.join(", ");

    console.log(`  ${s.name?.padEnd(22) ?? "?"}`);
    console.log(`    settings keys: ${fields}`);
    console.log(`    settings_updated_at: ${s.settings_updated_at ?? "(never)"}`);
    if (settings.calibration_temp_offset !== undefined) {
      console.log(`    calibration_temp_offset: ${settings.calibration_temp_offset}`);
    }
    if (settings.alert_temp_high !== undefined) {
      console.log(`    alert_temp_high: ${settings.alert_temp_high}`);
    }
    console.log();
  }

  console.log("\n=== Primus device state ===\n");
  const { data: pds } = await sb
    .from("primus_devices")
    .select("name, last_seen, firmware_version, wifi_ssid")
    .order("last_seen", { ascending: false, nullsFirst: false });
  for (const p of pds ?? []) {
    console.log(`  ${p.name}`);
    console.log(`    last_seen: ${p.last_seen ?? "(never)"}`);
    console.log(`    firmware_version: ${p.firmware_version ?? "(not reported)"}`);
    console.log(`    wifi_ssid: ${p.wifi_ssid ?? "(unknown)"}`);
    console.log();
  }

  console.log("\n=== Recent primus_events (last 30 min, errors/warnings) ===\n");
  const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: events } = await sb
    .from("primus_events")
    .select("observed_at, severity, source, message")
    .gte("observed_at", thirtyMinAgo)
    .in("severity", ["warn", "error"])
    .order("observed_at", { ascending: false })
    .limit(20);
  if (!events?.length) {
    console.log("  (no warn/error events in last 30 min)");
  } else {
    for (const e of events) {
      const age = Math.round(
        (Date.now() - new Date(e.observed_at).getTime()) / 60_000,
      );
      console.log(`  ${age}m ago  ${e.severity}  ${e.source}: ${e.message}`);
    }
  }

  console.log("\n=== Diagnosis ===\n");
  const sensorsWithRealSettings = (sensors ?? []).filter((s) => {
    const settings = (s.settings as Record<string, unknown>) ?? {};
    return Object.keys(settings).filter((k) => k !== "version").length > 0;
  });
  const sensorsWithUpdatedAt = (sensors ?? []).filter(
    (s) => s.settings_updated_at !== null,
  );

  if (sensorsWithRealSettings.length === 0) {
    console.log(
      "  ❌ No sensor has any settings beyond `version`. Neither Primus nor App has written settings to the cloud.",
    );
    console.log(
      "     Either both sessions haven't shipped the sync yet, or they shipped but haven't tried writing.",
    );
  } else if (sensorsWithUpdatedAt.length === 0) {
    console.log(
      "  ⚠️  Settings exist but no settings_updated_at. Something wrote without stamping the timestamp — possibly the test smoke-write earlier.",
    );
  } else {
    console.log(
      `  ✅ ${sensorsWithRealSettings.length} sensors have settings, ${sensorsWithUpdatedAt.length} have settings_updated_at. Sync is happening from at least one side.`,
    );
  }
})();
