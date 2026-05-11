import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Timestamp } from "@/components/timestamp";

export const dynamic = "force-dynamic";

type SearchParams = { q?: string; page?: string };

export default async function UsersListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { q = "", page: pageStr = "1" } = await searchParams;
  const page = Math.max(1, parseInt(pageStr, 10) || 1);
  const perPage = 25;

  const admin = createAdminClient();

  // Supabase's auth admin listUsers is the source of truth for emails.
  const { data: authData } = await admin.auth.admin.listUsers({
    page,
    perPage,
  });

  const authUsers = authData.users ?? [];
  const filtered = q
    ? authUsers.filter(
        (u) =>
          u.email?.toLowerCase().includes(q.toLowerCase()) ||
          u.id.toLowerCase().includes(q.toLowerCase()),
      )
    : authUsers;

  // Join with profile data for full_name, is_admin.
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, full_name, is_admin")
    .in(
      "id",
      filtered.map((u) => u.id),
    );

  const profileMap = new Map(profiles?.map((p) => [p.id, p]) ?? []);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="mt-2 text-white/60">
            All Origin Monitor accounts. Click a user to manage them.
          </p>
        </div>
      </div>

      <form className="mt-6 flex gap-2" action="/admin/users">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search by email or user ID…"
          className="input flex-1 max-w-md"
        />
        <button type="submit" className="btn-primary">
          Search
        </button>
        {q && (
          <Link href="/admin/users" className="btn-ghost">
            Clear
          </Link>
        )}
      </form>

      <div className="mt-6 overflow-hidden rounded-xl border border-white/5">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
            <tr>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Joined</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-white/50">
                  No users match.
                </td>
              </tr>
            ) : (
              filtered.map((u) => {
                const p = profileMap.get(u.id);
                return (
                  <tr
                    key={u.id}
                    className="border-t border-white/5 hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3 font-medium">{u.email}</td>
                    <td className="px-4 py-3 text-white/70">
                      {p?.full_name || "—"}
                    </td>
                    <td className="px-4 py-3 text-white/50">
                      <Timestamp iso={u.created_at} mode="date" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {p?.is_admin && (
                          <Badge tone="admin">Admin</Badge>
                        )}
                        {!u.email_confirmed_at && (
                          <Badge tone="warn">Unconfirmed</Badge>
                        )}
                        {u.banned_until && (
                          <Badge tone="danger">Banned</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/users/${u.id}`}
                        className="text-light hover:underline"
                      >
                        Manage →
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-white/50">
        <span>
          Showing {filtered.length} user{filtered.length === 1 ? "" : "s"}
          {q && ` matching "${q}"`}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Link
              href={`/admin/users?q=${encodeURIComponent(q)}&page=${page - 1}`}
              className="btn-ghost"
            >
              ← Previous
            </Link>
          )}
          {authUsers.length === perPage && (
            <Link
              href={`/admin/users?q=${encodeURIComponent(q)}&page=${page + 1}`}
              className="btn-ghost"
            >
              Next →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "admin" | "warn" | "danger";
}) {
  const styles = {
    admin: "border-light/30 bg-light/10 text-light",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    danger: "border-red-500/30 bg-red-500/10 text-red-300",
  } as const;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${styles[tone]}`}
    >
      {children}
    </span>
  );
}
