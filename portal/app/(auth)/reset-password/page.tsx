"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/logo";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [checking, setChecking] = useState(true);

  // On mount, verify the user has a live session (from clicking the reset link).
  // If they came here without one, send them to /forgot.
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace("/forgot");
      } else {
        setChecking(false);
      }
    });
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      return setError("Password must be at least 8 characters.");
    }
    if (password !== confirm) {
      return setError("Passwords don't match.");
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) return setError(error.message);

    setDone(true);
    setTimeout(() => {
      router.push("/dashboard");
      router.refresh();
    }, 1500);
  }

  return (
    <div className="min-h-screen grain flex flex-col">
      <div className="mx-auto w-full max-w-6xl px-6 py-6">
        <Logo />
      </div>

      <div className="flex flex-1 items-center justify-center px-6 pb-20">
        <div className="w-full max-w-sm">
          {checking ? (
            <p className="text-white/40">Checking your link…</p>
          ) : done ? (
            <div className="card">
              <h1 className="text-xl font-bold tracking-tight">Password updated</h1>
              <p className="mt-2 text-sm text-white/60">
                Redirecting you to your dashboard…
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold tracking-tight">Choose a new password</h1>
              <p className="mt-2 text-sm text-white/60">
                This replaces your old password. You'll stay signed in.
              </p>
              <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
                <div>
                  <label className="mb-1 block text-xs font-medium text-white/70">
                    New password
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
                <div>
                  <label className="mb-1 block text-xs font-medium text-white/70">
                    Confirm new password
                  </label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    className="input"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>

                {error && <p className="text-sm text-red-400">{error}</p>}

                <button
                  type="submit"
                  className="btn-primary w-full"
                  disabled={loading}
                >
                  {loading ? "Updating…" : "Update password"}
                </button>

                <p className="text-center text-xs text-white/50">
                  <Link href="/login" className="hover:text-white">
                    Back to sign in
                  </Link>
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
