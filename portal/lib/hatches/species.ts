// Species incubation presets — days from set to expected hatch, lockdown day,
// and target temperature + humidity ranges for the turning and lockdown
// phases. Humidity ranges are stored as min/max numerics so alerts and
// stability scoring can compute against them. Display them in UI as
// `${min}–${max}%`.
//
// These are typical industry values; customers can override per hatch.

export type SpeciesPreset = {
  value: string;
  label: string;
  days: number;      // set → expected hatch
  lockdown: number;  // set → lockdown starts
  targetTemp: number;      // °C
  humTurnMin: number;      // % RH
  humTurnMax: number;
  humLockMin: number;
  humLockMax: number;
};

export const SPECIES_PRESETS: SpeciesPreset[] = [
  { value: "chicken",   label: "Chicken",              days: 21, lockdown: 18, targetTemp: 37.5, humTurnMin: 50, humTurnMax: 55, humLockMin: 65, humLockMax: 75 },
  { value: "duck",      label: "Duck (Pekin)",         days: 28, lockdown: 25, targetTemp: 37.5, humTurnMin: 55, humTurnMax: 58, humLockMin: 65, humLockMax: 75 },
  { value: "muscovy",   label: "Duck (Muscovy)",       days: 35, lockdown: 32, targetTemp: 37.5, humTurnMin: 55, humTurnMax: 60, humLockMin: 65, humLockMax: 75 },
  { value: "goose",     label: "Goose",                days: 30, lockdown: 27, targetTemp: 37.3, humTurnMin: 55, humTurnMax: 65, humLockMin: 75, humLockMax: 85 },
  { value: "turkey",    label: "Turkey",               days: 28, lockdown: 25, targetTemp: 37.5, humTurnMin: 55, humTurnMax: 60, humLockMin: 65, humLockMax: 75 },
  { value: "quail_jap", label: "Quail (Japanese)",     days: 17, lockdown: 14, targetTemp: 37.5, humTurnMin: 45, humTurnMax: 55, humLockMin: 65, humLockMax: 70 },
  { value: "quail_bw",  label: "Quail (Bobwhite)",     days: 23, lockdown: 20, targetTemp: 37.5, humTurnMin: 45, humTurnMax: 55, humLockMin: 65, humLockMax: 70 },
  { value: "pheasant",  label: "Pheasant",             days: 24, lockdown: 21, targetTemp: 37.5, humTurnMin: 55, humTurnMax: 60, humLockMin: 65, humLockMax: 70 },
  { value: "guinea",    label: "Guinea fowl",          days: 28, lockdown: 25, targetTemp: 37.5, humTurnMin: 50, humTurnMax: 55, humLockMin: 65, humLockMax: 70 },
  { value: "peafowl",   label: "Peafowl",              days: 28, lockdown: 25, targetTemp: 37.3, humTurnMin: 55, humTurnMax: 60, humLockMin: 65, humLockMax: 75 },
  { value: "emu",       label: "Emu",                  days: 52, lockdown: 49, targetTemp: 36.0, humTurnMin: 20, humTurnMax: 30, humLockMin: 38, humLockMax: 42 },
  { value: "other",     label: "Other / custom",       days: 21, lockdown: 18, targetTemp: 37.5, humTurnMin: 50, humTurnMax: 55, humLockMin: 65, humLockMax: 70 },
];

export function speciesPreset(value: string | null | undefined): SpeciesPreset {
  return (
    SPECIES_PRESETS.find((p) => p.value === value) ??
    SPECIES_PRESETS[SPECIES_PRESETS.length - 1]
  );
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().substring(0, 10);
}

export function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso + "T00:00:00Z").getTime();
  const b = new Date(bIso + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

export function todayIso(): string {
  return new Date().toISOString().substring(0, 10);
}
