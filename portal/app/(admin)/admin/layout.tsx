import Link from "next/link";
import { Logo } from "@/components/logo";
import { requireAdmin } from "@/lib/auth/require-admin";
import { SignOutButton } from "@/app/(app)/dashboard/sign-out-button";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requireAdmin();

  return (
    <div className="min-h-screen">
      <header className="border-b border-white/5">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Logo />
            <span className="rounded-full border border-light/30 bg-light/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-light">
              Admin
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/dashboard" className="text-white/60 hover:text-white">
              My dashboard
            </Link>
            <span className="text-white/60">{profile.full_name || user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl">
        <aside className="hidden w-56 shrink-0 border-r border-white/5 md:block">
          <nav className="sticky top-0 space-y-1 px-4 py-8 text-sm">
            <AdminNavLink href="/admin" label="Overview" />
            <AdminNavLink href="/admin/users" label="Users" />
            <AdminNavLink href="/admin/primus" label="Primus devices" />
          </nav>
        </aside>
        <main className="flex-1 px-6 py-8 md:px-10">{children}</main>
      </div>
    </div>
  );
}

function AdminNavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="block rounded-md px-3 py-2 text-white/70 transition hover:bg-white/5 hover:text-white"
    >
      {label}
    </Link>
  );
}
