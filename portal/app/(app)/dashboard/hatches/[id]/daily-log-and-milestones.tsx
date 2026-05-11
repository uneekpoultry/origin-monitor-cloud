"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addDays,
  type SpeciesPreset,
} from "@/lib/hatches/species";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  addMilestone,
  deleteMilestone,
  upsertDailyLog,
  type MilestoneType,
} from "../actions";

export type DailyAggregate = {
  day: number;
  dateIso: string;
  tempAvg: number | null;
  tempMin: number | null;
  tempMax: number | null;
  humAvg: number | null;
  humMin: number | null;
  humMax: number | null;
  readings: number;
  // Optional room/ambient context. Computed from a separate ambient sensor
  // (if linked to the hatch) — NOT mixed into the incubator averages above.
  // Rendered with amber accent so users can visually distinguish room vs
  // incubator readings at a glance.
  ambientTempAvg?: number | null;
  ambientHumAvg?: number | null;
};

export type AmbientSummary = {
  name: string;
  latest: {
    temperature: number | null;
    humidity: number | null;
    recorded_at: string;
  } | null;
};

export type DailyLogEntry = {
  day: number;
  turning_count: number | null;
  notes: string | null;
};

export type MilestoneRow = {
  id: string;
  milestone_type: MilestoneType;
  occurred_at: string;
  day_number: number | null;
  fertile_count: number | null;
  removed_count: number | null;
  eggs_remaining: number | null;
  turning_count: number | null;
  notes: string | null;
};

type Props = {
  hatchId: string;
  eggCount: number;
  preset: SpeciesPreset;
  dailyAggregates: DailyAggregate[];
  dailyLog: DailyLogEntry[];
  milestones: MilestoneRow[];
  targetTemp: number;
  ambient?: AmbientSummary | null;
};

export function DailyLogAndMilestones(props: Props) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<"log" | "milestones">("log");

  return (
    <section className="card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between"
      >
        <h2 className="text-lg font-semibold">Daily log &amp; milestones</h2>
        <span className="text-white/40">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <>
          <div className="mt-4 flex gap-1 border-b border-white/5">
            <TabButton
              active={tab === "log"}
              onClick={() => setTab("log")}
              label="Daily log"
            />
            <TabButton
              active={tab === "milestones"}
              onClick={() => setTab("milestones")}
              label="Milestones"
            />
          </div>

          <div className="mt-4">
            {tab === "log" ? <DailyLogTab {...props} /> : <MilestonesTab {...props} />}
          </div>
        </>
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-4 py-2 text-sm font-medium transition ${
        active ? "text-white" : "text-white/50 hover:text-white/80"
      }`}
    >
      {label}
      {active && (
        <span className="absolute inset-x-0 -bottom-[1px] h-[2px] bg-light" />
      )}
    </button>
  );
}

// -------- Daily log tab --------

export function DailyLogTab({
  hatchId,
  preset,
  dailyAggregates,
  dailyLog,
  targetTemp,
  ambient,
}: Props) {
  const hasAmbient = !!ambient;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  // Build current-values map from DB data
  const initial = useMemo(() => {
    const m = new Map<number, { turnings: string; notes: string }>();
    for (const e of dailyLog) {
      m.set(e.day, {
        turnings: e.turning_count?.toString() ?? "",
        notes: e.notes ?? "",
      });
    }
    return m;
  }, [dailyLog]);

  const [edits, setEdits] = useState<
    Map<number, { turnings: string; notes: string }>
  >(() => new Map(initial));

  const dirtyDays = useMemo(() => {
    const dirty: number[] = [];
    for (const [day, cur] of edits) {
      const orig = initial.get(day);
      const origT = orig?.turnings ?? "";
      const origN = orig?.notes ?? "";
      if (cur.turnings !== origT || cur.notes !== origN) dirty.push(day);
    }
    return dirty;
  }, [edits, initial]);

  function setCell(day: number, field: "turnings" | "notes", value: string) {
    setEdits((prev) => {
      const next = new Map(prev);
      const cur = next.get(day) ?? { turnings: "", notes: "" };
      next.set(day, { ...cur, [field]: value });
      return next;
    });
  }

  function flash(tone: "ok" | "err", text: string) {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 3000);
  }

  function handleSave() {
    if (dirtyDays.length === 0) return;
    startTransition(async () => {
      for (const day of dirtyDays) {
        const cur = edits.get(day)!;
        const turning = cur.turnings === "" ? null : parseInt(cur.turnings, 10);
        if (turning != null && (!Number.isInteger(turning) || turning < 0)) {
          flash("err", `Day ${day}: turnings must be a whole number.`);
          return;
        }
        const r = await upsertDailyLog(hatchId, day, {
          turning_count: turning,
          notes: cur.notes || null,
        });
        if (r.error) {
          flash("err", r.error);
          return;
        }
      }
      flash("ok", `Saved ${dirtyDays.length} day${dirtyDays.length === 1 ? "" : "s"}.`);
      router.refresh();
    });
  }

  return (
    <>
      {hasAmbient && ambient && (
        <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200/90">
          <span className="font-semibold">Room context:</span>{" "}
          {ambient.name}
          {ambient.latest && ambient.latest.temperature != null && (
            <span className="ml-2 text-amber-100">
              · now {ambient.latest.temperature.toFixed(1)}°C
              {ambient.latest.humidity != null &&
                ` / ${ambient.latest.humidity.toFixed(0)}%`}
            </span>
          )}
          <span className="ml-2 text-white/40">
            (room readings are shown for context only — not mixed into
            incubator averages)
          </span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
            <tr>
              <th className="px-2 py-2">Day</th>
              <th className="px-2 py-2">Date</th>
              <th className="px-2 py-2">Temp avg</th>
              <th className="px-2 py-2">min</th>
              <th className="px-2 py-2">max</th>
              <th className="px-2 py-2">Humid avg</th>
              <th className="px-2 py-2">min</th>
              <th className="px-2 py-2">max</th>
              {hasAmbient && (
                <>
                  <th className="px-2 py-2 text-amber-300/80">Room °C</th>
                  <th className="px-2 py-2 text-amber-300/80">Room %RH</th>
                </>
              )}
              <th className="px-2 py-2">Turnings</th>
              <th className="px-2 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {dailyAggregates.map((d) => {
              const cur = edits.get(d.day) ?? { turnings: "", notes: "" };
              const isLockdown = d.day === preset.lockdown;
              const isHatch = d.day === preset.days;
              const rowClass = isLockdown
                ? "bg-[rgba(251,241,218,0.06)]"
                : isHatch
                  ? "bg-[rgba(234,246,220,0.06)]"
                  : "";
              return (
                <tr
                  key={d.day}
                  className={`border-t border-white/5 ${rowClass}`}
                >
                  <td className="px-2 py-2 tabular-nums font-semibold">
                    {d.day}
                    {isLockdown && (
                      <span className="ml-1 text-[10px] text-bronze text-white/60">
                        · lockdown
                      </span>
                    )}
                    {isHatch && (
                      <span className="ml-1 text-[10px] text-light">
                        · hatch
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-white/60">
                    {formatDate(d.dateIso)}
                  </td>
                  <td
                    className={`px-2 py-2 tabular-nums ${
                      d.tempAvg != null && outOfTemp(d.tempAvg, targetTemp)
                        ? "text-red-300"
                        : ""
                    }`}
                  >
                    {fmt(d.tempAvg, 2)}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-white/60">
                    {fmt(d.tempMin, 2)}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-white/60">
                    {fmt(d.tempMax, 2)}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {fmt(d.humAvg, 1)}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-white/60">
                    {fmt(d.humMin, 1)}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-white/60">
                    {fmt(d.humMax, 1)}
                  </td>
                  {hasAmbient && (
                    <>
                      <td className="px-2 py-2 tabular-nums text-amber-200/90">
                        {fmt(d.ambientTempAvg ?? null, 1)}
                      </td>
                      <td className="px-2 py-2 tabular-nums text-amber-200/90">
                        {fmt(d.ambientHumAvg ?? null, 0)}
                      </td>
                    </>
                  )}
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      min={0}
                      className="input w-16 text-center tabular-nums"
                      value={cur.turnings}
                      onChange={(e) =>
                        setCell(d.day, "turnings", e.target.value)
                      }
                      placeholder="—"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      type="text"
                      className="input w-full"
                      value={cur.notes}
                      onChange={(e) => setCell(d.day, "notes", e.target.value)}
                      placeholder="—"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={handleSave}
          className="btn-primary"
          disabled={pending || dirtyDays.length === 0}
        >
          {pending
            ? "Saving…"
            : dirtyDays.length > 0
              ? `Save ${dirtyDays.length} change${dirtyDays.length === 1 ? "" : "s"}`
              : "Save changes"}
        </button>
        {msg && (
          <span
            className={`text-sm ${msg.tone === "ok" ? "text-light" : "text-red-300"}`}
          >
            {msg.text}
          </span>
        )}
      </div>
    </>
  );
}

function outOfTemp(v: number, target: number): boolean {
  return Math.abs(v - target) > 0.5;
}

function fmt(v: number | null, decimals: number): string {
  if (v == null) return "—";
  return v.toFixed(decimals);
}

// -------- Milestones tab --------

export function MilestonesTab({
  hatchId,
  preset,
  milestones,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // Precomputed milestone dates (reference)
  // Lockdown and expected hatch are already on the hatch record and shown
  // elsewhere — we list Candling 1 (day 7 default), Candling 2 (day 14 default).
  const candling1Day = preset.lockdown >= 14 ? 7 : Math.ceil(preset.lockdown / 3);
  const candling2Day = preset.lockdown >= 18 ? 14 : Math.floor((preset.lockdown * 2) / 3);

  const logged = milestones.filter((m) => m.milestone_type !== "daily_log");

  function handleDelete(id: string) {
    if (!confirm("Delete this milestone?")) return;
    startTransition(async () => {
      await deleteMilestone(id, hatchId);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">
          Key dates
        </h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <KeyDateCard
            label={`Candling 1`}
            subLabel={`Day ${candling1Day} · early fertility check`}
          />
          <KeyDateCard
            label={`Candling 2`}
            subLabel={`Day ${candling2Day} · development check`}
          />
          <KeyDateCard
            label="Lockdown"
            subLabel={`Day ${preset.lockdown} · stop turning, raise humidity`}
          />
          <KeyDateCard
            label="Expected hatch"
            subLabel={`Day ${preset.days}`}
          />
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">
            Logged milestones ({logged.length})
          </h3>
          <button
            onClick={() => setOpen(true)}
            className="btn-ghost text-sm"
          >
            + Add milestone
          </button>
        </div>

        {logged.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">
            No milestones logged yet. Add one when you candle or notice anything
            worth remembering.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {logged.map((m) => (
              <MilestoneCard
                key={m.id}
                milestone={m}
                onDelete={() => handleDelete(m.id)}
                disabled={pending}
              />
            ))}
          </div>
        )}
      </div>

      {open && (
        <AddMilestoneModal
          hatchId={hatchId}
          defaultCandling1Day={candling1Day}
          defaultCandling2Day={candling2Day}
          defaultLockdownDay={preset.lockdown}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function KeyDateCard({
  label,
  subLabel,
}: {
  label: string;
  subLabel: string;
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="font-medium">{label}</div>
      <div className="mt-0.5 text-xs text-white/50">{subLabel}</div>
    </div>
  );
}

function MilestoneCard({
  milestone,
  onDelete,
  disabled,
}: {
  milestone: MilestoneRow;
  onDelete: () => void;
  disabled: boolean;
}) {
  const label = milestoneLabel(milestone.milestone_type);
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="rounded-full border border-light/30 bg-light/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-light">
            {label}
          </span>
          <div className="mt-1 text-sm text-white/60">
            {formatDateTime(milestone.occurred_at)}
            {milestone.day_number != null && (
              <span className="ml-2">· day {milestone.day_number}</span>
            )}
          </div>
        </div>
        <button
          onClick={onDelete}
          className="text-white/40 hover:text-red-300"
          aria-label="Delete milestone"
          disabled={disabled}
        >
          ✕
        </button>
      </div>

      {(milestone.fertile_count != null ||
        milestone.removed_count != null ||
        milestone.eggs_remaining != null) && (
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
          {milestone.fertile_count != null && (
            <div>
              <div className="text-white/40">Fertile</div>
              <div className="font-semibold tabular-nums">
                {milestone.fertile_count}
              </div>
            </div>
          )}
          {milestone.removed_count != null && (
            <div>
              <div className="text-white/40">Removed</div>
              <div className="font-semibold tabular-nums">
                {milestone.removed_count}
              </div>
            </div>
          )}
          {milestone.eggs_remaining != null && (
            <div>
              <div className="text-white/40">Remaining</div>
              <div className="font-semibold tabular-nums">
                {milestone.eggs_remaining}
              </div>
            </div>
          )}
        </div>
      )}

      {milestone.notes && (
        <p className="mt-2 text-sm text-white/70">{milestone.notes}</p>
      )}
    </div>
  );
}

function milestoneLabel(type: MilestoneType): string {
  switch (type) {
    case "candling_1":
      return "Candling 1";
    case "candling_2":
      return "Candling 2";
    case "lockdown":
      return "Lockdown";
    case "observation":
      return "Observation";
    case "custom":
      return "Custom";
    case "daily_log":
      return "Daily log";
  }
}

function AddMilestoneModal({
  hatchId,
  defaultCandling1Day,
  defaultCandling2Day,
  defaultLockdownDay,
  onClose,
  onSaved,
}: {
  hatchId: string;
  defaultCandling1Day: number;
  defaultCandling2Day: number;
  defaultLockdownDay: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<MilestoneType>("candling_1");
  const [dayNumber, setDayNumber] = useState<string>(
    defaultCandling1Day.toString(),
  );
  const [fertile, setFertile] = useState("");
  const [removed, setRemoved] = useState("");
  const [remaining, setRemaining] = useState("");
  const [notes, setNotes] = useState("");

  function onTypeChange(t: MilestoneType) {
    setType(t);
    if (t === "candling_1") setDayNumber(defaultCandling1Day.toString());
    else if (t === "candling_2") setDayNumber(defaultCandling2Day.toString());
    else if (t === "lockdown") setDayNumber(defaultLockdownDay.toString());
  }

  const isCandling = type === "candling_1" || type === "candling_2";
  const isLockdown = type === "lockdown";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parseOpt = (s: string) => (s === "" ? null : parseInt(s, 10));
    const payload = {
      hatch_id: hatchId,
      milestone_type: type,
      day_number: dayNumber === "" ? null : parseInt(dayNumber, 10),
      fertile_count: parseOpt(fertile),
      removed_count: parseOpt(removed),
      eggs_remaining: parseOpt(remaining),
      notes: notes || null,
    };
    for (const [k, v] of Object.entries(payload)) {
      if (
        typeof v === "number" &&
        k !== "day_number" &&
        (!Number.isInteger(v) || v < 0)
      ) {
        return setError(`${k.replace(/_/g, " ")} must be a whole number.`);
      }
    }

    startTransition(async () => {
      const r = await addMilestone(payload);
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
          <h2 className="text-lg font-semibold">Add milestone</h2>
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
              Type
            </label>
            <select
              className="input"
              value={type}
              onChange={(e) => onTypeChange(e.target.value as MilestoneType)}
            >
              <option value="candling_1">Candling 1</option>
              <option value="candling_2">Candling 2</option>
              <option value="lockdown">Lockdown check</option>
              <option value="observation">Observation</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Day number
            </label>
            <input
              type="number"
              min={1}
              className="input max-w-[120px]"
              value={dayNumber}
              onChange={(e) => setDayNumber(e.target.value)}
            />
          </div>

          {isCandling && (
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-white/70">
                  Fertile
                </label>
                <input
                  type="number"
                  min={0}
                  className="input"
                  value={fertile}
                  onChange={(e) => setFertile(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-white/70">
                  Removed
                </label>
                <input
                  type="number"
                  min={0}
                  className="input"
                  value={removed}
                  onChange={(e) => setRemoved(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-white/70">
                  Remaining
                </label>
                <input
                  type="number"
                  min={0}
                  className="input"
                  value={remaining}
                  onChange={(e) => setRemaining(e.target.value)}
                />
              </div>
            </div>
          )}

          {isLockdown && (
            <p className="text-xs text-white/50">
              Use notes to log humidity raised, turning stopped, egg positions, etc.
            </p>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Notes
            </label>
            <textarea
              className="input min-h-[80px]"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Observations, actions taken, anything notable…"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={pending}
            >
              {pending ? "Saving…" : "Add milestone"}
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
