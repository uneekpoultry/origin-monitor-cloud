"use client";

import Link from "next/link";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/auth/callback?next=/reset-password`,
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
          <h1 className="text-2xl font-bold tracking-tight">Reset password</h1>
          <p className="mt-2 text-sm text-white/60">
            Enter your email and we'll send a reset link.
          </p>

          {sent ? (
            <div className="mt-8 card">
              <h2 className="font-semibold">Check your email</h2>
              <p className="mt-2 text-sm text-white/60">
                Reset link sent to <strong>{email}</strong>.
              </p>
            </div>
          ) : (
            <form className="mt-8 space-y-4" onSubmit={handleReset}>
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
              {error && <p className="text-sm text-red-400">{error}</p>}
              <button className="btn-primary w-full" disabled={loading}>
                {loading ? "Sending…" : "Send reset link"}
              </button>
              <p className="text-center text-xs text-white/50">
                <Link href="/login" className="hover:text-white">
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
