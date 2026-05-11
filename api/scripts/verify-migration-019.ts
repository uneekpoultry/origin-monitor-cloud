/**
 * Quick verifier — confirms migration 019 has been applied by checking
 * that `settings` and `settings_updated_at` columns are queryable on
 * `public.sensors`. Run AFTER pasting 019_sensor_settings.sql into the
 * Supabase SQL editor.
 *
 * Run: npx tsx scripts/verify-migration-019.ts
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  const { data, error } = await sb
    .from("sensors")
    .select("id, name, settings, settings_updated_at")
    .order("registered_at", { ascending: true });

  if (error) {
    console.log("❌ Verification FAILED:", error.message);
    console.log(
      "Migration 019 has NOT been applied. Paste 019_sensor_settings.sql into Supabase SQL Editor first.",
    );
    process.exit(2);
  }

  console.log(`✅ Migration 019 applied. ${data?.length ?? 0} sensors visible.\n`);
  for (const s of data ?? []) {
    const settingsKeys = Object.keys((s.settings as Record<string, unknown>) ?? {});
    console.log(
      `  ${s.name?.padEnd(20) ?? "?"}  settings={${settingsKeys.join(", ")}}  ` +
        `updated_at=${s.settings_updated_at ?? "(never)"}`,
    );
  }
})();
