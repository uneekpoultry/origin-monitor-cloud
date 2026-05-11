/**
 * Check whether hatch_logs.lockdown_date exists and is exposed via PostgREST.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  console.log("=== Probing hatch_logs.lockdown_date ===\n");

  // Try selecting the column. If it doesn't exist, PostgREST returns
  // a "column ... does not exist" error.
  const { error: selectErr } = await sb
    .from("hatch_logs")
    .select("id, lockdown_date")
    .limit(1);

  if (selectErr) {
    console.log("❌ SELECT lockdown_date failed:");
    console.log("   message:", selectErr.message);
    console.log("   code:", selectErr.code);
    console.log("\nLikely cause: column doesn't exist in the table.");
    console.log("Fix: run migration to ALTER TABLE hatch_logs ADD COLUMN lockdown_date date;");
    process.exit(1);
  }

  console.log("✅ SELECT lockdown_date succeeded — column is queryable via PostgREST.\n");

  // List what's actually in hatch_logs to be thorough.
  const { data: rows } = await sb
    .from("hatch_logs")
    .select("id, name, species, start_date, expected_hatch_date, lockdown_date, status")
    .order("start_date", { ascending: false })
    .limit(5);

  console.log("Recent hatches:");
  for (const r of rows ?? []) {
    console.log(
      `  ${r.name?.padEnd(20) ?? "?"}  species=${r.species ?? "?"}  ` +
      `start=${r.start_date}  expected=${r.expected_hatch_date}  lockdown=${r.lockdown_date ?? "(null)"}  status=${r.status}`,
    );
  }
})();
