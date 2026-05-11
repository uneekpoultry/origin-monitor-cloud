"use client";

import { useState, useTransition, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createHatch } from "./actions";
import {
  SPECIES_PRESETS,
  speciesPreset,
  addDays,
  todayIso,
} from "@/lib/hatches/species";
import { formatDate } from "@/lib/format";

type SensorOption = { id: string; label: string; isAmbient: boolean };
type EggSource = "own_flock" | "purchased" | "shipped" | "other" | "";

export function NewHatchButton({
  sensors,
  showProTrialBanner = false,
}: {
  sensors: SensorOption[];
  showProTrialBanner?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [species, setSpecies] = useState("chicken");
  const [eggCount, setEggCount] = useState<number>(24);
  const [startDate, setStartDate] = useState(todayIso());
  const [expectedHatch, setExpectedHatch] = useState<string | null>(null);
  const [sensorIds, setSensorIds] = useState<string[]>([]);
  const [ambientSensorId, setAmbientSensorId] = useState<string>("");
  const [notes, setNotes] = useState("");

  // Split sensor list: ambient-flagged ones appear in their own dropdown;
  // incubator sensors in the multi-select. Prevents users accidentally
  // linking a room sensor as an incubator sensor (which would poison the
  // temp/humidity averages).
  const incubatorSensors = useMemo(
    () => sensors.filter((s) => !s.isAmbient),
    [sensors],
  );
  const ambientSensors = useMemo(
    () => sensors.filter((s) => s.isAmbient),
    [sensors],
  );

  // New metadata
  const [breed, setBreed] = useState("");
  const [eggSource, setEggSource] = useState<EggSource>("");
  const [eggSourceDetail, setEggSourceDetail] = useState("");
  const [incubatorModel, setIncubatorModel] = useState("");

  // Incubation targets
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [targetTemp, setTargetTemp] = useState<number>(37.5);
  const [humTurnMin, setHumTurnMin] = useState<number>(50);
  const [humTurnMax, setHumTurnMax] = useState<number>(55);
  const [humLockMin, setHumLockMin] = useState<number>(65);
  const [humLockMax, setHumLockMax] = useState<number>(75);
  const [targetsEdited, setTargetsEdited] = useState(false);

  const preset = useMemo(() => speciesPreset(species), [species]);
  const computedExpected = addDays(startDate, preset.days);
  const effectiveExpected = expectedHatch ?? computedExpected;
  const lockdownDate = addDays(startDate, preset.lockdown);

  // When species changes, refill target fields from the preset — unless the
  // user has manually edited them (then prompt first).
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
    setExpectedHatch(null);
  }

  function toggleSensor(id: string) {
    setSensorIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function reset() {
    setName("");
    setSpecies("chicken");
    setEggCount(24);
    setStartDate(todayIso());
    setExpectedHatch(null);
    setSensorIds([]);
    setAmbientSensorId("");
    setNotes("");
    setBreed("");
    setEggSource("");
    setEggSourceDetail("");
    setIncubatorModel("");
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
    startTransition(async () => {
      const r = await createHatch({
        name,
        species,
        egg_count: eggCount,
        start_date: startDate,
        expected_hatch_date: effectiveExpected,
        sensor_ids: sensorIds,
        ambient_sensor_id: ambientSensorId || null,
        notes,
        breed: breed || null,
        egg_source: eggSource || null,
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
      if (r.error) {
        setError(r.error);
        return;
      }
      close();
      if (r.id) router.push(`/dashboard/hatches/${r.id}`);
      else router.refresh();
    });
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-primary">
        + New hatch
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={close}
        >
          <div
            className="w-full max-w-xl max-h-[90vh] overflow-y-auto card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Start a new hatch</h2>
              <button
                onClick={close}
                className="text-white/50 hover:text-white"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {showProTrialBanner && (
              <div className="mt-3 rounded-md border border-light/40 bg-light/10 p-3 text-xs text-light">
                Your first hatch includes full Pro features — hatch history
                graphs, PDF reports, and email notifications — at no charge.
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              {/* --- Hatch details --- */}
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
                    autoFocus
                    className="input"
                    placeholder="e.g. Sussex batch 1"
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
                      Breed (optional)
                    </label>
                    <input
                      className="input"
                      placeholder="e.g. ISA Brown, Pekin, Coturnix"
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
                      Incubator (optional)
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
                    Egg source (optional)
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

              {/* --- Dates --- */}
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
                        setExpectedHatch(null);
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
                      onChange={(e) => setExpectedHatch(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-white/40">
                      Auto-calc from species — override if your breed hatches
                      differently.
                    </p>
                  </div>
                </div>
                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-white/60">
                  <div className="flex justify-between">
                    <span>Lockdown</span>
                    <span className="tabular-nums">
                      {formatDate(lockdownDate)} · day {preset.lockdown}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span>Expected hatch</span>
                    <span className="tabular-nums">
                      {formatDate(effectiveExpected)} · day {preset.days}
                    </span>
                  </div>
                </div>
              </section>

              {/* --- Incubation targets (collapsible) --- */}
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
                    <p className="text-xs text-white/50">
                      Pre-filled from species. Override if you run a different
                      schedule.
                    </p>
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
                          min={0}
                          max={100}
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
                          min={0}
                          max={100}
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
                          min={0}
                          max={100}
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
                          min={0}
                          max={100}
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

              {/* --- Incubator sensors --- */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">
                  Incubator sensors (optional)
                </h3>
                {incubatorSensors.length === 0 ? (
                  <p className="text-sm text-white/50">
                    No incubator sensors registered yet.
                  </p>
                ) : (
                  <div className="space-y-1 rounded-lg border border-white/10 bg-black/20 p-2">
                    {incubatorSensors.map((s) => {
                      const checked = sensorIds.includes(s.id);
                      return (
                        <label
                          key={s.id}
                          className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm transition ${
                            checked
                              ? "bg-light/10 text-white"
                              : "text-white/70 hover:bg-white/5"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-light"
                            checked={checked}
                            onChange={() => toggleSensor(s.id)}
                          />
                          <span className="truncate">{s.label}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-white/40">
                  Tick each sensor inside the incubator for this hatch.
                </p>
              </section>

              {/* --- Ambient / room sensor --- */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-amber-300/70">
                  Room sensor (optional)
                </h3>
                {ambientSensors.length === 0 ? (
                  <p className="text-sm text-white/50">
                    No ambient sensors yet. Flag any sensor as{" "}
                    <strong className="text-white">"ambient"</strong> in its
                    settings page to make it available here.
                  </p>
                ) : (
                  <select
                    className="input"
                    value={ambientSensorId}
                    onChange={(e) => setAmbientSensorId(e.target.value)}
                  >
                    <option value="">No room sensor</option>
                    {ambientSensors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-xs text-white/40">
                  A sensor measuring the room air around the incubator. Shown
                  as context on reports (NOT mixed into incubator averages).
                  Cold or humid rooms are a major cause of struggling hatches —
                  tracking the room explains what the incubator is fighting.
                </p>
              </section>

              {/* --- Notes --- */}
              <div>
                <label className="mb-1 block text-xs font-medium text-white/70">
                  Notes (optional)
                </label>
                <textarea
                  className="input min-h-[80px]"
                  placeholder="Anything worth remembering…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  className="btn-primary flex-1"
                  disabled={pending}
                >
                  {pending ? "Starting…" : "Start hatch"}
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
