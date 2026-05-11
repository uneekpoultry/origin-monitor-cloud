"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimSensor, dismissSensor } from "./actions";

type Props = {
  id: string;
  serial: string;
  model: "pro" | "lite";
  advertisedName: string | null;
  lastSeen: string | null;
  latestTemp: number | null;
  latestHumidity: number | null;
};

export function PendingSensorCard({
  id,
  serial,
  model,
  advertisedName,
  lastSeen,
  latestTemp,
  latestHumidity,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(advertisedName ?? "");
  const [selModel, setSelModel] = useState<"pro" | "lite">(model);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClaim(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await claimSensor(id, { name, model: selModel });
      if (r.error) setError(r.error);
      else {
        setOpen(false);
        router.refresh();
      }
    });
  }

  function handleDismiss() {
    if (!confirm("Remove this sensor from your list?")) return;
    startTransition(async () => {
      const r = await dismissSensor(id);
      if (r.error) setError(r.error);
      else router.refresh();
    });
  }

  return (
    <>
      <div className="card border-light/30 bg-light/[0.04]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="rounded-full border border-light/40 bg-light/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-light">
              New — needs naming
            </span>
            {advertisedName && (
              <h3 className="mt-2 truncate text-base font-semibold">
                {advertisedName}
              </h3>
            )}
            <p className="mt-1 font-mono text-xs text-white/50">{serial}</p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40">
              Temp
            </div>
            <div className="mt-1 tabular-nums">
              {latestTemp != null ? `${latestTemp.toFixed(1)} °C` : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40">
              Humidity
            </div>
            <div className="mt-1 tabular-nums">
              {latestHumidity != null ? `${latestHumidity.toFixed(1)} %` : "—"}
            </div>
          </div>
        </div>

        <p className="mt-3 text-xs text-white/50">
          {lastSeen ? `Last seen ${timeAgo(lastSeen)}` : "Awaiting first reading"}
        </p>

        <div className="mt-4 flex gap-2">
          <button onClick={() => setOpen(true)} className="btn-primary flex-1">
            Add this sensor
          </button>
          <button
            onClick={handleDismiss}
            className="btn-ghost"
            disabled={pending}
          >
            Not mine
          </button>
        </div>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(false)}
        >
          <div className="w-full max-w-md card" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Add sensor</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-white/50 hover:text-white"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-sm text-white/60">
              Give it a name you'll recognise (e.g. "Main incubator") and
              confirm the model.
            </p>
            <p className="mt-2 font-mono text-xs text-white/40">{serial}</p>

            <form onSubmit={handleClaim} className="mt-6 space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-white/70">
                  Friendly name
                </label>
                <input
                  required
                  autoFocus
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Main incubator"
                />
              </div>
              <div>
                <label className="mb-2 block text-xs font-medium text-white/70">
                  Model
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <ModelRadio
                    label="Origin Pro"
                    sub="IP67, factory calibrated"
                    selected={selModel === "pro"}
                    onSelect={() => setSelModel("pro")}
                  />
                  <ModelRadio
                    label="Origin Lite"
                    sub="Compact, uncalibrated"
                    selected={selModel === "lite"}
                    onSelect={() => setSelModel("lite")}
                  />
                </div>
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  className="btn-primary flex-1"
                  disabled={pending}
                >
                  {pending ? "Adding…" : "Add sensor"}
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="btn-ghost"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function ModelRadio({
  label,
  sub,
  selected,
  onSelect,
}: {
  label: string;
  sub: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-lg border p-3 text-left transition ${
        selected
          ? "border-light/60 bg-light/10"
          : "border-white/10 hover:border-white/20"
      }`}
    >
      <div className="text-sm font-semibold">{label}</div>
      <div className="mt-0.5 text-xs text-white/50">{sub}</div>
    </button>
  );
}

function timeAgo(iso: string) {
  const s = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
