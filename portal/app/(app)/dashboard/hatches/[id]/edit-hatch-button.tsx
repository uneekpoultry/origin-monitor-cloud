"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateHatch } from "../actions";
import {
  SPECIES_PRESETS,
  speciesPreset,
  addDays,
} from "@/lib/hatches/species";

type EggSource = "own_flock" | "purchased" | "shipped" | "other" | "";

type Initial = {
  name: string;
  species: string;
  egg_count: number;
  start_date: string;
  expected_hatch_date: string | null;
  breed: string | null;
  egg_source: string | null;
  egg_source_detail: string | null;
  incubator_model: string | null;
  target_temp: number | null;
  target_humid_turn_min: number | null;
  target_humid_turn_max: number | null;
  target_humid_lock_min: number | null;
  target_humid_lock_max: number | null;
};

export function EditHatchButton({
  hatchId,
  initial,
}: {
  hatchId: string;
  initial: Initial;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(initial.name);
  const [species, setSpecies] = useState(initial.species);
  const [eggCount, setEggCount] = useState<number>(initial.egg_count);
  const [startDate, setStartDate] = useState(initial.start_date);
  const [expected, setExpected] = useState<string>(
    initial.expected_hatch_date ?? "",
  );
  const [expectedOverridden, setExpectedOverridden] = useState(false);

  const [breed, setBreed] = useState(initial.breed ?? "");
  const [eggSource, setEggSource] = useState<EggSource>(
    (initial.egg_source as EggSource) ?? "",
  );
  const [eggSourceDetail, setEggSourceDetail] = useState(
    initial.egg_source_detail ?? "",
  );
  const [incubatorModel, setIncubatorModel] = useState(
    initial.incubator_model ?? "",
  );

  const preset = useMemo(() => speciesPreset(species), [species]);

  const [targetsOpen, setTargetsOpen] = useState(false);
  const [targetTemp, setTargetTemp] = useState<number>(
    initial.target_temp ?? preset.targetTemp,
  );
  const [humTurnMin, setHumTurnMin] = useState<number>(
    initial.target_humid_turn_min ?? preset.humTurnMin,
  );
  const [humTurnMax, setHumTurnMax] = useState<number>(
    initial.target_humid_turn_max ?? preset.humTurnMax,
  );
  const [humLockMin, setHumLockMin] = useState<number>(
    initial.target_humid_lock_min ?? preset.humLockMin,
  );
  const [humLockMax, setHumLockMax] = useState<number>(
    initial.target_humid_lock_max ?? preset.humLockMax,
  );
  const [targetsEdited, setTargetsEdited] = useState(false);

  const computedExpected = addDays(startDate, preset.days);
  const effectiveExpected = expectedOverridden
    ? expected
    : expected || computedExpected;

  // Re-seed targets from preset when species changes, unless the user has
  // edited them.
  useEffect(() => {
    if (targetsEdited) return;
    setTargetTemp(preset.targetTemp);
    setHumTurnMin(preset.humTurnMin);
    setHumTurnMax(preset.humTurnMax);
    setHumLockMin(preset.humLockMin);
    setHumLockMax(preset.humLockMax);
  }, [preset, targetsEdited]);

  function handleSpeciesChange(value: string) {
    if (targetsEdited) {
      const ok = confirm(
        "Changing species will overwrite the target values you've edited. Continue?",
      );
      if (!ok) return;
      setTargetsEdited(false);
    }
    setSpecies(value);
    setExpectedOverridden(false);
  }

  function reset() {
    setName(initial.name);
    setSpecies(initial.species);
    setEggCount(initial.egg_count);
    setStartDate(initial.start_date);
    setExpected(initial.expected_hatch_date ?? "");
    setExpectedOverridden(false);
    setBreed(initial.breed ?? "");
    setEggSource((initial.egg_source as EggSource) ?? "");
    setEggSourceDetail(initial.egg_source_detail ?? "");
    setIncubatorModel(initial.incubator_model ?? "");
    setTargetTemp(initial.target_temp ?? preset.targetTemp);
    setHumTurnMin(initial.target_humid_turn_min ?? preset.humTurnMin);
    setHumTurnMax(initial.target_humid_turn_max ?? preset.humTurnMax);
    setHumLockMin(initial.target_humid_lock_min ?? preset.humLockMin);
    setHumLockMax(initial.target_humid_lock_max ?? preset.humLockMax);
    setTargetsOpen(false);
    setTargetsEdited(false);
    setError(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Name is required.");
    if (!Number.isInteger(eggCount) || eggCount < 1) {
      return setError("Egg count must be at least 1.");
    }
    if (!startDate) return setError("Start date is required.");

    const speciesChanged = species !== initial.species;
    if (speciesChanged) {
      if (
        !confirm(
          "Changing species will recalculate lockdown + expected hatch dates. Continue?",
        )
      )
        return;
    }

    startTransition(async () => {
      const r = await updateHatch(hatchId, {
        name,
        species,
        egg_count: eggCount,
        start_date: startDate,
        expected_hatch_date: effectiveExpected || computedExpected,
        breed: breed || null,
        egg_source: (eggSource || null) as
          | "own_flock"
          | "purchased"
          | "shipped"
          | "other"
          | null,
        egg_source_detail:
          eggSource === "purchased" || eggSource === "shipped"
            ? eggSourceDetail || null
            : null,
        incubator_model: incubatorModel || null,
        target_temp: targetTemp,
        target_humid_turn_min: humTurnMin,
        target_humid_turn_max: humTurnMax,
        target_humid_lock_min: humLockMin,
        target_humid_lock_max: humLockMax,
      });
      if (r.error) setError(r.error);
      else {
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-ghost text-sm">
        Edit details
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={close}
        >
          <div
            className="w-full max-w-xl card max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Edit hatch details</h2>
              <button
                onClick={close}
                className="text-white/50 hover:text-white"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              {/* Hatch details */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">
                  Hatch details
                </h3>

                <div>
                  <label className="mb-1 block text-xs font-medium text-white/70">
                    Name
                  </label>
                  <input
                    required
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-white/70">
                      Species
                    </label>
                    <select
                      required
                      className="input"
                      value={species}
                      onChange={(e) => handleSpeciesChange(e.target.value)}
                    >
                      {SPECIES_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label} ({p.days}d)
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-white/70">
                      Breed
                    </label>
                    <input
                      className="input"
                      placeholder="e.g. ISA Brown"
                      value={breed}
                      onChange={(e) => setBreed(e.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-white/70">
                      Egg count
                    </label>
                    <input
                      type="number"
                      required
                      min={1}
                      className="input"
                      value={eggCount}
                      onChange={(e) =>
                        setEggCount(parseInt(e.target.value, 10) || 0)
                      }
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-white/70">
                      Incubator
                    </label>
                    <input
                      className="input"
                      placeholder="e.g. Brinsea Ovation 28"
                      value={incubatorModel}
                      onChange={(e) => setIncubatorModel(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-white/70">
                    Egg source
                  </label>
                  <div className="flex gap-2">
                    <select
                      className="input flex-1"
                      value={eggSource}
                      onChange={(e) =>
                        setEggSource(e.target.value as EggSource)
                      }
                    >
                      <option value="">—</option>
                      <option value="own_flock">Own flock</option>
                      <option value="purchased">Purchased locally</option>
                      <option value="shipped">Shipped</option>
                      <option value="other">Other</option>
                    </select>
                    {(eggSource === "purchased" || eggSource === "shipped") && (
                      <input
                        className="input flex-1"
                        placeholder="Supplier / source"
                        value={eggSourceDetail}
                        onChange={(e) => setEggSourceDetail(e.target.value)}
                      />
                    )}
                  </div>
                </div>
              </section>

              {/* Dates */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">
                  Dates
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-white/70">
                      Start date
                    </label>
                    <input
                      type="date"
                      required
                      className="input"
                      value={startDate}
                      onChange={(e) => {
                        setStartDate(e.target.value);
                        setExpectedOverridden(false);
                      }}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-white/70">
                      Expected hatch
                    </label>
                    <input
                      type="date"
                      className="input"
                      value={effectiveExpected}
                      onChange={(e) => {
                        setExpected(e.target.value);
                        setExpectedOverridden(true);
                      }}
                    />
                  </div>
                </div>
              </section>

              {/* Incubation targets */}
              <section className="space-y-3">
                <button
                  type="button"
                  onClick={() => setTargetsOpen((v) => !v)}
                  className="flex w-full items-center justify-between text-left text-xs font-semibold uppercase tracking-widest text-white/40 hover:text-white/70"
                >
                  <span>Incubation targets</span>
                  <span>{targetsOpen ? "−" : "+"}</span>
                </button>

                {targetsOpen && (
                  <div className="space-y-3 rounded-lg border border-white/5 bg-black/20 p-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-white/70">
                        Target temperature (°C)
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        className="input max-w-[120px]"
                        value={targetTemp}
                        onChange={(e) => {
                          setTargetTemp(parseFloat(e.target.value) || 0);
                          setTargetsEdited(true);
                        }}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-white/70">
                        Humidity — turning phase (%)
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          className="input w-24"
                          value={humTurnMin}
                          onChange={(e) => {
                            setHumTurnMin(parseInt(e.target.value, 10) || 0);
                            setTargetsEdited(true);
                          }}
                        />
                        <span className="text-white/40">–</span>
                        <input
                          type="number"
                          className="input w-24"
                          value={humTurnMax}
                          onChange={(e) => {
                            setHumTurnMax(parseInt(e.target.value, 10) || 0);
                            setTargetsEdited(true);
                          }}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-white/70">
                        Humidity — lockdown phase (%)
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          className="input w-24"
                          value={humLockMin}
                          onChange={(e) => {
                            setHumLockMin(parseInt(e.target.value, 10) || 0);
                            setTargetsEdited(true);
                          }}
                        />
                        <span className="text-white/40">–</span>
                        <input
                          type="number"
                          className="input w-24"
                          value={humLockMax}
                          onChange={(e) => {
                            setHumLockMax(parseInt(e.target.value, 10) || 0);
                            setTargetsEdited(true);
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  className="btn-primary flex-1"
                  disabled={pending}
                >
                  {pending ? "Saving…" : "Save changes"}
                </button>
                <button type="button" onClick={close} className="btn-ghost">
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
