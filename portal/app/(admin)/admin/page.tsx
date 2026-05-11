import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Timestamp } from "@/components/timestamp";

export default async function AdminHomePage() {
  const admin = createAdminClient();

  const [
    { count: userCount },
    { count: sensorCount },
    { count: hatchCount },
    { count: primusCount },
    { count: readingCount },
  ] = await Promise.all([
    admin.from("profiles").select("*", { count: "exact", head: true }),
    admin.from("sensors").select("*", { count: "exact", head: true }),
    admin.from("hatch_logs").select("*", { count: "exact", head: true }),
    admin.from("primus_devices").select("*", { count: "exact", head: true }),
    admin.from("sensor_readings").select("*", { count: "exact", head: true }),
  ]);

  const { data: recentUsers } = await admin
    .from("profiles")
    .select("id, full_name, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  // Fetch email for each recent user via auth admin API.
  const recentWithEmails = await Promise.all(
    (recentUsers ?? []).map(async (u) => {
      const { data } = await admin.auth.admin.getUserById(u.id);
      return { ...u, email: data.user?.email ?? "—" };
    }),
  );

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
      <p className="mt-2 text-white/60">
        Live counts across the Origin Monitor platform.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Users" value={userCount ?? 0} href="/admin/users" />
        <Stat label="Sensors" value={sensorCount ?? 0} />
        <Stat label="Primus devices" value={primusCount ?? 0} href="/admin/primus" />
        <Stat label="Hatch logs" value={hatchCount ?? 0} />
        <Stat label="Sensor readings" value={readingCount ?? 0} />
      </div>

      <section className="mt-12">
        <h2 className="text-lg font-semibold">Newest signups</h2>
        {recentWithEmails.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">No signups yet.</p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-white/5">
            <table className="w-full text-sm">
              <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Joined</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {recentWithEmails.map((u) => (
                  <tr key={u.id} className="border-t border-white/5">
                    <td className="px-4 py-3">{u.full_name || "—"}</td>
                    <td className="px-4 py-3 text-white/70">{u.email}</td>
                    <td className="px-4 py-3 text-white/50">
                      <Timestamp iso={u.created_at} mode="date" />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/users/${u.id}`}
                        className="text-light hover:underline"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: number;
  href?: string;
}) {
  const inner = (
    <div className="card transition hover:border-light/30">
      <div className="text-xs font-semibold uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className="mt-2 text-4xl font-bold tabular-nums">
        {value.toLocaleString("en-AU")}
      </div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
