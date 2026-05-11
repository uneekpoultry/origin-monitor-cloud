"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateHatch } from "../actions";

type SensorOption = { id: string; label: string; isAmbient: boolean };

export function EditSensorsButton({
  hatchId,
  allSensors,
  initialLinkedIds,
  initialAmbientSensorId,
}: {
  hatchId: string;
  allSensors: SensorOption[];
  initialLinkedIds: string[];
  initialAmbientSensorId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] =
    useState<string[]>(initialLinkedIds);
  const [ambientSensorId, setAmbientSensorId] = useState<string>(
    initialAmbientSensorId ?? "",
  );

  // Split: incubator sensors in multi-select, ambient sensors in dropdown.
  // Prevents a room sensor being accidentally added as an incubator sensor
  // (which would poison the temp/humidity averages for this hatch).
  const incubatorSensors = useMemo(
    () => allSensors.filter((s) => !s.isAmbient),
    [allSensors],
  );
  const ambientSensors = useMemo(
    () => allSensors.filter((s) => s.isAmbient),
    [allSensors],
  );

  function toggle(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function close() {
    setOpen(false);
    setSelectedIds(initialLinkedIds);
    setAmbientSensorId(initialAmbientSensorId ?? "");
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await updateHatch(hatchId, {
        sensor_ids: selectedIds,
        ambient_sensor_id: ambientSensorId || null,
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
        Edit sensors
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={close}
        >
          <div
            className="w-full max-w-md card max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Linked sensors</h2>
              <button
                onClick={close}
                className="text-white/50 hover:text-white"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-sm text-white/60">
              Tick the sensors inside the incubator, and optionally pick a
              room sensor for ambient context. Changes apply right away.
            </p>

            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              {/* Incubator sensors */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">
                  Incubator sensors
                </h3>
                {incubatorSensors.length === 0 ? (
                  <p className="text-sm text-white/50">
                    No incubator sensors registered yet.
                  </p>
                ) : (
                  <div className="space-y-1 rounded-lg border border-white/10 bg-black/20 p-2">
                    {incubatorSensors.map((s) => {
                      const checked = selectedIds.includes(s.id);
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
                            onChange={() => toggle(s.id)}
                          />
                          <span className="truncate">{s.label}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Ambient / room sensor */}
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
                  Shown as context on reports (not mixed into incubator
                  averages). A cold or humid room is a major cause of
                  struggling hatches.
                </p>
              </section>

              {error && <p className="text-sm text-red-400">{error}</p>}

              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  className="btn-primary flex-1"
                  disabled={pending}
                >
                  {pending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={close}
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
