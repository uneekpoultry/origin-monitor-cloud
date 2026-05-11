import { createAdminClient } from "@/lib/supabase/admin";
import { PrimusPanel } from "./primus-panel";

export const dynamic = "force-dynamic";

export default async function PrimusAdminPage() {
  const admin = createAdminClient();

  const { data: devices } = await admin
    .from("primus_devices")
    .select("id, user_id, name, firmware_version, last_seen, registered_at")
    .order("registered_at", { ascending: false });

  // Look up user emails + names.
  const userIds = Array.from(new Set((devices ?? []).map((d) => d.user_id)));
  const [{ data: profiles }, authLists] = await Promise.all([
    admin.from("profiles").select("id, full_name").in("id", userIds),
    Promise.all(userIds.map((id) => admin.auth.admin.getUserById(id))),
  ]);

  const emailById = new Map<string, string>();
  authLists.forEach((r, i) => {
    emailById.set(userIds[i], r.data.user?.email ?? "—");
  });
  const profileById = new Map(profiles?.map((p) => [p.id, p]) ?? []);

  const deviceRows = (devices ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    user_id: d.user_id,
    firmware_version: d.firmware_version,
    last_seen: d.last_seen,
    registered_at: d.registered_at,
    user_label:
      profileById.get(d.user_id)?.full_name ||
      emailById.get(d.user_id) ||
      d.user_id,
  }));

  // All users, for the "register new" dropdown.
  const { data: allProfiles } = await admin
    .from("profiles")
    .select("id, full_name")
    .order("full_name", { ascending: true });

  const allAuthLists = await Promise.all(
    (allProfiles ?? []).map((p) => admin.auth.admin.getUserById(p.id)),
  );

  const userOptions = (allProfiles ?? []).map((p, i) => {
    const email = allAuthLists[i].data.user?.email ?? "";
    return {
      id: p.id,
      label: p.full_name ? `${p.full_name} — ${email}` : email || p.id,
    };
  });

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Primus devices</h1>
      <p className="mt-2 text-white/60">
        Register new basestations, rotate API keys, revoke devices.
      </p>
      <div className="mt-8">
        <PrimusPanel users={userOptions} devices={deviceRows} />
      </div>
    </div>
  );
}
