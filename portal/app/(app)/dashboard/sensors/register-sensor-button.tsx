"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimSensor, registerSensor } from "./actions";

type PendingSensor = {
  id: string;
  serial: string;
  name: string | null;
  model: "pro" | "lite";
  latestTemp: number | null;
  latestHumidity: number | null;
};

export function RegisterSensorButton({
  pendingSensors = [],
}: {
  pendingSensors?: PendingSensor[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [selectedPendingId, setSelectedPendingId] = useState<string | null>(
    null,
  );
  const [serial, setSerial] = useState("");
  const [model, setModel] = useState<"pro" | "lite">("pro");
  const [name, setName] = useState("");
  const [manualMode, setManualMode] = useState(false);

  function reset() {
    setSelectedPendingId(null);
    setSerial("");
    setModel("pro");
    setName("");
    setManualMode(false);
    setError(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  function pickPending(s: PendingSensor) {
    setSelectedPendingId(s.id);
    setSerial(s.serial);
    setModel(s.model);
    setName(s.name ?? "");
    setManualMode(false);
    setError(null);
  }

  function startManual() {
    setSelectedPendingId(null);
    setSerial("");
    setModel("pro");
    setName("");
    setManualMode(true);
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      return setError("Give the sensor a name.");
    }

    startTransition(async () => {
      const r = selectedPendingId
        ? await claimSensor(selectedPendingId, { name, model })
        : await registerSensor({
            serial_number: serial,
            model,
            name,
          });
      if (r.error) setError(r.error);
      else {
        close();
        router.refresh();
      }
    });
  }

  const inFormStep = selectedPendingId !== null || manualMode;
  const canOpenList = pendingSensors.length > 0 && !inFormStep;

  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-primary">
        + Add sensor
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={close}
        >
          <div
            className="w-full max-w-md card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Add sensor</h2>
              <button
                onClick={close}
                className="text-white/50 hover:text-white"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* Step 1 — pick a detected sensor or enter manually */}
            {canOpenList && (
              <>
                <p className="mt-1 text-sm text-white/60">
                  Your Primus has detected these sensors. Click one to register
                  it — you can keep the existing name or change it.
                </p>
                <div className="mt-4 space-y-2">
                  {pendingSensors.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => pickPending(s)}
                      className="w-full rounded-lg border border-white/10 p-3 text-left transition hover:border-light/40 hover:bg-white/[0.03]"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-semibold">
                          {s.name || s.serial}
                        </span>
                        <span className="rounded-full border border-light/30 bg-light/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-light">
                          {s.model === "pro" ? "Pro" : "Lite"}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-xs text-white/40">
                        {s.serial}
                      </div>
                      <div className="mt-1 text-xs text-white/50">
                        {s.latestTemp != null
                          ? `${s.latestTemp.toFixed(1)}°C`
                          : "—"}
                        {" · "}
                        {s.latestHumidity != null
                          ? `${s.latestHumidity.toFixed(0)}%`
                          : "—"}
                      </div>
                    </button>
                  ))}
                </div>

                <div className="relative my-4 text-center text-xs text-white/40">
                  <span className="relative z-10 bg-ink px-3">or</span>
                  <span className="absolute inset-x-0 top-1/2 -z-0 h-px bg-white/10" />
                </div>

                <button onClick={startManual} className="btn-ghost w-full">
                  Enter serial number manually
                </button>
              </>
            )}

            {/* No pending + just opened → go straight to manual */}
            {!canOpenList && !inFormStep && (
              <>
                <p className="mt-1 text-sm text-white/60">
                  Your Primus hasn't detected any new sensors. Enter the serial
                  number printed on the back of the sensor to register it
                  manually.
                </p>
                <button
                  onClick={startManual}
                  className="btn-primary mt-4 w-full"
                >
                  Enter serial manually
                </button>
              </>
            )}

            {/* Step 2 — the form */}
            {inFormStep && (
              <>
                <p className="mt-1 text-sm text-white/60">
                  {selectedPendingId
                    ? "Check the name below and change it if you want."
                    : "Enter the serial from the back of the sensor."}
                </p>

                <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-white/70">
                      Serial number
                    </label>
                    <input
                      required
                      readOnly={!!selectedPendingId}
                      className={`input font-mono ${selectedPendingId ? "opacity-70" : ""}`}
                      value={serial}
                      placeholder="e.g. AC:23:3F:EE:11:22"
                      onChange={(e) => setSerial(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-medium text-white/70">
                      Name
                    </label>
                    <input
                      required
                      autoFocus
                      className="input"
                      value={name}
                      placeholder="e.g. Main incubator"
                      onChange={(e) => setName(e.target.value)}
                    />
                    <p className="mt-1 text-xs text-white/40">
                      This name syncs to the app and your Primus.
                    </p>
                  </div>

                  <div>
                    <label className="mb-2 block text-xs font-medium text-white/70">
                      Model
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <ModelRadio
                        label="Origin Pro"
                        sub="IP67, factory calibrated"
                        selected={model === "pro"}
                        onSelect={() => setModel("pro")}
                      />
                      <ModelRadio
                        label="Origin Lite"
                        sub="Compact, uncalibrated"
                        selected={model === "lite"}
                        onSelect={() => setModel("lite")}
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
                    {(pendingSensors.length > 0 || manualMode) && (
                      <button
                        type="button"
                        onClick={reset}
                        className="btn-ghost"
                      >
                        Back
                      </button>
                    )}
                  </div>
                </form>
              </>
            )}
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
