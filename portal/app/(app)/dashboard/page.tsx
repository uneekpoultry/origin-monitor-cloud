import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";
import { RegisterSensorButton } from "./sensors/register-sensor-button";
import { PendingSensorCard } from "./sensors/pending-sensor-card";
import { NewHatchButton } from "./hatches/new-hatch-button";
import { speciesPreset, daysBetween, todayIso } from "@/lib/hatches/species";
import { formatDate } from "@/lib/format";
import { SyncTimezone } from "./sync-timezone";
import { SectionAnchor } from "@/components/section-anchor";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, is_admin")
    .eq("id", user.id)
    .maybeSingle();

  const { data: primusDevices } = await supabase
    .from("primus_devices")
    .select("id, name, last_seen, firmware_version, wifi_ssid, registered_at")
    .order("registered_at", { ascending: true });

  const { data: allSensors } = await supabase
    .from("sensors")
    .select(
      "id, name, serial_number, model, last_seen, claimed_at, is_ambient",
    )
    .order("registered_at", { ascending: false });

  const { data: hatches } = await supabase
    .from("hatch_logs")
    .select(
      "id, name, species, egg_count, start_date, expected_hatch_date, actual_hatch_date, hatched_count, status, target_temp, target_humid_turn_min, target_humid_turn_max",
    )
    .order("start_date", { ascending: false });

  const activeHatches = (hatches ?? []).filter((h) => h.status === "active");
  const closedHatches = (hatches ?? []).filter((h) => h.status !== "active").slice(0, 5);

  // First-hatch Pro trial banner: show if the user has never completed a hatch.
  const showProTrial = !(hatches ?? []).some((h) => h.status === "completed");

  const pending = (allSensors ?? []).filter((s) => !s.claimed_at);
  const claimed = (allSensors ?? []).filter((s) => s.claimed_at);
  const claimedIncubator = claimed.filter((s) => !s.is_ambient);
  const claimedAmbient = claimed.filter((s) => s.is_ambient);

  // For pending cards we also want to show the most recent reading so users
  // can identify which physical sensor they're looking at.
  const pendingIds = pending.map((p) => p.id);
  const latestByPending = new Map<
    string,
    { temperature: number | null; humidity: number | null }
  >();

  if (pendingIds.length > 0) {
    const { data: latestReadings } = await supabase
      .from("sensor_readings")
      .select("sensor_id, temperature, humidity, recorded_at")
      .in("sensor_id", pendingIds)
      .order("recorded_at", { ascending: false });

    for (const r of latestReadings ?? []) {
      if (!latestByPending.has(r.sensor_id)) {
        latestByPending.set(r.sensor_id, {
          temperature: r.temperature,
          humidity: r.humidity,
        });
      }
    }
  }

  // Latest reading per claimed sensor, so the dashboard card can hero
  // the live temp/humidity instead of a MAC/serial.
  const claimedIds = claimed.map((s) => s.id);
  const latestByClaimed = new Map<
    string,
    { temperature: number | null; humidity: number | null; recorded_at: string }
  >();
  if (claimedIds.length > 0) {
    const { data: latestReadings } = await supabase
      .from("sensor_readings")
      .select("sensor_id, temperature, humidity, recorded_at")
      .in("sensor_id", claimedIds)
      .order("recorded_at", { ascending: false });

    for (const r of latestReadings ?? []) {
      if (!latestByClaimed.has(r.sensor_id)) {
        latestByClaimed.set(r.sensor_id, {
          temperature: r.temperature,
          humidity: r.humidity,
          recorded_at: r.recorded_at,
        });
      }
    }
  }

  return (
    <div className="min-h-screen">
      <SyncTimezone />
      <header className="border-b border-white/5">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Logo />
          <div className="flex items-center gap-4 text-sm">
            {profile?.is_admin && (
              <Link href="/admin" className="text-light hover:underline">
                Admin
              </Link>
            )}
            <span className="text-white/60">
              {profile?.full_name || user.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-white/60">
          Your registered sensors and hatch logs.
        </p>

        {primusDevices && primusDevices.length > 0 && (
          <section className="mt-14">
            <SectionAnchor heading="Primus" />
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {primusDevices.map((p) => {
                const status = primusStatus(p.last_seen);
                return (
                  <div key={p.id} className="card">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold">
                          {p.name || "Primus basestation"}
                        </h3>
                        <p className="mt-0.5 text-xs text-white/50">
                          {p.wifi_ssid ? `WiFi: ${p.wifi_ssid}` : "Basestation"}
                          {p.firmware_version
                            ? ` · fw ${p.firmware_version}`
                            : ""}
                        </p>
                      </div>
                      <StatusDot tone={status.tone} label={status.label} />
                    </div>
                    <p className="mt-4 text-xs text-white/50">
                      {p.last_seen
                        ? `Last heartbeat ${timeAgo(p.last_seen)}`
                        : "Awaiting first heartbeat"}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {pending.length > 0 && (
          <section className="mt-14">
            <SectionAnchor
              heading="New sensors detected"
              description="Your basestation picked these up over Bluetooth. Give each one a name to add it to your dashboard."
            />
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {pending.map((p) => {
                const latest = latestByPending.get(p.id);
                return (
                  <PendingSensorCard
                    key={p.id}
                    id={p.id}
                    serial={p.serial_number}
                    model={(p.model as "pro" | "lite") ?? "pro"}
                    advertisedName={p.name ?? null}
                    lastSeen={p.last_seen}
                    latestTemp={latest?.temperature ?? null}
                    latestHumidity={latest?.humidity ?? null}
                  />
                );
              })}
            </div>
          </section>
        )}

        <section className="mt-14">
          <SectionAnchor
            heading="Sensors"
            actions={
              <RegisterSensorButton
                pendingSensors={pending.map((p) => ({
                  id: p.id,
                  serial: p.serial_number,
                  name: p.name ?? null,
                  model: (p.model as "pro" | "lite") ?? "pro",
                  latestTemp: latestByPending.get(p.id)?.temperature ?? null,
                  latestHumidity:
                    latestByPending.get(p.id)?.humidity ?? null,
                }))}
              />
            }
          />
          <div className="mt-6">

          {claimedIncubator.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              {claimedIncubator.map((s) => {
                const latest = latestByClaimed.get(s.id);
                const sensorStatus = sensorOnlineStatus(s.last_seen);
                return (
                  <Link
                    key={s.id}
                    href={`/dashboard/sensors/${s.id}`}
                    className="card transition hover:border-light/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-semibold">
                          {s.name || s.serial_number}
                        </h3>
                        <p className="mt-0.5 text-xs text-white/50">
                          {s.last_seen
                            ? `Last seen ${timeAgo(s.last_seen)}`
                            : "Awaiting first reading"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatusDot
                          tone={sensorStatus.tone}
                          label={sensorStatus.label}
                        />
                        <span className="rounded-full border border-light/30 bg-light/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-light">
                          {s.model === "pro" ? "Pro" : "Lite"}
                        </span>
                      </div>
                    </div>

                    <div className="mt-5 flex items-baseline gap-6 tabular-nums">
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-white/40">
                          Temp
                        </div>
                        <div className="mt-1 text-2xl font-semibold text-white">
                          {latest?.temperature != null
                            ? `${latest.temperature.toFixed(1)}°C`
                            : "—"}
                        </div>
                      </div>
                      {s.model === "pro" && (
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-white/40">
                            Humidity
                          </div>
                          <div className="mt-1 text-2xl font-semibold text-white">
                            {latest?.humidity != null
                              ? `${latest.humidity.toFixed(1)}%`
                              : "—"}
                          </div>
                        </div>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : pending.length === 0 && claimedAmbient.length === 0 ? (
            <div className="card text-center text-sm text-white/60">
              No sensors yet. Your Primus will add them automatically once it's
              in Bluetooth range, or click{" "}
              <strong className="text-white">+ Register sensor</strong> to add
              one manually.
            </div>
          ) : null}
          </div>
        </section>

        {claimedAmbient.length > 0 && (
          <section className="mt-14">
            <SectionAnchor
              heading="Room sensors"
              description="Ambient conditions around your incubators. Shown as context on hatch reports — a cold or humid room is a major cause of struggling hatches."
              tone="amber"
            />
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {claimedAmbient.map((s) => {
                const latest = latestByClaimed.get(s.id);
                const sensorStatus = sensorOnlineStatus(s.last_seen);
                return (
                  <Link
                    key={s.id}
                    href={`/dashboard/sensors/${s.id}`}
                    className="card rounded-xl border border-amber-400/30 bg-amber-400/[0.05] p-6 transition hover:border-amber-300/50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-semibold text-amber-100">
                          {s.name || s.serial_number}
                        </h3>
                        <p className="mt-0.5 text-xs text-amber-200/60">
                          {s.last_seen
                            ? `Last seen ${timeAgo(s.last_seen)}`
                            : "Awaiting first reading"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatusDot
                          tone={sensorStatus.tone}
                          label={sensorStatus.label}
                        />
                        <span className="rounded-full border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-amber-200">
                          Room
                        </span>
                      </div>
                    </div>

                    <div className="mt-5 flex items-baseline gap-6 tabular-nums">
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-amber-200/60">
                          Room Temp
                        </div>
                        <div className="mt-1 text-2xl font-semibold text-amber-100">
                          {latest?.temperature != null
                            ? `${latest.temperature.toFixed(1)}°C`
                            : "—"}
                        </div>
                      </div>
                      {s.model === "pro" && (
                        <div>
                          <div className="text-[10px] uppercase tracking-widest text-amber-200/60">
                            Room %RH
                          </div>
                          <div className="mt-1 text-2xl font-semibold text-amber-100">
                            {latest?.humidity != null
                              ? `${latest.humidity.toFixed(1)}%`
                              : "—"}
                          </div>
                        </div>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        <section className="mt-20">
          <SectionAnchor
            heading="Hatches"
            actions={
              <NewHatchButton
                sensors={(claimed ?? []).map((s) => ({
                  id: s.id,
                  label: s.name || s.serial_number,
                  isAmbient: s.is_ambient ?? false,
                }))}
                showProTrialBanner={showProTrial}
              />
            }
          />

          <div className="mt-6">
          {activeHatches.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2">
              {activeHatches.map((h) => {
                const preset = speciesPreset(h.species);
                const today = todayIso();
                const daysIn = Math.max(0, daysBetween(h.start_date, today));
                const daysToHatch = daysBetween(
                  today,
                  h.expected_hatch_date || h.start_date,
                );
                // 1-indexed day of hatch (Day 1 = setting day), matching
                // the Daily Log convention on the detail page.
                const dayNumber = daysIn + 1;
                const status = phaseLabel(dayNumber, preset.lockdown, preset.days);
                const pct = Math.min(
                  100,
                  Math.max(0, (daysIn / preset.days) * 100),
                );
                const targetTemp = h.target_temp ?? preset.targetTemp;
                const humMin = h.target_humid_turn_min ?? preset.humTurnMin;
                const humMax = h.target_humid_turn_max ?? preset.humTurnMax;
                return (
                  <Link
                    key={h.id}
                    href={`/dashboard/hatches/${h.id}`}
                    className="card transition hover:border-light/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-semibold">{h.name}</h3>
                      <span className="shrink-0 rounded-full border border-light/30 bg-light/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-light">
                        {status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-white/50">
                      {preset.label} · {h.egg_count} eggs
                    </p>
                    <p className="mt-0.5 text-xs text-white/40 tabular-nums">
                      Target {targetTemp.toFixed(1)} °C · {humMin}–{humMax}% RH
                    </p>

                    <div className="mt-4">
                      <div className="flex justify-between text-xs text-white/60">
                        <span>Day {dayNumber} of {preset.days}</span>
                        <span>
                          {daysToHatch > 0
                            ? `${daysToHatch}d to hatch`
                            : daysToHatch === 0
                              ? "Due today"
                              : `${Math.abs(daysToHatch)}d overdue`}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                        <div
                          className="h-full bg-gradient-to-r from-grass to-light"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {activeHatches.length === 0 && (
            <div className="card text-center text-sm text-white/60">
              No active hatches. Click{" "}
              <strong className="text-white">+ New hatch</strong> to start one.
            </div>
          )}

          {closedHatches.length > 0 && (
            <div className="mt-8">
              <h3 className="mb-3 text-sm font-semibold text-white/60">
                Recent hatches
              </h3>
              <div className="overflow-hidden rounded-xl border border-white/5">
                <table className="w-full text-sm">
                  <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
                    <tr>
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Species</th>
                      <th className="px-4 py-3">Started</th>
                      <th className="px-4 py-3">Result</th>
                      <th className="px-4 py-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedHatches.map((h) => {
                      const preset = speciesPreset(h.species);
                      const rate =
                        h.egg_count && h.hatched_count != null
                          ? Math.round(
                              (h.hatched_count / h.egg_count) * 100,
                            )
                          : null;
                      return (
                        <tr
                          key={h.id}
                          className="border-t border-white/5 hover:bg-white/[0.02]"
                        >
                          <td className="px-4 py-3 font-medium">{h.name}</td>
                          <td className="px-4 py-3 text-white/70">
                            {preset.label}
                          </td>
                          <td className="px-4 py-3 text-white/50">
                            {formatDate(h.start_date)}
                          </td>
                          <td className="px-4 py-3">
                            {h.status === "completed" ? (
                              <span className="text-light">
                                {h.hatched_count ?? 0} / {h.egg_count}
                                {rate != null && ` (${rate}%)`}
                              </span>
                            ) : (
                              <span className="text-red-300">Failed</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Link
                              href={`/dashboard/hatches/${h.id}`}
                              className="text-light hover:underline"
                            >
                              Open →
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          </div>
        </section>
      </main>
    </div>
  );
}

function timeAgo(iso: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function phaseLabel(dayNumber: number, lockdown: number, expected: number) {
  // dayNumber is 1-indexed (Day 1 = setting day). Phase names only, no
  // numbers — the caller displays the day number separately.
  if (dayNumber < lockdown) return "Turning";
  if (dayNumber < expected) return "Lockdown";
  if (dayNumber === expected) return "Hatch day";
  return "Overdue";
}

type StatusTone = "ok" | "warn" | "stale";

// 2026-05-01: thresholds widened from 5 min → 15 min after the Primus
// heartbeat cadence moved from 60s to up to 10 min (BLE-scan PSRAM
// contention mitigation — see docs/DISPLAY_TEARING_INVESTIGATION.md).
// last_seen oscillates between 0 and ~10 min stale during normal
// operation; 15 min gives one full cycle of margin without false-stale.
function primusStatus(lastSeen: string | null): {
  tone: StatusTone;
  label: string;
} {
  if (!lastSeen) return { tone: "stale", label: "Never seen" };
  const ageMs = Date.now() - new Date(lastSeen).getTime();
  if (ageMs < 15 * 60 * 1000) return { tone: "ok", label: "Online" };
  if (ageMs < 60 * 60 * 1000) return { tone: "warn", label: "Delayed" };
  return { tone: "stale", label: "Offline" };
}

// Sensors' last_seen is bumped by the readings INSERT trigger
// (migration 014) on every Primus upload. With ~10 min upload cadence,
// fresh data is up to 10 min old at any moment. 15 min threshold = one
// cycle of margin.
function sensorOnlineStatus(lastSeen: string | null): {
  tone: StatusTone;
  label: string;
} {
  if (!lastSeen) return { tone: "stale", label: "No data" };
  const ageMs = Date.now() - new Date(lastSeen).getTime();
  if (ageMs < 15 * 60 * 1000) return { tone: "ok", label: "Live" };
  if (ageMs < 60 * 60 * 1000) return { tone: "warn", label: "Delayed" };
  return { tone: "stale", label: "Offline" };
}

function StatusDot({ tone, label }: { tone: StatusTone; label: string }) {
  // Green = healthy/live, amber = degraded but not failed, red = offline/stale.
  // Gold/light was avoided here because the brand uses it for positive state
  // elsewhere and users parse yellow-ish dots as "caution" — not what we want.
  const colors: Record<StatusTone, string> = {
    ok: "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]",
    warn: "bg-amber-400",
    stale: "bg-red-400",
  };
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-widest text-white/60"
      title={label}
    >
      <span
        aria-hidden
        className={`inline-block h-2 w-2 rounded-full ${colors[tone]}`}
      />
      {label}
    </span>
  );
}
