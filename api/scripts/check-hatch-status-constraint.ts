import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  // Sample distinct status values currently in use.
  const { data, error } = await sb
    .from("hatch_logs")
    .select("status")
    .order("status");
  if (error) {
    console.log("Failed to read hatch_logs:", error.message);
    process.exit(1);
  }
  const distinct = new Set((data ?? []).map((r) => r.status as string));
  console.log("Distinct status values currently in use:", [...distinct]);
  console.log(`Total hatches: ${data?.length}`);
})();
