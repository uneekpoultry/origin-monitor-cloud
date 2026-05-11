import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  const target = process.argv[2] || "OriginPro Outside";
  const { data } = await sb
    .from("sensors")
    .select("name, settings, settings_updated_at")
    .eq("name", target)
    .single();
  console.log(`Sensor: ${data?.name}`);
  console.log(`settings_updated_at: ${data?.settings_updated_at}`);
  console.log(`settings:`);
  console.log(JSON.stringify(data?.settings, null, 2));
})();
