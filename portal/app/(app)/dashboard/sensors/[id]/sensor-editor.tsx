"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteSensor, unclaimSensor, updateSensor } from "../actions";

export function SensorEditor({
  sensorId,
  initialName,
  initialModel,
  initialIsAmbient,
}: {
  sensorId: string;
  initialName: string | null;
  initialModel: "pro" | "lite";
  initialIsAmbient: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  const [model, setModel] = useState<"pro" | "lite">(initialModel);
  const [isAmbient, setIsAmbient] = useState(initialIsAmbient);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  const dirty =
    (name || "") !== (initialName ?? "") ||
    model !== initialModel ||
    isAmbient !== initialIsAmbient;

  function handleSave() {
    setMsg(null);
    startTransition(async () => {
      const r = await updateSensor(sensorId, {
        name,
        model,
        is_ambient: isAmbient,
      });
      if (r.error) setMsg({ tone: "err", text: r.error });
      else setMsg({ tone: "ok", text: "Saved." });
    });
  }

  function handleRemove() {
    if (
      !confirm(
        "Remove this sensor from your dashboard?\n\n" +
          "Its reading history stays safe, and if your Primus still sees it " +
          "over Bluetooth, it'll reappear in the detected-sensors list so you " +
          "can re-add it.",
      )
    )
      return;
    startTransition(async () => {
      const r = await unclaimSensor(sensorId);
      if (r && "error" in r && r.error) {
        setMsg({ tone: "err", text: r.error });
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    });
  }

  function handleDeleteForever() {
    if (
      !confirm(
        "Permanently delete this sensor and its reading history? This cannot be undone.",
      )
    )
      return;
    startTransition(async () => {
      const r = await deleteSensor(sensorId);
      if (r && "error" in r && r.error) {
        setMsg({ tone: "err", text: r.error });
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    });
  }

  return (
    <div className="card space-y-5">
      <h2 className="text-lg font-semibold">Settings</h2>

      <div>
        <label className="mb-1 block text-xs font-medium text-white/70">
          Name
        </label>
        <input
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

      <div>
        <label className="mb-2 block text-xs font-medium text-white/70">
          Placement
        </label>
        <div className="grid grid-cols-2 gap-2">
          <PlacementRadio
            label="In the incubator"
            sub="Measures conditions inside the incubator. Drives the hatch's temp/humidity averages."
            selected={!isAmbient}
            onSelect={() => setIsAmbient(false)}
            tone="default"
          />
          <PlacementRadio
            label="In the room (ambient)"
            sub="Measures the room around the incubator. Shown as context on hatch reports — not mixed into incubator averages."
            selected={isAmbient}
            onSelect={() => setIsAmbient(true)}
            tone="amber"
          />
        </div>
      </div>

      <div>
        <button
          onClick={handleSave}
          className="btn-primary"
          disabled={pending || !dirty}
        >
          {pending ? "Saving…" : "Save changes"}
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

      <div className="space-y-3 border-t border-white/5 pt-4">
        <div>
          <p className="text-sm font-medium">Remove from dashboard</p>
          <p className="mt-1 text-xs text-white/50">
            Keeps your reading history. If the sensor is still in Bluetooth
            range, it'll reappear so you can re-add it.
          </p>
          <button
            onClick={handleRemove}
            className="btn-ghost mt-3"
            disabled={pending}
          >
            Remove sensor
          </button>
        </div>

        <div className="border-t border-white/5 pt-3">
          <p className="text-sm font-medium text-red-300">Delete permanently</p>
          <p className="mt-1 text-xs text-white/50">
            Wipes all reading history for this sensor. Use when you no longer
            own the sensor at all.
          </p>
          <button
            onClick={handleDeleteForever}
            className="btn-ghost mt-3 border-red-500/30 text-red-300 hover:bg-red-500/10"
            disabled={pending}
          >
            Delete permanently
          </button>
        </div>
      </div>
    </div>
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

function PlacementRadio({
  label,
  sub,
  selected,
  onSelect,
  tone,
}: {
  label: string;
  sub: string;
  selected: boolean;
  onSelect: () => void;
  tone: "default" | "amber";
}) {
  const selectedCls =
    tone === "amber"
      ? "border-amber-400/70 bg-amber-400/10"
      : "border-light/60 bg-light/10";
  const labelCls =
    selected && tone === "amber" ? "text-amber-200" : "text-white";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-lg border p-3 text-left transition ${
        selected ? selectedCls : "border-white/10 hover:border-white/20"
      }`}
    >
      <div className={`text-sm font-semibold ${labelCls}`}>{label}</div>
      <div className="mt-0.5 text-xs text-white/50">{sub}</div>
    </button>
  );
}
