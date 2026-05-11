"use client";

import Link from "next/link";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const browserTz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, timezone: browserTz },
        emailRedirectTo: `${location.origin}/auth/callback?next=/dashboard`,
      },
    });
    setLoading(false);
    if (error) return setError(error.message);
    setSent(true);
  }

  return (
    <div className="min-h-screen grain flex flex-col">
      <div className="mx-auto w-full max-w-6xl px-6 py-6">
        <Logo />
      </div>

      <div className="flex flex-1 items-center justify-center px-6 pb-20">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-bold tracking-tight">
            Create your account
          </h1>
          <p className="mt-2 text-sm text-white/60">
            Already have one?{" "}
            <Link href="/login" className="text-light hover:underline">
              Sign in
            </Link>
            .
          </p>

          {sent ? (
            <div className="mt-8 card">
              <h2 className="font-semibold">Confirm your email</h2>
              <p className="mt-2 text-sm text-white/60">
                We sent a confirmation link to <strong>{email}</strong>. Click
                it to activate your account.
              </p>
            </div>
          ) : (
            <form className="mt-8 space-y-4" onSubmit={handleSignup}>
              <div>
                <label className="mb-1 block text-xs font-medium text-white/70">
                  Full name
                </label>
                <input
                  type="text"
                  required
                  className="input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>
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
                  autoComplete="new-password"
                  required
                  minLength={8}
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="mt-1 text-xs text-white/40">
                  At least 8 characters.
                </p>
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <button
                type="submit"
                className="btn-primary w-full"
                disabled={loading}
              >
                {loading ? "Creating account…" : "Create account"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
