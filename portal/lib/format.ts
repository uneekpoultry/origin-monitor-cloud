// Tiny formatting helpers, AU-locale biased.

/**
 * Format a date-only ISO string (`"2026-04-21"`) as DD/MM/YYYY.
 * Uses string parsing to avoid timezone drift — date-only strings have
 * no timezone and creating a Date from them interprets as UTC, which
 * can show the wrong day in non-UTC zones.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const head = iso.substring(0, 10);
  const [y, m, d] = head.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

// The droplet runs in UTC; always pin timezone explicitly so SSR and
// client-rendered timestamps both read in Sydney time.
const AU_TZ = "Australia/Sydney";

/**
 * Format a full timestamp as DD/MM/YYYY HH:mm, Sydney time.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-AU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: AU_TZ,
  });
}

/**
 * Format a timestamp as just the Sydney-time date (DD/MM/YYYY).
 * Use this for `timestamptz` columns when you want the date only.
 */
export function formatDateFromTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: AU_TZ,
  });
}
