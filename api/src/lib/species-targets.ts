// Per-species incubation targets used by the Primus dashboard endpoint.
// Mirrors portal/lib/hatches/species.ts — keep the two in sync.

export type SpeciesTarget = {
  label: string;
  days: number;
  lockdown: number;
  targetTemp: number;
  tempMinC: number;          // derived: targetTemp - 0.25 (alert band)
  tempMaxC: number;          // derived: targetTemp + 0.25
  humTurningMin: number;
  humTurningMax: number;
  humLockdownMin: number;
  humLockdownMax: number;
};

function span(t: number): { min: number; max: number } {
  return {
    min: Math.round((t - 0.25) * 10) / 10,
    max: Math.round((t + 0.25) * 10) / 10,
  };
}

function build(
  label: string,
  days: number,
  lockdown: number,
  targetTemp: number,
  humTurningMin: number,
  humTurningMax: number,
  humLockdownMin: number,
  humLockdownMax: number,
): SpeciesTarget {
  const s = span(targetTemp);
  return {
    label,
    days,
    lockdown,
    targetTemp,
    tempMinC: s.min,
    tempMaxC: s.max,
    humTurningMin,
    humTurningMax,
    humLockdownMin,
    humLockdownMax,
  };
}

export const SPECIES_TARGETS: Record<string, SpeciesTarget> = {
  chicken:   build("Chicken",          21, 18, 37.5, 50, 55, 65, 75),
  duck:      build("Duck (Pekin)",     28, 25, 37.5, 55, 58, 65, 75),
  muscovy:   build("Duck (Muscovy)",   35, 32, 37.5, 55, 60, 65, 75),
  goose:     build("Goose",            30, 27, 37.3, 55, 65, 75, 85),
  turkey:    build("Turkey",           28, 25, 37.5, 55, 60, 65, 75),
  quail_jap: build("Quail (Japanese)", 17, 14, 37.5, 45, 55, 65, 70),
  quail_bw:  build("Quail (Bobwhite)", 23, 20, 37.5, 45, 55, 65, 70),
  pheasant:  build("Pheasant",         24, 21, 37.5, 55, 60, 65, 70),
  guinea:    build("Guinea fowl",      28, 25, 37.5, 50, 55, 65, 70),
  peafowl:   build("Peafowl",          28, 25, 37.3, 55, 60, 65, 75),
  emu:       build("Emu",              52, 49, 36.0, 20, 30, 38, 42),
  other:     build("Other / custom",   21, 18, 37.5, 50, 55, 65, 70),
};

export function speciesTarget(value: string | null | undefined): SpeciesTarget {
  return SPECIES_TARGETS[value ?? "other"] ?? SPECIES_TARGETS.other;
}

export type Phase = "turning" | "lockdown" | "hatch" | "overdue";

export function phaseForDay(day: number, target: SpeciesTarget): Phase {
  if (day < target.lockdown) return "turning";
  if (day < target.days) return "lockdown";
  if (day === target.days) return "hatch";
  return "overdue";
}

export function humidityTargetForPhase(
  target: SpeciesTarget,
  phase: Phase,
): { min: number; max: number } {
  if (phase === "turning") {
    return { min: target.humTurningMin, max: target.humTurningMax };
  }
  return { min: target.humLockdownMin, max: target.humLockdownMax };
}
