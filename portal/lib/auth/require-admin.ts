import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Gate for admin pages and server actions. Redirects to /login if signed
 * out, to /dashboard if signed in but not admin. Returns the authenticated
 * admin user on success.
 */
export async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin, full_name")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_admin) redirect("/dashboard");

  return { user, profile };
}
