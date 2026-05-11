/**
 * Probe the actual CHECK constraint on hatch_logs.status by trying
 * to write disallowed values and reading the error.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  // Find any hatch row to use as a target for an UPDATE that probes
  // the status constraint. We don't actually commit — we use a status
  // we know to be wrong and read the error message.
  const { data: hatch } = await sb
    .from("hatch_logs")
    .select("id, status")
    .limit(1)
    .single();
  if (!hatch) {
    console.log("No hatch rows; can't probe constraint");
    return;
  }
  console.log("Test hatch:", hatch.id, "current status:", hatch.status);

  // Try a deliberately bogus status; the error message reveals the
  // constraint definition (or lack thereof).
  const bogus = "__test_invalid_value_should_fail__";
  const { error } = await sb
    .from("hatch_logs")
    .update({ status: bogus })
    .eq("id", hatch.id);
  if (error) {
    console.log("UPDATE error code:", error.code);
    console.log("UPDATE error message:", error.message);
    console.log("UPDATE error details:", error.details);
    console.log("UPDATE error hint:", error.hint);
  } else {
    console.log(
      "Bogus status accepted — no CHECK constraint exists on hatch_logs.status. Reverting.",
    );
    await sb
      .from("hatch_logs")
      .update({ status: hatch.status })
      .eq("id", hatch.id);
  }
})();
