import "server-only";
import { createClient } from "@supabase/supabase-js";

// Service-role client. Bypasses RLS. Only use in server components,
// route handlers, or server actions — NEVER import from client code.
export function createAdminClient() {
  const secretKey =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) env var is not set",
    );
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
