"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteHatch,
  failHatch,
  recordHatchResults,
  reopenHatch,
  updateHatch,
} from "../actions";

type Props = {
  id: string;
  status: "active" | "completed" | "failed";
  eggCount: number;
  initialNotes: string | null;
  initialResults: {
    fertile_count: number | null;
    hatched_count: number | null;
    died_in_shell: number | null;
    pipped_not_hatched: number | null;
    early_deaths: number | null;
    first_pip_at: string | null;
    hatch_complete_at: string | null;
    chick_assessment: string | null;
  };
};

export function HatchControls({
  id,
  status,
  eggCount,
  initialNotes,
  initialResults,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );
  const [showResults, setShowResults] = useState(false);
  const [notes, setNotes] = useState(initialNotes ?? "");

  const dirtyNotes = notes !== (initialNotes ?? "");

  function flash(tone: "ok" | "err", text: string) {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 3000);
  }

  function saveNotes() {
    startTransition(async () => {
      const r = await updateHatch(id, { notes });
      if (r.error) flash("err", r.error);
      else flash("ok", "Notes saved.");
    });
  }

  function handleFail() {
    if (!confirm("Mark this hatch as failed?")) return;
    startTransition(async () => {
      const r = await failHatch(id);
      if (r.error) flash("err", r.error);
      else router.refresh();
    });
  }

  function handleReopen() {
    if (
      !confirm(
        "Reopen this hatch? Recorded results will be cleared so you can log again.",
      )
    )
      return;
    startTransition(async () => {
      const r = await reopenHatch(id);
      if (r.error) flash("err", r.error);
      else router.refresh();
    });
  }

  function handleDelete() {
    if (!confirm("Delete this hatch permanently? This cannot be undone.")) return;
    startTransition(async () => {
      await deleteHatch(id);
    });
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-lg font-semibold">Notes</h2>
        <textarea
          className="input mt-3 min-h-[120px]"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Observations, turning times, problems, hatch order…"
        />
        <button
          onClick={saveNotes}
          className="btn-primary mt-3"
          disabled={pending || !dirtyNotes}
        >
          {pending ? "Saving…" : "Save notes"}
        </button>
      </div>

      <div className="card space-y-4">
        <h2 className="text-lg font-semibold">
          {status === "active" ? "Finish this hatch" : "Results"}
        </h2>

        {status === "active" && (
          <div className="flex gap-2">
            <button
              onClick={() => setShowResults(true)}
              className="btn-primary flex-1"
            >
              Record hatch results
            </button>
            <button
              onClick={handleFail}
              className="btn-ghost border-red-500/30 text-red-300 hover:bg-red-500/10"
              disabled={pending}
            >
              Mark as failed
            </button>
          </div>
        )}

        {status === "completed" && (
          <p className="text-sm text-white/60">
            Edit the result numbers directly in the Completed panel above —
            changes save from there.
          </p>
        )}

        {status === "failed" && (
          <p className="text-sm text-white/60">
            Marked as failed. Reopen below if you want to log results instead.
          </p>
        )}
      </div>

      {status !== "active" && (
        <div className="card">
          <h2 className="text-lg font-semibold">Reopen</h2>
          <p className="mt-2 text-sm text-white/60">
            Mistake? Reopen to clear results and continue logging.
          </p>
          <button
            onClick={handleReopen}
            className="btn-ghost mt-3"
            disabled={pending}
          >
            Reopen hatch
          </button>
        </div>
      )}

      <div className="card border-red-500/20">
        <h2 className="text-sm font-medium text-red-300">Delete</h2>
        <p className="mt-2 text-xs text-white/50">
          Permanently deletes this hatch log. Reading history from the linked
          sensors is unaffected.
        </p>
        <button
          onClick={handleDelete}
          className="btn-ghost mt-3 border-red-500/30 text-red-300 hover:bg-red-500/10"
          disabled={pending}
        >
          Delete hatch
        </button>
      </div>

      {msg && (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            msg.tone === "ok"
              ? "border-light/30 bg-light/10 text-light"
              : "border-red-500/30 bg-red-500/10 text-red-300"
          }`}
        >
          {msg.text}
        </div>
      )}

      {showResults && (
        <ResultsModal
          id={id}
          eggCount={eggCount}
          initial={initialResults}
          onClose={() => setShowResults(false)}
          onSaved={() => {
            setShowResults(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function ResultsModal({
  id,
  eggCount,
  initial,
  onClose,
  onSaved,
}: {
  id: string;
  eggCount: number;
  initial: Props["initialResults"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [fertile, setFertile] = useState<string>(
    initial.fertile_count?.toString() ?? "",
  );
  const [hatched, setHatched] = useState<string>(
    initial.hatched_count?.toString() ?? "",
  );
  const [diedInShell, setDiedInShell] = useState<string>(
    initial.died_in_shell?.toString() ?? "",
  );
  const [pipped, setPipped] = useState<string>(
    initial.pipped_not_hatched?.toString() ?? "",
  );
  const [early, setEarly] = useState<string>(
    initial.early_deaths?.toString() ?? "",
  );
  const [firstPip, setFirstPip] = useState<string>(
    initial.first_pip_at ? localInputFromIso(initial.first_pip_at) : "",
  );
  const [hatchComplete, setHatchComplete] = useState<string>(
    initial.hatch_complete_at
      ? localInputFromIso(initial.hatch_complete_at)
      : "",
  );
  const [chickAssessment, setChickAssessment] = useState<string>(
    initial.chick_assessment ?? "",
  );

  const parsed = useMemo(() => {
    const h = hatched === "" ? null : parseInt(hatched, 10);
    const f = fertile === "" ? null : parseInt(fertile, 10);
    return {
      hatched: h,
      fertile: f,
      rate: h != null && eggCount > 0 ? h / eggCount : null,
      fertility: f != null && eggCount > 0 ? f / eggCount : null,
      ofFertile: h != null && f != null && f > 0 ? h / f : null,
    };
  }, [hatched, fertile, eggCount]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const h = hatched === "" ? NaN : parseInt(hatched, 10);
    if (!Number.isInteger(h) || h < 0) {
      return setError("Enter how many hatched (0 or more).");
    }
    const parseOpt = (s: string) => (s === "" ? null : parseInt(s, 10));
    const payload = {
      hatched_count: h,
      fertile_count: parseOpt(fertile),
      died_in_shell: parseOpt(diedInShell),
      pipped_not_hatched: parseOpt(pipped),
      early_deaths: parseOpt(early),
      first_pip_at: firstPip ? new Date(firstPip).toISOString() : null,
      hatch_complete_at: hatchComplete
        ? new Date(hatchComplete).toISOString()
        : null,
      chick_assessment: chickAssessment || null,
    };
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === "number" && (!Number.isInteger(v) || v < 0)) {
        return setError(`${k.replace(/_/g, " ")} must be a whole number.`);
      }
    }

    startTransition(async () => {
      const r = await recordHatchResults(id, payload);
      if (r.error) setError(r.error);
      else onSaved();
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md card max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Record hatch results</h2>
          <button
            onClick={onClose}
            className="text-white/50 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-sm text-white/60">
          {eggCount} eggs set. Enter whatever numbers you have; blanks are
          fine.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
          <NumberField
            label="Fertile eggs (from last candling)"
            value={fertile}
            onChange={setFertile}
            placeholder="optional"
          />
          <NumberField
            label="Hatched alive"
            value={hatched}
            onChange={setHatched}
            required
          />
          <NumberField
            label="Died in shell (fully formed)"
            value={diedInShell}
            onChange={setDiedInShell}
            placeholder="optional"
          />
          <NumberField
            label="Pipped but didn't hatch"
            value={pipped}
            onChange={setPipped}
            placeholder="optional"
          />
          <NumberField
            label="Early deaths / quitters"
            value={early}
            onChange={setEarly}
            placeholder="optional"
          />

          <div className="mt-4 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-white/70">
            <div className="flex justify-between">
              <span>Hatch rate (of set)</span>
              <span className="tabular-nums text-white">
                {parsed.rate != null ? `${(parsed.rate * 100).toFixed(1)}%` : "—"}
              </span>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Fertility rate</span>
              <span className="tabular-nums text-white">
                {parsed.fertility != null
                  ? `${(parsed.fertility * 100).toFixed(1)}%`
                  : "—"}
              </span>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Hatch of fertile</span>
              <span className="tabular-nums text-white">
                {parsed.ofFertile != null
                  ? `${(parsed.ofFertile * 100).toFixed(1)}%`
                  : "—"}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-white/5 pt-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-white/70">
                First pip
              </label>
              <input
                type="datetime-local"
                className="input"
                value={firstPip}
                onChange={(e) => setFirstPip(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-white/70">
                Hatch complete
              </label>
              <input
                type="datetime-local"
                className="input"
                value={hatchComplete}
                onChange={(e) => setHatchComplete(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Chick assessment (optional)
            </label>
            <textarea
              className="input min-h-[60px]"
              placeholder="Brief observation about chick quality, vigor, any defects…"
              value={chickAssessment}
              onChange={(e) => setChickAssessment(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={pending}
            >
              {pending ? "Saving…" : "Save results"}
            </button>
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  required = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-white/70">
        {label}
        {required && <span className="ml-1 text-light">*</span>}
      </label>
      <input
        type="number"
        min={0}
        step={1}
        required={required}
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function localInputFromIso(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
