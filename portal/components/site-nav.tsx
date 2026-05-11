import Link from "next/link";
import { Logo } from "./logo";

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-ink/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Logo />
        <nav className="hidden items-center gap-8 text-sm text-white/70 md:flex">
          <Link href="/#products" className="hover:text-white">
            Products
          </Link>
          <Link href="/#how-it-works" className="hover:text-white">
            How it works
          </Link>
          <Link href="/#pricing" className="hover:text-white">
            Pricing
          </Link>
          <Link href="/support" className="hover:text-white">
            Support
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-white/70 hover:text-white">
            Sign in
          </Link>
          <Link href="/signup" className="btn-primary">
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
