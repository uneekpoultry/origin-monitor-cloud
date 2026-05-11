"use client";

import { useEffect, useState } from "react";

type Mode = "date" | "datetime";

/**
 * Render an ISO timestamp in a sensible timezone.
 *
 * - **No `tz` prop** — renders in the *viewer's* browser timezone. Used in
 *   every page the customer sees their own data. During SSR it shows UTC as
 *   a deterministic placeholder; after hydration it swaps to local.
 * - **`tz` prop** — renders in that IANA timezone, server-safe (no
 *   hydration mismatch). Used when displaying data in someone else's TZ,
 *   e.g. admin viewing a customer, or pre-rendered email content.
 *
 * For date-only fields (Postgres `date`, e.g. "2026-04-21"), use
 * `formatDate` from @/lib/format instead — those have no timezone.
 */
export function Timestamp({
  iso,
  mode = "datetime",
  fallback = "—",
  tz,
}: {
  iso: string | null | undefined;
  mode?: Mode;
  fallback?: string;
  tz?: string;
}) {
  const hasTz = !!tz;
  const explicit = hasTz && iso ? formatInTz(iso, mode, tz!) : null;
  const utcFallback = iso && !hasTz ? formatUTC(iso, mode) : null;
  const [local, setLocal] = useState<string | null>(null);

  useEffect(() => {
    if (!iso || hasTz) return;
    setLocal(formatBrowserLocal(iso, mode));
  }, [iso, mode, hasTz]);

  if (!iso) return <>{fallback}</>;
  if (hasTz) return <>{explicit}</>;
  return <>{local ?? utcFallback}</>;
}

function formatInTz(iso: string, mode: Mode, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: tz,
  };
  if (mode === "datetime") {
    opts.hour = "2-digit";
    opts.minute = "2-digit";
    opts.hour12 = false;
  }
  const d = new Date(iso);
  if (mode === "date") return d.toLocaleDateString("en-GB", opts);
  return d.toLocaleString("en-GB", opts);
}

function formatBrowserLocal(iso: string, mode: Mode): string {
  const opts: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  };
  if (mode === "datetime") {
    opts.hour = "2-digit";
    opts.minute = "2-digit";
    opts.hour12 = false;
  }
  const d = new Date(iso);
  if (mode === "date") return d.toLocaleDateString(undefined, opts);
  return d.toLocaleString(undefined, opts);
}

function formatUTC(iso: string, mode: Mode): string {
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  if (mode === "date") return `${dd}/${mm}/${yyyy}`;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}
