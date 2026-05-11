"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateHatch } from "../actions";

type Props = {
  hatchId: string;
  firstPipAt: string | null;
  hatchCompleteAt: string | null;
};

/**
 * Two datetime-local inputs for first pip + hatch complete. When both are
 * set, shows the computed hatch window (e.g. "1d 6h 15m").
 *
 * Stored as timestamptz. We write with `${iso}:00Z` if the user provides
 * just a minute-precision value so Postgres interprets as UTC; we'll render
 * back in their local TZ via <Timestamp> on read.
 */
export function HatchTiming({ hatchId, firstPipAt, hatchCompleteAt }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  // Pre-fill form values from DB (datetime-local wants "YYYY-MM-DDTHH:mm")
  const initialPip = firstPipAt ? toLocalInput(firstPipAt) : "";
  const initialComplete = hatchCompleteAt ? toLocalInput(hatchCompleteAt) : "";
  const [pip, setPip] = useState(initialPip);
  const [complete, setComplete] = useState(initialComplete);

  const dirty = pip !== initialPip || complete !== initialComplete;

  const window = useMemo(() => computeWindow(pip, complete), [pip, complete]);

  function flash(tone: "ok" | "err", text: string) {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 3000);
  }

  function handleSave() {
    startTransition(async () => {
      const r = await updateHatch(hatchId, {
        first_pip_at: pip ? toIso(pip) : null,
        hatch_complete_at: complete ? toIso(complete) : null,
      });
      if (r.error) flash("err", r.error);
      else {
        flash("ok", "Saved.");
        router.refresh();
      }
    });
  }

  return (
    <section className="card">
      <h2 className="text-lg font-semibold">Hatch timing</h2>
      <p className="mt-1 text-sm text-white/60">
        Log the first pip and when all viable chicks had hatched.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-white/70">
            First pip
          </label>
          <input
            type="datetime-local"
            className="input"
            value={pip}
            onChange={(e) => setPip(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-white/70">
            Hatch complete
          </label>
          <input
            type="datetime-local"
            className="input"
            value={complete}
            onChange={(e) => setComplete(e.target.value)}
          />
        </div>
      </div>

      {window && (
        <div className="mt-4 rounded-lg border border-light/30 bg-light/[0.04] p-3 text-sm">
          <span className="text-white/60">Hatch window: </span>
          <span className="font-semibold text-light tabular-nums">
            {window}
          </span>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={handleSave}
          className="btn-primary"
          disabled={pending || !dirty}
        >
          {pending ? "Saving…" : "Save timing"}
        </button>
        {dirty && !pending && (
          <button
            onClick={() => {
              setPip(initialPip);
              setComplete(initialComplete);
            }}
            className="text-sm text-white/50 hover:text-white"
          >
            Reset
          </button>
        )}
        {msg && (
          <span
            className={`text-sm ${msg.tone === "ok" ? "text-light" : "text-red-300"}`}
          >
            {msg.text}
          </span>
        )}
      </div>
    </section>
  );
}

function toLocalInput(iso: string): string {
  // datetime-local expects "YYYY-MM-DDTHH:mm" in the browser's local TZ.
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(local: string): string {
  // Convert browser-local datetime-local string to ISO UTC.
  return new Date(local).toISOString();
}

function computeWindow(pip: string, complete: string): string | null {
  if (!pip || !complete) return null;
  const a = new Date(pip).getTime();
  const b = new Date(complete).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  const mins = Math.round((b - a) / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(" ");
}
