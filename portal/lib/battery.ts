// KBeacon K23 / S5 sensors run on a CR2477 / CR2450 3V lithium cell.
// Useful range is roughly 3.0V fresh → 2.4V end-of-life. Below 2.4V the
// radio becomes unreliable and the sensor should be replaced.

const BATTERY_FULL_MV = 3000;
const BATTERY_EMPTY_MV = 2400;

export type BatteryStatus = {
  percent: number;              // 0–100
  label: "Good" | "OK" | "Low" | "Replace soon";
  tone: "good" | "ok" | "low" | "critical";
};

export function batteryStatus(
  mv: number | null | undefined,
): BatteryStatus | null {
  if (mv == null || !Number.isFinite(mv)) return null;

  const clamped = Math.max(
    BATTERY_EMPTY_MV,
    Math.min(BATTERY_FULL_MV, mv),
  );
  const percent = Math.round(
    ((clamped - BATTERY_EMPTY_MV) / (BATTERY_FULL_MV - BATTERY_EMPTY_MV)) *
      100,
  );

  if (percent >= 75) return { percent, label: "Good", tone: "good" };
  if (percent >= 40) return { percent, label: "OK", tone: "ok" };
  if (percent >= 15) return { percent, label: "Low", tone: "low" };
  return { percent, label: "Replace soon", tone: "critical" };
}

export function batteryToneClass(tone: BatteryStatus["tone"]): string {
  switch (tone) {
    case "good":
      return "text-light";
    case "ok":
      return "text-white";
    case "low":
      return "text-amber-300";
    case "critical":
      return "text-red-300";
  }
}
