"use client";

import { useMemo, useState } from "react";
import { Timestamp } from "@/components/timestamp";

type Event = {
  id: string;
  observed_at: string;
  severity: "info" | "warn" | "error";
  source: string;
  message: string;
  created_at: string;
};

type Severity = "all" | "info" | "warn" | "error";

export function EventsTable({
  events,
  sources,
}: {
  events: Event[];
  sources: string[];
}) {
  const [severity, setSeverity] = useState<Severity>("all");
  const [source, setSource] = useState<string>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (severity !== "all" && e.severity !== severity) return false;
      if (source !== "all" && e.source !== source) return false;
      if (q && !e.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [events, severity, source, query]);

  const counts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0 };
    for (const e of events) c[e.severity]++;
    return c;
  }, [events]);

  if (events.length === 0) {
    return (
      <p className="text-sm text-white/50">
        No events yet. Events arrive via the Primus heartbeat once the device
        starts forwarding its log ring buffers.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-white/60">
          {filtered.length} of {events.length}
        </span>
        <span className="text-white/30">·</span>
        <span className="text-white/70">
          <span className="text-light">{counts.info} info</span> /{" "}
          <span className="text-amber-300">{counts.warn} warn</span> /{" "}
          <span className="text-red-300">{counts.error} error</span>
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            className="input max-w-[140px]"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as Severity)}
          >
            <option value="all">All severities</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <select
            className="input max-w-[160px]"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="search"
            placeholder="Search message…"
            className="input max-w-[200px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/5">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Message</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} className="border-t border-white/5 align-top">
                <td className="whitespace-nowrap px-4 py-2 text-white/60">
                  <Timestamp iso={e.observed_at} />
                </td>
                <td className="px-4 py-2">
                  <SeverityBadge value={e.severity} />
                </td>
                <td className="px-4 py-2 font-mono text-xs text-white/70">
                  {e.source}
                </td>
                <td className="px-4 py-2 text-white/80">{e.message}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-6 text-center text-sm text-white/40"
                >
                  No events match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SeverityBadge({ value }: { value: "info" | "warn" | "error" }) {
  const styles = {
    info: "border-light/30 bg-light/10 text-light",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    error: "border-red-500/30 bg-red-500/10 text-red-300",
  }[value];
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${styles}`}
    >
      {value}
    </span>
  );
}
