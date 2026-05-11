import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  addDays as addDaysLocal,
  speciesPreset,
  daysBetween,
  todayIso,
} from "@/lib/hatches/species";
import { formatDate } from "@/lib/format";
import { Timestamp } from "@/components/timestamp";
import { SectionAnchor } from "@/components/section-anchor";
import { DownloadIcon, ArrowLeftIcon, CheckIcon } from "@/components/icons";
import { HatchControls } from "./hatch-controls";
import { EditSensorsButton } from "./edit-sensors-button";
import { CompletedResults } from "./completed-results";
import { EditHatchButton } from "./edit-hatch-button";
import { EmailReportButton } from "./email-report-button";
import { RefreshButton } from "./refresh-button";
import { HatchTiming } from "./hatch-timing";
import {
  DailyLogTab,
  MilestonesTab,
  type DailyAggregate,
  type DailyLogEntry,
  type MilestoneRow,
} from "./daily-log-and-milestones";
import { EggWeights, type EggWeight } from "./egg-weights";
import { HatchTabs, type HatchTab } from "./hatch-tabs";

export const dynamic = "force-dynamic";

export default async function HatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: hatch } = await supabase
    .from("hatch_logs")
    .select(
      "id, name, species, egg_count, start_date, expected_hatch_date, actual_hatch_date, hatched_count, fertile_count, died_in_shell, pipped_not_hatched, early_deaths, notes, status, created_at, breed, egg_source, egg_source_detail, incubator_model, target_temp, target_humid_turn_min, target_humid_turn_max, target_humid_lock_min, target_humid_lock_max, first_pip_at, hatch_complete_at, chick_assessment, ambient_sensor_id",
    )
    .eq("id", id)
    .maybeSingle();

  if (!hatch) notFound();

  const preset = speciesPreset(hatch.species);
  const today = todayIso();
  const daysIn = Math.max(0, daysBetween(hatch.start_date, today));
  const daysToHatch = daysBetween(
    today,
    hatch.expected_hatch_date || hatch.start_date,
  );
  const lockdownDate = new Date(hatch.start_date);
  lockdownDate.setUTCDate(lockdownDate.getUTCDate() + preset.lockdown);
  const lockdownIso = lockdownDate.toISOString().substring(0, 10);
  // dayNumber is 1-indexed day of hatch (Day 1 = setting day), matching the
  // Daily Log convention. daysIn is 0-indexed elapsed-days-since-setting.
  const dayNumber = daysIn + 1;
  const phase = phaseLabel(dayNumber, preset.lockdown, preset.days, hatch.status);
  const pct = Math.min(100, Math.max(0, (daysIn / preset.days) * 100));

  // Linked sensors + recent readings (across all of them, interleaved)
  const { data: links } = await supabase
    .from("hatch_sensors")
    .select("sensor_id, sensors(id, name, serial_number, model)")
    .eq("hatch_id", hatch.id);

  // All claimed sensors (for the "Edit sensors" picker)
  const { data: allClaimed } = await supabase
    .from("sensors")
    .select("id, name, serial_number, is_ambient")
    .not("claimed_at", "is", null)
    .order("registered_at", { ascending: false });
  const allSensorOptions = (allClaimed ?? []).map((s) => ({
    id: s.id,
    label: s.name || s.serial_number,
    isAmbient: s.is_ambient ?? false,
  }));

  type LinkedSensor = {
    id: string;
    name: string | null;
    serial_number: string;
    model: string;
    latest?: {
      temperature: number | null;
      humidity: number | null;
      recorded_at: string;
    } | null;
  };

  const linkedSensors: LinkedSensor[] = (links ?? [])
    .map((l) => {
      const s = l.sensors as unknown as {
        id: string;
        name: string | null;
        serial_number: string;
        model: string;
      } | null;
      if (!s) return null;
      return {
        id: s.id,
        name: s.name,
        serial_number: s.serial_number,
        model: s.model,
      };
    })
    .filter(Boolean) as LinkedSensor[];

  let combinedReadings: {
    sensor_id: string;
    temperature: number | null;
    humidity: number | null;
    recorded_at: string;
  }[] = [];

  if (linkedSensors.length > 0) {
    const since = new Date(hatch.start_date + "T00:00:00Z").toISOString();
    const { data: readings } = await supabase
      .from("sensor_readings")
      .select("sensor_id, temperature, humidity, recorded_at")
      .in(
        "sensor_id",
        linkedSensors.map((s) => s.id),
      )
      .gte("recorded_at", since)
      .order("recorded_at", { ascending: false })
      .limit(20);
    combinedReadings = readings ?? [];

    // Attach each sensor's latest reading for its header card
    for (const s of linkedSensors) {
      const latest = combinedReadings.find((r) => r.sensor_id === s.id);
      s.latest = latest
        ? {
            temperature: latest.temperature,
            humidity: latest.humidity,
            recorded_at: latest.recorded_at,
          }
        : null;
    }
  }

  const sensorById = new Map(linkedSensors.map((s) => [s.id, s]));

  // --- Daily aggregates for the Daily Log table ---
  // Compute per-day min/avg/max across all linked sensors, from hatch start
  // through expected hatch + 3 buffer days. Uses the user's timezone for
  // day bucketing so "today" in Perth and "today" in Sydney differ correctly.
  const { data: profile } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("id", user.id)
    .maybeSingle();
  const userTz = profile?.timezone || "UTC";

  const totalPlusBuffer = preset.days + 3;
  const dailyAggregates: DailyAggregate[] = [];

  let readingsForAggregates: {
    temperature: number | null;
    humidity: number | null;
    recorded_at: string;
  }[] = [];

  if (linkedSensors.length > 0) {
    const since = new Date(hatch.start_date + "T00:00:00Z").toISOString();
    const sensorIds = linkedSensors.map((s) => s.id);
    // Supabase / PostgREST caps single-response rows at max-rows (1000 on
    // managed projects), which silently truncates aggregation queries and
    // makes today's readings invisible if they fall past the cutoff. Paginate
    // with .range() to pull everything in 1000-row chunks.
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("sensor_readings")
        .select("temperature, humidity, recorded_at")
        .in("sensor_id", sensorIds)
        .gte("recorded_at", since)
        .order("recorded_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error || !data || data.length === 0) break;
      readingsForAggregates.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
      if (from > 200000) break; // safety cap — multi-month hatches shouldn't exceed this
    }
  }

  // Bucket readings by their local date
  const byDate = new Map<
    string,
    { temps: number[]; hums: number[] }
  >();
  for (const r of readingsForAggregates) {
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: userTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(r.recorded_at));
    let bucket = byDate.get(localDate);
    if (!bucket) {
      bucket = { temps: [], hums: [] };
      byDate.set(localDate, bucket);
    }
    if (r.temperature != null && Number.isFinite(r.temperature))
      bucket.temps.push(r.temperature);
    if (r.humidity != null && Number.isFinite(r.humidity))
      bucket.hums.push(r.humidity);
  }

  // --- Ambient sensor (room/environment) ---
  // Fetched + aggregated separately from incubator sensors to keep the
  // hatch's incubator averages clean. Shown as context (amber accent).
  // Runs before the daily-aggregates loop so per-day ambient values can
  // be merged in during that single pass.
  type AmbientInfo = {
    id: string;
    name: string;
    serial_number: string;
    latest:
      | { temperature: number | null; humidity: number | null; recorded_at: string }
      | null;
  };
  let ambient: AmbientInfo | null = null;
  const ambientByDate = new Map<
    string,
    { temps: number[]; hums: number[] }
  >();

  if (hatch.ambient_sensor_id) {
    const { data: ambSensor } = await supabase
      .from("sensors")
      .select("id, name, serial_number")
      .eq("id", hatch.ambient_sensor_id)
      .maybeSingle();

    if (ambSensor) {
      // Paginated fetch of ambient readings since hatch start, same pattern
      // as the incubator aggregate pull.
      const since = new Date(hatch.start_date + "T00:00:00Z").toISOString();
      const PAGE = 1000;
      let from = 0;
      const ambReadings: {
        temperature: number | null;
        humidity: number | null;
        recorded_at: string;
      }[] = [];
      while (true) {
        const { data: batch, error } = await supabase
          .from("sensor_readings")
          .select("temperature, humidity, recorded_at")
          .eq("sensor_id", ambSensor.id)
          .gte("recorded_at", since)
          .order("recorded_at", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error || !batch || batch.length === 0) break;
        ambReadings.push(...batch);
        if (batch.length < PAGE) break;
        from += PAGE;
        if (from > 200000) break;
      }

      // Bucket ambient readings by user-local date (same convention as
      // incubator bucketing).
      for (const r of ambReadings) {
        const localDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: userTz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(r.recorded_at));
        let bucket = ambientByDate.get(localDate);
        if (!bucket) {
          bucket = { temps: [], hums: [] };
          ambientByDate.set(localDate, bucket);
        }
        if (r.temperature != null && Number.isFinite(r.temperature))
          bucket.temps.push(r.temperature);
        if (r.humidity != null && Number.isFinite(r.humidity))
          bucket.hums.push(r.humidity);
      }

      // Grab the most recent ambient reading for the header card.
      const latestAmb = ambReadings[ambReadings.length - 1];
      ambient = {
        id: ambSensor.id,
        name: ambSensor.name || ambSensor.serial_number,
        serial_number: ambSensor.serial_number,
        latest: latestAmb
          ? {
              temperature: latestAmb.temperature,
              humidity: latestAmb.humidity,
              recorded_at: latestAmb.recorded_at,
            }
          : null,
      };
    }
  }

  // Per-day ambient aggregates, indexed by day number to align with the
  // incubator aggregate rows.
  const ambientAggregatesByDay = new Map<
    number,
    {
      tempAvg: number | null;
      tempMin: number | null;
      tempMax: number | null;
      humAvg: number | null;
      humMin: number | null;
      humMax: number | null;
    }
  >();
  for (let day = 1; day <= totalPlusBuffer; day++) {
    const dateIso = addDaysLocal(hatch.start_date, day - 1);
    const bucket = ambientByDate.get(dateIso);
    const t = bucket?.temps ?? [];
    const h = bucket?.hums ?? [];
    ambientAggregatesByDay.set(day, {
      tempAvg: t.length ? t.reduce((s, v) => s + v, 0) / t.length : null,
      tempMin: t.length ? Math.min(...t) : null,
      tempMax: t.length ? Math.max(...t) : null,
      humAvg: h.length ? h.reduce((s, v) => s + v, 0) / h.length : null,
      humMin: h.length ? Math.min(...h) : null,
      humMax: h.length ? Math.max(...h) : null,
    });
  }

  // Daily aggregates: merge incubator + ambient per day, ready for render.
  for (let day = 1; day <= totalPlusBuffer; day++) {
    const dateIso = addDaysLocal(hatch.start_date, day - 1);
    const bucket = byDate.get(dateIso);
    const temps = bucket?.temps ?? [];
    const hums = bucket?.hums ?? [];
    const amb = ambientAggregatesByDay.get(day);
    dailyAggregates.push({
      day,
      dateIso,
      tempAvg: temps.length ? temps.reduce((s, v) => s + v, 0) / temps.length : null,
      tempMin: temps.length ? Math.min(...temps) : null,
      tempMax: temps.length ? Math.max(...temps) : null,
      humAvg: hums.length ? hums.reduce((s, v) => s + v, 0) / hums.length : null,
      humMin: hums.length ? Math.min(...hums) : null,
      humMax: hums.length ? Math.max(...hums) : null,
      readings: temps.length + hums.length,
      ambientTempAvg: amb?.tempAvg ?? null,
      ambientHumAvg: amb?.humAvg ?? null,
    });
  }

  // --- Milestones ---
  const { data: allMilestones } = await supabase
    .from("hatch_milestones")
    .select(
      "id, milestone_type, occurred_at, day_number, fertile_count, removed_count, eggs_remaining, turning_count, notes",
    )
    .eq("hatch_id", hatch.id)
    .order("occurred_at", { ascending: false });

  const milestones = (allMilestones ?? []) as MilestoneRow[];
  const dailyLogMilestones: DailyLogEntry[] = milestones
    .filter((m) => m.milestone_type === "daily_log" && m.day_number != null)
    .map((m) => ({
      day: m.day_number!,
      turning_count: m.turning_count,
      notes: m.notes,
    }));
  const nonDailyMilestones = milestones.filter(
    (m) => m.milestone_type !== "daily_log",
  );

  // --- Egg weights ---
  const { data: weightRows } = await supabase
    .from("egg_weights")
    .select("id, weighed_at, day_number, weight_grams, stage, notes")
    .eq("hatch_id", hatch.id)
    .order("weighed_at", { ascending: true });
  const eggWeights = (weightRows ?? []) as EggWeight[];

  return (
    <div className="min-h-screen">
      <header className="border-b border-white/5">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            <span>Dashboard</span>
          </Link>
          <span className="text-sm text-white/60">{user.email}</span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">

        {/* ================== HERO ================== */}
        <section>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-light">
            {preset.label} · {hatch.egg_count} eggs
          </p>
          <div className="mt-2 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-4xl font-bold tracking-tight">
                {hatch.name}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                <Badge
                  status={hatch.status as "active" | "completed" | "failed"}
                />
                <span className="text-white/80">{phase}</span>
                <span className="text-white/40">·</span>
                <span className="text-white/60">
                  Set {formatSetAt(hatch.created_at, userTz)}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <RefreshButton />
              <EditHatchButton
                hatchId={hatch.id}
                initial={{
                  name: hatch.name,
                  species: hatch.species ?? "chicken",
                  egg_count: hatch.egg_count ?? 0,
                  start_date: hatch.start_date,
                  expected_hatch_date: hatch.expected_hatch_date ?? null,
                  breed: hatch.breed ?? null,
                  egg_source: hatch.egg_source ?? null,
                  egg_source_detail: hatch.egg_source_detail ?? null,
                  incubator_model: hatch.incubator_model ?? null,
                  target_temp: hatch.target_temp ?? null,
                  target_humid_turn_min: hatch.target_humid_turn_min ?? null,
                  target_humid_turn_max: hatch.target_humid_turn_max ?? null,
                  target_humid_lock_min: hatch.target_humid_lock_min ?? null,
                  target_humid_lock_max: hatch.target_humid_lock_max ?? null,
                }}
              />
              <EmailReportButton hatchId={hatch.id} />
              <a
                href={`/dashboard/hatches/${hatch.id}/download`}
                className="btn-ghost inline-flex items-center gap-2"
                download
              >
                <DownloadIcon className="h-4 w-4" />
                <span>Download report</span>
              </a>
            </div>
          </div>
        </section>

        {/* ================== AT A GLANCE ================== */}
        {/* 4-up (or 3-up if no ambient) stat row. Farmers walk up, scan
            the numbers in 2 seconds, decide if everything's OK. Ambient
            is amber so it's instantly readable as a different category. */}
        {hatch.status === "active" && (
          <section
            className={`mt-10 grid gap-3 sm:grid-cols-2 ${
              ambient ? "lg:grid-cols-4" : "lg:grid-cols-3"
            }`}
          >
            {/* Progress / Day */}
            <div className="card">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
                Progress
              </div>
              <div className="mt-2 flex items-baseline gap-2 tabular-nums">
                <span className="text-3xl font-bold text-white">
                  {dayNumber}
                </span>
                <span className="text-sm text-white/40">
                  of {preset.days} days
                </span>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full bg-gradient-to-r from-grass to-light"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-2 text-xs text-white/50">
                {daysToHatch > 0
                  ? `${daysToHatch} day${daysToHatch === 1 ? "" : "s"} to hatch`
                  : daysToHatch === 0
                    ? "Hatching today"
                    : `${Math.abs(daysToHatch)} day${
                        Math.abs(daysToHatch) === 1 ? "" : "s"
                      } overdue`}
              </div>
            </div>

            {/* Incubator temp */}
            <StatCard
              label="Incubator temp"
              value={linkedLatestTemp(linkedSensors)}
              unit="°C"
              target={`Target ${(hatch.target_temp ?? preset.targetTemp).toFixed(
                1,
              )} °C ±0.25`}
            />

            {/* Humidity */}
            <StatCard
              label="Humidity"
              value={linkedLatestHumidity(linkedSensors)}
              unit="%RH"
              target={`Target ${
                hatch.target_humid_turn_min ?? preset.humTurnMin
              }–${hatch.target_humid_turn_max ?? preset.humTurnMax} %`}
            />

            {/* Room temp (ambient) — only rendered if a room sensor is linked */}
            {ambient && (
              <div className="rounded-xl border border-amber-400/40 bg-amber-400/[0.06] p-6 shadow-[inset_0_1px_0_rgba(255,200,80,0.06)]">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-300/70">
                    Room temp
                  </div>
                  <span className="rounded-full border border-amber-300/50 bg-amber-300/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-amber-200">
                    Ambient
                  </span>
                </div>
                <div className="mt-2 flex items-baseline gap-2 tabular-nums">
                  <span className="text-3xl font-bold text-amber-100">
                    {ambient.latest?.temperature != null
                      ? ambient.latest.temperature.toFixed(1)
                      : "—"}
                  </span>
                  <span className="text-sm text-amber-200/60">°C</span>
                  {ambient.latest?.humidity != null && (
                    <span className="ml-2 text-sm text-amber-200/60 tabular-nums">
                      / {ambient.latest.humidity.toFixed(0)}% RH
                    </span>
                  )}
                </div>
                <div className="mt-3 text-xs text-amber-200/70">
                  {ambient.name}
                </div>
                <div className="mt-1 text-[10px] text-amber-200/40">
                  Context only — not mixed into incubator averages
                </div>
              </div>
            )}
          </section>
        )}

        {/* ================== PROGRESS TIMELINE ================== */}
        {hatch.status === "active" && (
          <section className="mt-6 card">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
                  Incubation timeline
                </p>
                <h2 className="mt-1 text-xl font-bold tracking-tight">
                  {phase.includes("—") ? phase.split("—")[1].trim() : phase}{" "}
                  phase
                </h2>
              </div>
              <div className="text-sm text-white/50 tabular-nums">
                {formatDate(hatch.start_date)} →{" "}
                {formatDate(hatch.expected_hatch_date)} · {preset.days} days
              </div>
            </div>

            {/* Visual track with markers */}
            <div className="relative mt-8 h-2 w-full rounded-full bg-white/5">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-grass to-light"
                style={{ width: `${pct}%` }}
              />
              {/* Today marker */}
              <div
                className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-light bg-ink"
                style={{ left: `${pct}%` }}
              >
                <div className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-light px-2 py-0.5 text-[10px] font-semibold text-ink">
                  Day {dayNumber} · today
                </div>
              </div>
              {/* Lockdown marker */}
              <div
                className="absolute top-1/2 h-2 w-0.5 -translate-y-1/2 bg-bronze"
                style={{ left: `${(preset.lockdown / preset.days) * 100}%` }}
              />
              {/* Hatch marker */}
              <div
                className="absolute top-1/2 h-2 w-0.5 -translate-y-1/2 bg-grass"
                style={{ left: "100%" }}
              />
            </div>
            <div className="mt-4 flex justify-between text-xs text-white/50 tabular-nums">
              <span>Day 1 · Set {formatDate(hatch.start_date)}</span>
              <span className="text-bronze">
                Day {preset.lockdown} · Lockdown {formatDate(lockdownIso)}
              </span>
              <span className="text-grass">
                Day {preset.days} · Hatch{" "}
                {formatDate(hatch.expected_hatch_date)}
              </span>
            </div>
          </section>
        )}

        {hatch.status === "completed" && (
          <section className="mt-10 card">
            <div className="flex items-baseline justify-between">
              <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-grass">
                <CheckIcon className="h-5 w-5" />
                Hatch completed
              </h2>
              {hatch.actual_hatch_date && (
                <span className="text-sm text-white/50">
                  {formatDate(hatch.actual_hatch_date)}
                </span>
              )}
            </div>
            <div className="mt-4">
              <CompletedResults
                hatchId={hatch.id}
                eggCount={hatch.egg_count ?? 0}
                initial={{
                  fertile_count: hatch.fertile_count ?? null,
                  hatched_count: hatch.hatched_count ?? null,
                  died_in_shell: hatch.died_in_shell ?? null,
                  pipped_not_hatched: hatch.pipped_not_hatched ?? null,
                  early_deaths: hatch.early_deaths ?? null,
                }}
              />
            </div>
          </section>
        )}

        {hatch.status === "failed" && (
          <section className="mt-10 rounded-xl border border-red-500/30 bg-red-500/[0.04] p-6">
            <h2 className="text-lg font-semibold text-red-300">Failed</h2>
            <p className="mt-2 text-sm text-white/60">
              This hatch was marked as failed. See notes below for details.
            </p>
          </section>
        )}

        {/* ================== SECTION 01 — Sensors & devices ================== */}
        <div className="mt-20">
          <SectionAnchor
            label="Section 01"
            heading="Sensors & devices"
            description="Which sensors are reporting for this hatch, and what they're seeing right now."
          />
        </div>

        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-white/50">
              Incubator sensors{" "}
              <span className="text-white/30">({linkedSensors.length})</span>
            </h3>
            <EditSensorsButton
              hatchId={hatch.id}
              allSensors={allSensorOptions}
              initialLinkedIds={linkedSensors.map((s) => s.id)}
              initialAmbientSensorId={hatch.ambient_sensor_id ?? null}
            />
          </div>
          {linkedSensors.length === 0 ? (
            <p className="mt-3 text-sm text-white/50">
              No sensors linked to this hatch yet. Click{" "}
              <strong className="text-white">Edit sensors</strong> to link
              one or more.
            </p>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {linkedSensors.map((s) => (
                <Link
                  key={s.id}
                  href={`/dashboard/sensors/${s.id}`}
                  className="card transition hover:border-light/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="font-semibold">
                      {s.name || s.serial_number}
                    </h4>
                    <span className="rounded-full border border-light/30 bg-light/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-light">
                      {s.model === "pro" ? "Pro" : "Lite"}
                    </span>
                  </div>
                  <div className="mt-4 flex items-baseline gap-6 tabular-nums">
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-white/40">
                        Temp
                      </div>
                      <div className="mt-1 text-2xl font-semibold text-white">
                        {s.latest?.temperature != null
                          ? `${s.latest.temperature.toFixed(2)}°C`
                          : "—"}
                      </div>
                    </div>
                    {s.model === "pro" && (
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-white/40">
                          Humidity
                        </div>
                        <div className="mt-1 text-2xl font-semibold text-white">
                          {s.latest?.humidity != null
                            ? `${s.latest.humidity.toFixed(1)}%`
                            : "—"}
                        </div>
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {ambient && (
          <section className="mt-8">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-amber-300/70">
              Room sensor <span className="text-amber-300/40">(1)</span>
            </h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Link
                href={`/dashboard/sensors/${ambient.id}`}
                className="rounded-xl border border-amber-400/40 bg-amber-400/[0.06] p-6 transition hover:border-amber-300/60"
              >
                <div className="flex items-start justify-between gap-2">
                  <h4 className="font-semibold text-amber-100">
                    {ambient.name}
                  </h4>
                  <span className="rounded-full border border-amber-300/50 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-amber-200">
                    Ambient
                  </span>
                </div>
                <div className="mt-4 flex items-baseline gap-6 tabular-nums">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-amber-200/60">
                      Room °C
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-amber-100">
                      {ambient.latest?.temperature != null
                        ? `${ambient.latest.temperature.toFixed(2)}°C`
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-amber-200/60">
                      Room %RH
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-amber-100">
                      {ambient.latest?.humidity != null
                        ? `${ambient.latest.humidity.toFixed(1)}%`
                        : "—"}
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-xs text-amber-200/50">
                  Context only — not mixed into incubator averages.
                </p>
              </Link>
            </div>
          </section>
        )}

        {/* ================== SECTION 02 — Daily tracking ================== */}
        <div className="mt-20">
          <SectionAnchor
            label="Section 02"
            heading="Daily tracking"
            description="Per-day readings, turnings, candling notes, milestones."
          />
        </div>

        <div className="mt-6">
          <HatchTabs
            tabs={[
              {
                id: "daily-log",
                label: "Daily log",
                content: (
                  <DailyLogTab
                    hatchId={hatch.id}
                    eggCount={hatch.egg_count ?? 0}
                    preset={preset}
                    dailyAggregates={dailyAggregates}
                    dailyLog={dailyLogMilestones}
                    milestones={nonDailyMilestones}
                    targetTemp={hatch.target_temp ?? preset.targetTemp}
                    ambient={
                      ambient
                        ? { name: ambient.name, latest: ambient.latest }
                        : null
                    }
                  />
                ),
              },
              {
                id: "milestones",
                label: "Milestones",
                content: (
                  <MilestonesTab
                    hatchId={hatch.id}
                    eggCount={hatch.egg_count ?? 0}
                    preset={preset}
                    dailyAggregates={dailyAggregates}
                    dailyLog={dailyLogMilestones}
                    milestones={nonDailyMilestones}
                    targetTemp={hatch.target_temp ?? preset.targetTemp}
                  />
                ),
              },
              {
                id: "timing",
                label: "Hatch timing",
                content: (
                  <HatchTiming
                    hatchId={hatch.id}
                    firstPipAt={hatch.first_pip_at ?? null}
                    hatchCompleteAt={hatch.hatch_complete_at ?? null}
                  />
                ),
              },
              {
                id: "weights",
                label: "Egg weights",
                content: (
                  <EggWeights
                    hatchId={hatch.id}
                    weights={eggWeights}
                    speciesKey={hatch.species ?? "chicken"}
                  />
                ),
              },
              {
                id: "readings",
                label: "Raw readings",
                content:
                  combinedReadings.length === 0 ? (
                    <p className="text-sm text-white/50">
                      No readings captured yet.
                    </p>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-white/5">
                      <table className="w-full text-sm">
                        <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
                          <tr>
                            <th className="px-3 py-3">When</th>
                            <th className="px-3 py-3">Sensor</th>
                            <th className="px-3 py-3">Temp</th>
                            <th className="px-3 py-3">Humidity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {combinedReadings.map((r, i) => {
                            const s = sensorById.get(r.sensor_id);
                            return (
                              <tr key={i} className="border-t border-white/5">
                                <td className="px-3 py-2 text-white/70">
                                  <Timestamp iso={r.recorded_at} />
                                </td>
                                <td className="px-3 py-2 text-white/70">
                                  {s ? s.name || s.serial_number : "—"}
                                </td>
                                <td className="px-3 py-2 tabular-nums">
                                  {r.temperature != null
                                    ? `${r.temperature.toFixed(2)}°C`
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 tabular-nums">
                                  {r.humidity != null
                                    ? `${r.humidity.toFixed(1)}%`
                                    : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ),
              },
            ]}
            initialId="daily-log"
          />
        </div>

        {/* ================== SECTION 03 — Details & notes ================== */}
        <div className="mt-20">
          <SectionAnchor
            label="Section 03"
            heading="Details & notes"
            description="Metadata, targets, hatch notes, and completion controls."
          />
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
          <section className="rounded-xl border border-white/10 bg-white/[0.015] p-6">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Row label="Species">{preset.label}</Row>
              <Row label="Breed">{hatch.breed || "—"}</Row>
              <Row label="Egg count">{hatch.egg_count}</Row>
              <Row label="Egg source">
                {formatEggSource(hatch.egg_source, hatch.egg_source_detail)}
              </Row>
              <Row label="Incubator">{hatch.incubator_model || "—"}</Row>
              <Row label="Started">
                {formatSetAt(hatch.created_at, userTz)}
              </Row>
              <Row label="Lockdown">
                {formatDate(lockdownIso)}{" "}
                <span className="text-xs text-white/40">
                  · day {preset.lockdown}
                </span>
              </Row>
              <Row label="Expected hatch">
                {formatDate(hatch.expected_hatch_date)}{" "}
                <span className="text-xs text-white/40">
                  · day {preset.days}
                </span>
              </Row>
            </dl>

            <div className="mt-6 border-t border-white/5 pt-5">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">
                Targets
              </h3>
              <dl className="mt-3 grid gap-3 sm:grid-cols-3 text-sm">
                <Row label="Temperature">
                  {(hatch.target_temp ?? preset.targetTemp).toFixed(1)} °C
                </Row>
                <Row label="Humid · turning">
                  {hatch.target_humid_turn_min ?? preset.humTurnMin}–
                  {hatch.target_humid_turn_max ?? preset.humTurnMax}%
                </Row>
                <Row label="Humid · lockdown">
                  {hatch.target_humid_lock_min ?? preset.humLockMin}–
                  {hatch.target_humid_lock_max ?? preset.humLockMax}%
                </Row>
              </dl>
            </div>
          </section>

          <aside>
            <HatchControls
              id={hatch.id}
              status={hatch.status as "active" | "completed" | "failed"}
              eggCount={hatch.egg_count ?? 0}
              initialNotes={hatch.notes}
              initialResults={{
                fertile_count: hatch.fertile_count ?? null,
                hatched_count: hatch.hatched_count ?? null,
                died_in_shell: hatch.died_in_shell ?? null,
                pipped_not_hatched: hatch.pipped_not_hatched ?? null,
                early_deaths: hatch.early_deaths ?? null,
                first_pip_at: hatch.first_pip_at ?? null,
                hatch_complete_at: hatch.hatch_complete_at ?? null,
                chick_assessment: hatch.chick_assessment ?? null,
              }}
            />
          </aside>
        </div>

        <div className="h-16" />
      </main>
    </div>
  );
}

// Format the hatch set-at moment as "DD/MM/YYYY at HH:mm" in the user's TZ.
// Uses created_at as a proxy for "when eggs were set" — for most users the
// hatch record is created on the web UI within minutes of setting.
function formatSetAt(createdAtIso: string, tz: string): string {
  const d = new Date(createdAtIso);
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: tz,
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).format(d);
  return `${date} at ${time}`;
}

function phaseLabel(
  dayNumber: number,
  lockdown: number,
  expected: number,
  status: string,
) {
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  // dayNumber is 1-indexed (Day 1 = setting day). Phase boundaries match
  // standard incubation convention: lockdown starts on `lockdown`-th day,
  // hatch on `expected`-th day.
  if (dayNumber < lockdown) return `Day ${dayNumber} — turning`;
  if (dayNumber < expected) return `Day ${dayNumber} — lockdown`;
  if (dayNumber === expected) return `Day ${dayNumber} — hatch day`;
  return `Day ${dayNumber} — overdue`;
}

function Badge({
  status,
}: {
  status: "active" | "completed" | "failed";
}) {
  // Traffic-light convention: green = currently healthy/active, gold =
  // successfully finished (a trophy state, distinct from "in progress"),
  // red = error/failed.
  const map: Record<string, { label: string; cls: string }> = {
    active: {
      label: "Active",
      cls: "border-green-400/40 bg-green-400/10 text-green-300",
    },
    completed: {
      label: "Completed",
      cls: "border-light/30 bg-light/10 text-light",
    },
    failed: {
      label: "Failed",
      cls: "border-red-500/30 bg-red-500/10 text-red-300",
    },
  };
  const c = map[status];
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${c.cls}`}
    >
      {c.label}
    </span>
  );
}

// StatCard — the generic "big number + label + target" card used in the
// at-a-glance row. Incubator styling (gold-ish). Ambient has its own
// inline version using amber.
function StatCard({
  label,
  value,
  unit,
  target,
}: {
  label: string;
  value: string;
  unit: string;
  target?: string;
}) {
  return (
    <div className="card">
      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-2 tabular-nums">
        <span className="text-3xl font-bold text-white">{value}</span>
        <span className="text-sm text-white/40">{unit}</span>
      </div>
      {target && (
        <div className="mt-3 text-xs text-white/50">{target}</div>
      )}
    </div>
  );
}

// Averages the latest temperature across all sensors (incubator only) for
// the at-a-glance card. Returns formatted to 2 decimals, or "—" if none.
function linkedLatestTemp(
  sensors: Array<{
    latest?: {
      temperature: number | null;
      humidity: number | null;
      recorded_at: string;
    } | null;
  }>,
): string {
  const values = sensors
    .map((s) => s.latest?.temperature)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return "—";
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return avg.toFixed(2);
}

function linkedLatestHumidity(
  sensors: Array<{
    latest?: {
      temperature: number | null;
      humidity: number | null;
      recorded_at: string;
    } | null;
  }>,
): string {
  const values = sensors
    .map((s) => s.latest?.humidity)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return "—";
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return avg.toFixed(1);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-white/50">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function formatEggSource(
  source: string | null,
  detail: string | null,
): string {
  if (!source) return "—";
  const labels: Record<string, string> = {
    own_flock: "Own flock",
    purchased: "Purchased",
    shipped: "Shipped",
    other: "Other",
  };
  const base = labels[source] ?? source;
  return detail ? `${base} — ${detail}` : base;
}

