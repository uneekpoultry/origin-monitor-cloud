"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "@/components/logo";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  return (
    <div className="min-h-screen grain flex flex-col">
      <div className="mx-auto w-full max-w-6xl px-6 py-6">
        <Logo />
      </div>

      <div className="flex flex-1 items-center justify-center px-6 pb-20">
        <Suspense fallback={<div className="text-white/40">Loading…</div>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return setError(error.message);
    router.push(next);
    router.refresh();
  }

  async function handleMagicLink() {
    if (!email) return setError("Enter your email first.");
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    setLoading(false);
    if (error) return setError(error.message);
    setMagicSent(true);
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-white/60">
        New here?{" "}
        <Link href="/signup" className="text-light hover:underline">
          Create an account
        </Link>
        .
      </p>

      {magicSent ? (
        <div className="mt-8 card">
          <h2 className="font-semibold">Check your email</h2>
          <p className="mt-2 text-sm text-white/60">
            We sent a magic link to <strong>{email}</strong>. Click it to sign
            in.
          </p>
        </div>
      ) : (
        <form className="mt-8 space-y-4" onSubmit={handlePasswordSignIn}>
          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Email
            </label>
            <input
              type="email"
              autoComplete="email"
              required
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Password
            </label>
            <input
              type="password"
              autoComplete="current-password"
              required
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>

          <div className="relative my-4 text-center text-xs text-white/40">
            <span className="relative z-10 bg-ink px-3">or</span>
            <span className="absolute inset-x-0 top-1/2 -z-0 h-px bg-white/10" />
          </div>

          <button
            type="button"
            onClick={handleMagicLink}
            className="btn-ghost w-full"
            disabled={loading}
          >
            Email me a magic link
          </button>

          <p className="text-center text-xs text-white/50">
            <Link href="/forgot" className="hover:text-white">
              Forgot your password?
            </Link>
          </p>
        </form>
      )}
    </div>
  );
}
