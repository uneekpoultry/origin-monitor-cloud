"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addEggWeight, deleteEggWeight } from "../actions";
import { Timestamp } from "@/components/timestamp";

export type EggWeight = {
  id: string;
  weighed_at: string;
  day_number: number | null;
  weight_grams: number;
  stage: "set" | "lockdown" | "other" | null;
  notes: string | null;
};

export function EggWeights({
  hatchId,
  weights,
  speciesKey,
}: {
  hatchId: string;
  weights: EggWeight[];
  speciesKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const sorted = useMemo(
    () =>
      [...weights].sort(
        (a, b) => new Date(a.weighed_at).getTime() - new Date(b.weighed_at).getTime(),
      ),
    [weights],
  );

  // Compute weight loss if there's a "set" entry and at least one later entry
  const lossInfo = useMemo(() => {
    const first = sorted.find((w) => w.stage === "set") ?? sorted[0];
    if (!first || sorted.length < 2) return null;
    const latest = sorted[sorted.length - 1];
    if (latest.id === first.id) return null;
    const loss = ((first.weight_grams - latest.weight_grams) / first.weight_grams) * 100;
    return { loss, fromWeight: first.weight_grams, toWeight: latest.weight_grams };
  }, [sorted]);

  // Reference target by species (chicken-style default)
  const target = targetWeightLoss(speciesKey);
  const withinTarget =
    lossInfo && lossInfo.loss >= target.min && lossInfo.loss <= target.max;

  function handleDelete(id: string) {
    if (!confirm("Delete this weight entry?")) return;
    startTransition(async () => {
      await deleteEggWeight(id, hatchId);
      router.refresh();
    });
  }

  return (
    <section className="card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between"
      >
        <div>
          <h2 className="text-lg font-semibold">Egg weight tracking</h2>
          <p className="mt-0.5 text-xs text-white/40">
            Optional — track weight loss across incubation
          </p>
        </div>
        <span className="text-white/40">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="mt-5">
          {weights.length === 0 ? (
            <p className="text-sm text-white/50">
              No weight entries yet. Add one at setting and again at lockdown to
              track moisture loss.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-white/5">
              <table className="w-full text-sm">
                <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
                  <tr>
                    <th className="px-3 py-2">Stage</th>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Day</th>
                    <th className="px-3 py-2">Weight (g)</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((w) => (
                    <tr key={w.id} className="border-t border-white/5">
                      <td className="px-3 py-2 capitalize">
                        {w.stage ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-white/70">
                        <Timestamp iso={w.weighed_at} mode="date" />
                      </td>
                      <td className="px-3 py-2 tabular-nums text-white/60">
                        {w.day_number ?? "—"}
                      </td>
                      <td className="px-3 py-2 tabular-nums font-semibold">
                        {w.weight_grams.toFixed(1)}
                      </td>
                      <td className="px-3 py-2 text-white/70">
                        {w.notes || "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => handleDelete(w.id)}
                          className="text-white/40 hover:text-red-300"
                          disabled={pending}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {lossInfo && (
            <div
              className={`mt-4 rounded-lg border p-3 text-sm ${
                withinTarget
                  ? "border-light/30 bg-light/10 text-light"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-300"
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">
                  Weight loss: {lossInfo.loss.toFixed(1)}%
                </span>
                <span className="text-xs text-white/60">
                  Target {target.min}–{target.max}% by lockdown
                </span>
              </div>
              <div className="mt-1 text-xs text-white/60">
                From {lossInfo.fromWeight.toFixed(1)}g →{" "}
                {lossInfo.toWeight.toFixed(1)}g
              </div>
            </div>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => setModalOpen(true)}
              className="btn-ghost"
            >
              + Add weight entry
            </button>
            <span className="text-xs text-white/40">
              Origin Scale integration coming — will auto-populate this section.
            </span>
          </div>
        </div>
      )}

      {modalOpen && (
        <AddWeightModal
          hatchId={hatchId}
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            setModalOpen(false);
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

function targetWeightLoss(species: string): { min: number; max: number } {
  // Most poultry lose 12–15% by lockdown; goose / duck are similar; emu a bit
  // more (14–16). Keep a single safe default for now.
  if (species === "emu") return { min: 14, max: 16 };
  if (species === "goose") return { min: 11, max: 14 };
  return { min: 12, max: 15 };
}

function AddWeightModal({
  hatchId,
  onClose,
  onSaved,
}: {
  hatchId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<"set" | "lockdown" | "other">("set");
  const [weight, setWeight] = useState("");
  const [dayNumber, setDayNumber] = useState("");
  const [notes, setNotes] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const w = parseFloat(weight);
    if (!Number.isFinite(w) || w <= 0) {
      return setError("Weight must be a positive number.");
    }
    const day =
      dayNumber === "" ? null : parseInt(dayNumber, 10);
    if (day != null && (!Number.isInteger(day) || day < 0)) {
      return setError("Day number must be a whole number.");
    }
    startTransition(async () => {
      const r = await addEggWeight({
        hatch_id: hatchId,
        stage,
        weight_grams: w,
        day_number: day,
        notes: notes || null,
      });
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
          <h2 className="text-lg font-semibold">Add weight entry</h2>
          <button
            onClick={onClose}
            className="text-white/50 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Stage
            </label>
            <select
              className="input"
              value={stage}
              onChange={(e) =>
                setStage(e.target.value as "set" | "lockdown" | "other")
              }
            >
              <option value="set">At set (day 0/1)</option>
              <option value="lockdown">At lockdown</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-white/70">
                Weight (g)
              </label>
              <input
                type="number"
                step="0.1"
                min={0}
                required
                className="input"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-white/70">
                Day number (optional)
              </label>
              <input
                type="number"
                min={0}
                className="input"
                value={dayNumber}
                onChange={(e) => setDayNumber(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Notes (optional)
            </label>
            <textarea
              className="input min-h-[60px]"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Sample size, scale notes…"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={pending}
            >
              {pending ? "Saving…" : "Save entry"}
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
