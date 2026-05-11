/**
 * The CHECK constraint name is `hatch_logs_status_check` but the
 * definition isn't in any local migration. Probe by trying common
 * candidate values and seeing which ones the constraint accepts.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const candidates = [
  "active",
  "completed",
  "archived",
  "cancelled",
  "stopped",
  "ended",
  "failed",
  "aborted",
  "ended_early",
  "in_progress",
  "draft",
  "paused",
];

(async () => {
  const { data: hatch } = await sb
    .from("hatch_logs")
    .select("id, status")
    .limit(1)
    .single();
  if (!hatch) {
    console.log("No hatch rows");
    return;
  }
  const original = hatch.status as string;
  console.log("Probing CHECK constraint hatch_logs_status_check\n");

  for (const candidate of candidates) {
    const { error } = await sb
      .from("hatch_logs")
      .update({ status: candidate })
      .eq("id", hatch.id);
    if (error) {
      console.log(`  ❌ "${candidate}"`);
    } else {
      console.log(`  ✅ "${candidate}"`);
    }
  }

  // Restore.
  await sb
    .from("hatch_logs")
    .update({ status: original })
    .eq("id", hatch.id);
  console.log(`\nRestored status to "${original}"`);
})();
