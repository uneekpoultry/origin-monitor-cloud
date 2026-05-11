import { notFound } from "next/navigation";
import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Timestamp } from "@/components/timestamp";
import { EventsTable } from "./events-table";

export const dynamic = "force-dynamic";

export default async function PrimusEventsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = createAdminClient();

  const { data: device } = await admin
    .from("primus_devices")
    .select("id, name, user_id, firmware_version, last_seen")
    .eq("id", id)
    .maybeSingle();

  if (!device) notFound();

  const { data: ownerAuth } = await admin.auth.admin.getUserById(device.user_id);
  const { data: ownerProfile } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", device.user_id)
    .maybeSingle();
  const ownerLabel =
    ownerProfile?.full_name ||
    ownerAuth.user?.email ||
    device.user_id;

  const { data: events } = await admin
    .from("primus_events")
    .select("id, observed_at, severity, source, message, created_at")
    .eq("primus_id", device.id)
    .order("observed_at", { ascending: false })
    .limit(500);

  const sources = Array.from(
    new Set((events ?? []).map((e) => e.source)),
  ).sort();

  const { data: commands } = await admin
    .from("primus_commands")
    .select("id, type, params, created_at, delivered_at, completed_at, result")
    .eq("primus_id", device.id)
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <div>
      <Link
        href="/admin/primus"
        className="text-sm text-white/50 hover:text-white/80"
      >
        ← All Primus devices
      </Link>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">
        {device.name || device.id.slice(0, 8)}
      </h1>
      <p className="mt-1 text-sm text-white/60">
        Owner: {ownerLabel} · Firmware: {device.firmware_version || "—"} ·
        Last seen:{" "}
        {device.last_seen
          ? new Date(device.last_seen).toLocaleString()
          : "Never"}
      </p>

      <h2 className="mt-10 text-lg font-semibold">Commands</h2>
      <p className="mt-1 text-sm text-white/50">
        Recent commands queued for this device. Pending commands are picked up
        on the next heartbeat (~60s).
      </p>
      <div className="mt-4">
        {commands && commands.length > 0 ? (
          <div className="overflow-hidden rounded-xl border border-white/5">
            <table className="w-full text-sm">
              <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
                <tr>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Queued</th>
                  <th className="px-4 py-3">Delivered</th>
                  <th className="px-4 py-3">Completed</th>
                  <th className="px-4 py-3">Result</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((c) => (
                  <tr key={c.id} className="border-t border-white/5 align-top">
                    <td className="px-4 py-2 font-mono text-xs">{c.type}</td>
                    <td className="px-4 py-2">
                      <CommandStatus
                        delivered_at={c.delivered_at}
                        completed_at={c.completed_at}
                      />
                    </td>
                    <td className="px-4 py-2 text-white/60">
                      <Timestamp iso={c.created_at} />
                    </td>
                    <td className="px-4 py-2 text-white/60">
                      {c.delivered_at ? <Timestamp iso={c.delivered_at} /> : "—"}
                    </td>
                    <td className="px-4 py-2 text-white/60">
                      {c.completed_at ? <Timestamp iso={c.completed_at} /> : "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-white/70">
                      {c.result ? JSON.stringify(c.result) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-white/50">No commands issued yet.</p>
        )}
      </div>

      <h2 className="mt-10 text-lg font-semibold">Event log</h2>
      <p className="mt-1 text-sm text-white/50">
        Most recent 500 entries from this device's on-board log ring buffers.
      </p>

      <div className="mt-6">
        <EventsTable events={events ?? []} sources={sources} />
      </div>
    </div>
  );
}

function CommandStatus({
  delivered_at,
  completed_at,
}: {
  delivered_at: string | null;
  completed_at: string | null;
}) {
  if (completed_at) {
    return (
      <span className="inline-block rounded border border-light/30 bg-light/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-light">
        done
      </span>
    );
  }
  if (delivered_at) {
    return (
      <span className="inline-block rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-amber-300">
        running
      </span>
    );
  }
  return (
    <span className="inline-block rounded border border-white/20 bg-white/5 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-white/70">
      pending
    </span>
  );
}
