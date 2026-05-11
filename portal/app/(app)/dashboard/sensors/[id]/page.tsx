import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SensorEditor } from "./sensor-editor";
import { SensorChart } from "./sensor-chart";
import { Timestamp } from "@/components/timestamp";
import { batteryStatus, batteryToneClass } from "@/lib/battery";

export const dynamic = "force-dynamic";

export default async function SensorDetailPage({
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

  const { data: sensor } = await supabase
    .from("sensors")
    .select(
      "id, serial_number, model, name, registered_at, last_seen, firmware_version, calibration_date, calibration_due_date, calibration_certificate_url, is_ambient",
    )
    .eq("id", id)
    .maybeSingle();

  if (!sensor) notFound();

  const [{ data: recent }, { data: last24Chart }, { count: readingsTotal }] =
    await Promise.all([
      supabase
        .from("sensor_readings")
        .select("temperature, humidity, battery_mv, recorded_at")
        .eq("sensor_id", id)
        .order("recorded_at", { ascending: false })
        .limit(20),
      supabase
        .from("sensor_readings")
        .select("recorded_at, temperature, humidity")
        .eq("sensor_id", id)
        .gte(
          "recorded_at",
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        )
        .order("recorded_at", { ascending: true })
        .limit(5000),
      supabase
        .from("sensor_readings")
        .select("*", { count: "exact", head: true })
        .eq("sensor_id", id),
    ]);

  const latest = recent?.[0];

  return (
    <div className="min-h-screen">
      <header className="border-b border-white/5">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <Link href="/dashboard" className="text-sm text-white/60 hover:text-white">
            ← Dashboard
          </Link>
          <span className="text-sm text-white/60">{user.email}</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <div>
          <p className="text-xs uppercase tracking-widest text-light">
            {sensor.model === "pro" ? "Origin Pro" : "Origin Lite"}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            {sensor.name || sensor.serial_number}
          </h1>
          <p className="mt-1 font-mono text-sm text-white/50">
            {sensor.serial_number}
          </p>
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-4">
          <StatCard
            label="Current temp"
            value={
              latest?.temperature != null
                ? `${latest.temperature.toFixed(2)} °C`
                : "—"
            }
            sub={latest ? timeAgo(latest.recorded_at) : "no data yet"}
          />
          <StatCard
            label="Current humidity"
            value={
              latest?.humidity != null
                ? `${latest.humidity.toFixed(1)} %`
                : "—"
            }
            sub={latest ? timeAgo(latest.recorded_at) : "no data yet"}
          />
          <BatteryStatCard mv={latest?.battery_mv ?? null} />
          <StatCard
            label="Readings (total)"
            value={(readingsTotal ?? 0).toLocaleString("en-AU")}
            sub="Since registration"
          />
        </div>

        <div className="mt-8">
          <SensorChart sensorId={sensor.id} initial={last24Chart ?? []} />
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-[1fr_340px]">
          <section>
            <h2 className="text-lg font-semibold">Recent readings</h2>
            {!recent || recent.length === 0 ? (
              <p className="mt-4 text-sm text-white/50">
                No readings yet. Once your Origin Primus basestation is
                connected and within BLE range of this sensor, live data will
                appear here.
              </p>
            ) : (
              <div className="mt-4 overflow-hidden rounded-xl border border-white/5">
                <table className="w-full text-sm">
                  <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
                    <tr>
                      <th className="px-4 py-3">When</th>
                      <th className="px-4 py-3">Temp</th>
                      <th className="px-4 py-3">Humidity</th>
                      <th className="px-4 py-3">Battery</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r, i) => {
                      const bat = batteryStatus(r.battery_mv);
                      return (
                        <tr key={i} className="border-t border-white/5">
                          <td className="px-4 py-2 text-white/70">
                            <Timestamp iso={r.recorded_at} />
                          </td>
                          <td className="px-4 py-2 tabular-nums">
                            {r.temperature != null
                              ? `${r.temperature.toFixed(2)} °C`
                              : "—"}
                          </td>
                          <td className="px-4 py-2 tabular-nums">
                            {r.humidity != null
                              ? `${r.humidity.toFixed(1)} %`
                              : "—"}
                          </td>
                          <td
                            className={`px-4 py-2 tabular-nums ${bat ? batteryToneClass(bat.tone) : "text-white/60"}`}
                          >
                            {bat ? `${bat.percent}%` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <aside className="space-y-6">
            <div className="card">
              <h2 className="text-lg font-semibold">Sensor info</h2>
              <dl className="mt-4 space-y-2 text-sm">
                <Row label="Model">
                  {sensor.model === "pro" ? "Origin Pro" : "Origin Lite"}
                </Row>
                <Row label="Firmware">
                  {sensor.firmware_version || "—"}
                </Row>
                <Row label="Registered">
                  <Timestamp iso={sensor.registered_at} mode="date" />
                </Row>
                <Row label="Last seen">
                  {sensor.last_seen
                    ? timeAgo(sensor.last_seen)
                    : "Never"}
                </Row>
                {sensor.model === "pro" && (
                  <>
                    <Row label="Calibrated">
                      {sensor.calibration_date || "Pending"}
                    </Row>
                    <Row label="Next calibration">
                      {sensor.calibration_due_date || "—"}
                    </Row>
                    <Row label="Certificate">
                      {sensor.calibration_certificate_url ? (
                        <a
                          href={sensor.calibration_certificate_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-light hover:underline"
                        >
                          Download PDF
                        </a>
                      ) : (
                        "—"
                      )}
                    </Row>
                  </>
                )}
              </dl>
            </div>

            <SensorEditor
              sensorId={sensor.id}
              initialName={sensor.name}
              initialModel={(sensor.model as "pro" | "lite") ?? "pro"}
              initialIsAmbient={sensor.is_ambient ?? false}
            />
          </aside>
        </div>
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="card">
      <div className="text-xs font-semibold uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-white/50">{sub}</div>
    </div>
  );
}

function BatteryStatCard({ mv }: { mv: number | null }) {
  const bat = batteryStatus(mv);
  return (
    <div className="card">
      <div className="text-xs font-semibold uppercase tracking-widest text-white/40">
        Battery
      </div>
      {bat ? (
        <>
          <div
            className={`mt-2 text-2xl font-bold tabular-nums ${batteryToneClass(bat.tone)}`}
          >
            {bat.label}
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
            <div
              className={
                bat.tone === "good"
                  ? "h-full bg-light"
                  : bat.tone === "ok"
                    ? "h-full bg-white/70"
                    : bat.tone === "low"
                      ? "h-full bg-amber-300"
                      : "h-full bg-red-300"
              }
              style={{ width: `${bat.percent}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-white/50">
            {bat.percent}% · last reading
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 text-2xl font-bold tabular-nums">—</div>
          <div className="mt-1 text-xs text-white/50">No reading yet</div>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-white/50">{label}</dt>
      <dd className="text-right">{children || "—"}</dd>
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
