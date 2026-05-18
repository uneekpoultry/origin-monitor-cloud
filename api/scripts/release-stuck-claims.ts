/**
 * Release stuck / orphaned sensor_resync_requests claims so the
 * historical backlog can actually drain.
 *
 * Two problem sets:
 *   A) ORPHANS  — claimed_at set, but fulfilled_at/cancelled_at/
 *      fulfilled_error all NULL, claimed > 1h ago. A reader grabbed
 *      these and never reported back. The retry sweep never touches
 *      them (no fulfilled_error) and the dedup guard blocks fresh
 *      requests for the sensor. Dead weight.
 *   B) ERRORED-BUT-CLAIMED — fulfilled_error set, still claimed, not
 *      cancelled, not fulfilled. Releasing the claim lets the
 *      opportunistic backlog + App Realtime re-pick them immediately
 *      instead of waiting on backoff.
 *
 * Action: clear claimed_at/claimed_by (back into the unclaimed pool)
 * and extend expires_at to now+48h (the opportunistic-backlog query
 * filters expires_at > now(); 24h-old rows have almost certainly
 * expired, so without this the release is a no-op).
 *
 * Prints every row BEFORE mutating it, then applies, then re-reads to
 * confirm. Read-trace + write in one pass.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000; // 1h
const NEW_EXPIRY_MS = 48 * 60 * 60 * 1000; // now + 48h

const nowMs = Date.now();
const ageStr = (d: string | null) =>
  d
    ? (() => {
        const m = Math.round((nowMs - new Date(d).getTime()) / 60000);
        return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
      })()
    : "-";

async function main() {
  // Resolve sensor names for readable output.
  const { data: sensors } = await sb.from("sensors").select("id, name");
  const name = new Map((sensors ?? []).map((s) => [s.id, s.name]));

  // Pull every non-terminal claimed row (the candidate universe).
  const { data: rows } = await sb
    .from("sensor_resync_requests")
    .select(
      "id, sensor_id, reason, claimed_at, claimed_by, fulfilled_at, fulfilled_error, cancelled_at, retry_count, requested_at, expires_at, range_start, range_end",
    )
    .not("claimed_at", "is", null)
    .is("fulfilled_at", null)
    .is("cancelled_at", null)
    .order("claimed_at", { ascending: true });

  if (!rows || rows.length === 0) {
    console.log("No claimed-but-unfinished rows. Nothing to release.");
    return;
  }

  const orphans = rows.filter(
    (r) =>
      r.fulfilled_error == null &&
      nowMs - new Date(r.claimed_at!).getTime() > ORPHAN_MIN_AGE_MS,
  );
  const erroredClaimed = rows.filter((r) => r.fulfilled_error != null);

  const dump = (label: string, set: typeof rows) => {
    console.log("=".repeat(78));
    console.log(`  ${label} — ${set.length} row(s)`);
    console.log("=".repeat(78));
    for (const r of set) {
      const expired =
        r.expires_at && new Date(r.expires_at).getTime() < nowMs
          ? " EXPIRED"
          : "";
      console.log(
        `  ${(name.get(r.sensor_id) ?? r.sensor_id).padEnd(20)} ` +
          `reason=${String(r.reason).padEnd(16)} ` +
          `claimed ${ageStr(r.claimed_at).padEnd(10)} ago ` +
          `by=${String(r.claimed_by ?? "-").padEnd(22)} ` +
          `retry=${r.retry_count ?? 0} ` +
          `err=${r.fulfilled_error ?? "-"}${expired}`,
      );
      console.log(`     id=${r.id}  expires_at=${r.expires_at}`);
    }
    console.log();
  };

  dump("SET A — orphaned claims (claimed >1h, no error, never reported)", orphans);
  dump("SET B — errored but still claimed", erroredClaimed);

  const toRelease = [...orphans, ...erroredClaimed];
  if (toRelease.length === 0) {
    console.log("Nothing matched the release criteria. No write performed.");
    return;
  }

  const ids = toRelease.map((r) => r.id);
  const newExpiry = new Date(nowMs + NEW_EXPIRY_MS).toISOString();

  console.log("=".repeat(78));
  console.log(
    `  APPLYING: release ${ids.length} claim(s), extend expires_at → ${newExpiry}`,
  );
  console.log("=".repeat(78));

  const { data: updated, error } = await sb
    .from("sensor_resync_requests")
    .update({
      claimed_at: null,
      claimed_by: null,
      expires_at: newExpiry,
    })
    .in("id", ids)
    .select("id");

  if (error) {
    console.log(`  ERROR: ${error.message}`);
    process.exit(1);
  }
  console.log(`  Released ${updated?.length ?? 0} row(s).`);
  console.log();
  console.log(
    "  These are now unclaimed + unexpired. Next Primus heartbeat's",
  );
  console.log(
    "  opportunistic-backlog pass (or the App's Realtime subscription)",
  );
  console.log(
    "  will re-pick them. The circuit breaker now governs which reader.",
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
