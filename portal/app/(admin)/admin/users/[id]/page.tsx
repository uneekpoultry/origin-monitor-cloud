import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { UserActionsPanel } from "./user-actions-panel";
import { Timestamp } from "@/components/timestamp";

export const dynamic = "force-dynamic";

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = createAdminClient();

  const [{ data: authData }, { data: profile }, { data: sensors }, { data: hatches }, { data: primuses }] =
    await Promise.all([
      admin.auth.admin.getUserById(id),
      admin
        .from("profiles")
        .select("full_name, phone, country, is_admin, notification_email, notification_push, timezone, created_at")
        .eq("id", id)
        .maybeSingle(),
      admin
        .from("sensors")
        .select("id, serial_number, model, name, registered_at, last_seen, firmware_version")
        .eq("user_id", id)
        .order("registered_at", { ascending: false }),
      admin
        .from("hatch_logs")
        .select("id, name, species, status, start_date, expected_hatch_date, egg_count")
        .eq("user_id", id)
        .order("start_date", { ascending: false })
        .limit(10),
      admin
        .from("primus_devices")
        .select("id, name, last_seen, firmware_version, registered_at")
        .eq("user_id", id)
        .order("registered_at", { ascending: false }),
    ]);

  if (!authData.user) notFound();

  return (
    <div className="space-y-10">
      <div>
        <Link
          href="/admin/users"
          className="text-sm text-white/50 hover:text-white"
        >
          ← All users
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          {profile?.full_name || authData.user.email}
        </h1>
        <p className="mt-1 text-white/60">{authData.user.email}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title="Profile">
            <DefinitionList
              rows={[
                ["Email", authData.user.email ?? "—"],
                [
                  "Email confirmed",
                  authData.user.email_confirmed_at ? (
                    <Timestamp
                      iso={authData.user.email_confirmed_at}
                      tz={profile?.timezone}
                    />
                  ) : (
                    "— not confirmed —"
                  ),
                ],
                ["Full name", profile?.full_name || "—"],
                ["Phone", profile?.phone || "—"],
                ["Country", profile?.country || "—"],
                [
                  "Email notifications",
                  profile?.notification_email ? "On" : "Off",
                ],
                [
                  "Push notifications",
                  profile?.notification_push ? "On" : "Off",
                ],
                [
                  "Joined",
                  <Timestamp
                    iso={authData.user.created_at}
                    tz={profile?.timezone}
                  />,
                ],
                [
                  "Last sign-in",
                  authData.user.last_sign_in_at ? (
                    <Timestamp
                      iso={authData.user.last_sign_in_at}
                      tz={profile?.timezone}
                    />
                  ) : (
                    "Never"
                  ),
                ],
                ["Timezone", profile?.timezone || "—"],
                ["User ID", authData.user.id],
              ]}
            />
          </Section>

          <Section
            title={`Sensors (${sensors?.length ?? 0})`}
            empty={!sensors?.length ? "No sensors registered." : undefined}
          >
            {sensors && sensors.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-widest text-white/40">
                  <tr>
                    <th className="py-2">Serial</th>
                    <th className="py-2">Model</th>
                    <th className="py-2">Name</th>
                    <th className="py-2">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {sensors.map((s) => (
                    <tr key={s.id} className="border-t border-white/5">
                      <td className="py-2 font-mono text-xs">
                        {s.serial_number}
                      </td>
                      <td className="py-2">
                        {s.model === "pro" ? "Origin Pro" : "Origin Lite"}
                      </td>
                      <td className="py-2 text-white/70">{s.name || "—"}</td>
                      <td className="py-2 text-white/50">
                        {s.last_seen ? (
                          <Timestamp iso={s.last_seen} tz={profile?.timezone} />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section
            title={`Primus basestations (${primuses?.length ?? 0})`}
            empty={!primuses?.length ? "No Primus devices registered." : undefined}
          >
            {primuses && primuses.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-widest text-white/40">
                  <tr>
                    <th className="py-2">Name</th>
                    <th className="py-2">Firmware</th>
                    <th className="py-2">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {primuses.map((p) => (
                    <tr key={p.id} className="border-t border-white/5">
                      <td className="py-2">{p.name || "—"}</td>
                      <td className="py-2 text-white/70">
                        {p.firmware_version || "—"}
                      </td>
                      <td className="py-2 text-white/50">
                        {p.last_seen ? (
                          <Timestamp iso={p.last_seen} tz={profile?.timezone} />
                        ) : (
                          "Never"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section
            title={`Hatch logs (${hatches?.length ?? 0})`}
            empty={!hatches?.length ? "No hatch logs yet." : undefined}
          >
            {hatches && hatches.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-widest text-white/40">
                  <tr>
                    <th className="py-2">Name</th>
                    <th className="py-2">Species</th>
                    <th className="py-2">Eggs</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {hatches.map((h) => (
                    <tr key={h.id} className="border-t border-white/5">
                      <td className="py-2">{h.name}</td>
                      <td className="py-2 text-white/70">
                        {h.species || "—"}
                      </td>
                      <td className="py-2 text-white/70">
                        {h.egg_count ?? "—"}
                      </td>
                      <td className="py-2 text-white/70">{h.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>

        <div>
          <UserActionsPanel
            userId={authData.user.id}
            userEmail={authData.user.email ?? ""}
            isAdmin={profile?.is_admin ?? false}
            isEmailConfirmed={!!authData.user.email_confirmed_at}
          />
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  empty,
}: {
  title: string;
  children?: React.ReactNode;
  empty?: string;
}) {
  return (
    <div className="card">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-4">
        {empty ? (
          <p className="text-sm text-white/50">{empty}</p>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function DefinitionList({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[160px_1fr] gap-y-3 text-sm">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-white/50">{label}</dt>
          <dd className="break-words">{value || "—"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
