"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordHatchResults } from "../actions";

type Results = {
  fertile_count: number | null;
  hatched_count: number | null;
  died_in_shell: number | null;
  pipped_not_hatched: number | null;
  early_deaths: number | null;
};

export function CompletedResults({
  hatchId,
  eggCount,
  initial,
}: {
  hatchId: string;
  eggCount: number;
  initial: Results;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  const initialStr = {
    fertile: initial.fertile_count?.toString() ?? "",
    hatched: initial.hatched_count?.toString() ?? "",
    diedInShell: initial.died_in_shell?.toString() ?? "",
    pipped: initial.pipped_not_hatched?.toString() ?? "",
    early: initial.early_deaths?.toString() ?? "",
  };

  const [fields, setFields] = useState(initialStr);

  const dirty = (Object.keys(initialStr) as (keyof typeof initialStr)[]).some(
    (k) => fields[k] !== initialStr[k],
  );

  const parsed = useMemo(() => {
    const parseOpt = (s: string) => (s === "" ? null : parseInt(s, 10));
    return {
      fertile: parseOpt(fields.fertile),
      hatched: parseOpt(fields.hatched),
      diedInShell: parseOpt(fields.diedInShell),
      pipped: parseOpt(fields.pipped),
      early: parseOpt(fields.early),
    };
  }, [fields]);

  const rates = useMemo(() => {
    const { fertile, hatched } = parsed;
    return {
      rate: hatched != null && eggCount > 0 ? hatched / eggCount : null,
      fertility: fertile != null && eggCount > 0 ? fertile / eggCount : null,
      ofFertile:
        hatched != null && fertile != null && fertile > 0
          ? hatched / fertile
          : null,
    };
  }, [parsed, eggCount]);

  function handleSave() {
    if (parsed.hatched == null || !Number.isInteger(parsed.hatched) || parsed.hatched < 0) {
      setMsg({ tone: "err", text: "Hatched count must be 0 or more." });
      return;
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (v != null && (!Number.isInteger(v) || v < 0)) {
        setMsg({ tone: "err", text: `${k} must be a whole number.` });
        return;
      }
    }
    setMsg(null);
    startTransition(async () => {
      const r = await recordHatchResults(hatchId, {
        hatched_count: parsed.hatched!,
        fertile_count: parsed.fertile,
        died_in_shell: parsed.diedInShell,
        pipped_not_hatched: parsed.pipped,
        early_deaths: parsed.early,
      });
      if (r.error) setMsg({ tone: "err", text: r.error });
      else {
        setMsg({ tone: "ok", text: "Saved." });
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-4 text-center">
        <Stat label="Hatched" value={`${parsed.hatched ?? 0}`} />
        <Stat label="Set" value={`${eggCount}`} />
        <Stat
          label="Rate"
          value={rates.rate != null ? `${Math.round(rates.rate * 100)}%` : "—"}
        />
      </div>

      <div className="border-t border-white/5 pt-4">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-white/40">
          Breakdown
        </h3>
        <div className="space-y-3">
          <EditableRow
            label="Fertile (from candling)"
            value={fields.fertile}
            onChange={(v) => setFields({ ...fields, fertile: v })}
            pctOf={eggCount}
            pctLabel="of set"
          />
          <EditableRow
            label="Hatched alive"
            value={fields.hatched}
            onChange={(v) => setFields({ ...fields, hatched: v })}
            pctOf={eggCount}
            pctLabel="of set"
          />
          <EditableRow
            label="Died in shell"
            value={fields.diedInShell}
            onChange={(v) => setFields({ ...fields, diedInShell: v })}
            pctOf={eggCount}
          />
          <EditableRow
            label="Pipped, didn't hatch"
            value={fields.pipped}
            onChange={(v) => setFields({ ...fields, pipped: v })}
            pctOf={eggCount}
          />
          <EditableRow
            label="Early deaths / quitters"
            value={fields.early}
            onChange={(v) => setFields({ ...fields, early: v })}
            pctOf={eggCount}
          />
        </div>
      </div>

      <div className="border-t border-white/5 pt-4 text-sm">
        <div className="flex justify-between text-white/60">
          <span>Fertility rate</span>
          <span className="tabular-nums text-white">
            {rates.fertility != null
              ? `${(rates.fertility * 100).toFixed(1)}%`
              : "—"}
          </span>
        </div>
        <div className="mt-1 flex justify-between text-white/60">
          <span>Hatch of fertile</span>
          <span className="tabular-nums text-white">
            {rates.ofFertile != null
              ? `${(rates.ofFertile * 100).toFixed(1)}%`
              : "—"}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="btn-primary"
          disabled={pending || !dirty}
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
        {dirty && !pending && (
          <button
            onClick={() => {
              setFields(initialStr);
              setMsg(null);
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
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function EditableRow({
  label,
  value,
  onChange,
  pctOf,
  pctLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  pctOf?: number;
  pctLabel?: string;
}) {
  const n = value === "" ? null : parseInt(value, 10);
  const pct =
    n != null && Number.isFinite(n) && pctOf && pctOf > 0
      ? Math.round((n / pctOf) * 100)
      : null;
  return (
    <div className="flex items-center gap-3">
      <label className="flex-1 text-sm text-white/70">{label}</label>
      <input
        type="number"
        min={0}
        step={1}
        className="input w-24 text-right tabular-nums"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
      />
      <span className="w-20 text-right text-xs text-white/50 tabular-nums">
        {pct != null ? `${pct}% ${pctLabel ?? ""}`.trim() : ""}
      </span>
    </div>
  );
}
