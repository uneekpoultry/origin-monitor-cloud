"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { createClient } from "@/lib/supabase/client";

type Reading = {
  recorded_at: string;
  temperature: number | null;
  humidity: number | null;
};

type Range = "24h" | "7d" | "30d";

const RANGES: { key: Range; label: string; hours: number }[] = [
  { key: "24h", label: "Last 24 hours", hours: 24 },
  { key: "7d", label: "Last 7 days", hours: 24 * 7 },
  { key: "30d", label: "Last 30 days", hours: 24 * 30 },
];

export function SensorChart({
  sensorId,
  initial,
}: {
  sensorId: string;
  initial: Reading[];
}) {
  const [range, setRange] = useState<Range>("24h");
  const [loading, setLoading] = useState(false);
  const [readings, setReadings] = useState<Reading[]>(initial);

  useEffect(() => {
    if (range === "24h") {
      // Initial data was pre-fetched server-side for 24h
      setReadings(initial);
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const since = new Date(
      Date.now() -
        RANGES.find((r) => r.key === range)!.hours * 60 * 60 * 1000,
    ).toISOString();
    supabase
      .from("sensor_readings")
      .select("recorded_at, temperature, humidity")
      .eq("sensor_id", sensorId)
      .gte("recorded_at", since)
      .order("recorded_at", { ascending: true })
      .limit(5000)
      .then(({ data }) => {
        setReadings(data ?? []);
        setLoading(false);
      });
  }, [range, sensorId, initial]);

  const data = useMemo(
    () =>
      readings.map((r) => ({
        t: new Date(r.recorded_at).getTime(),
        temp: r.temperature,
        hum: r.humidity,
      })),
    [readings],
  );

  const tickFormatter = (ts: number) => {
    const d = new Date(ts);
    if (range === "24h") {
      return d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    }
    return d.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "2-digit",
    });
  };

  return (
    <div className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Temperature & humidity</h2>
        <div className="inline-flex rounded-lg border border-white/10 bg-black/20 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                range === r.key
                  ? "bg-light/15 text-light"
                  : "text-white/60 hover:text-white"
              }`}
            >
              {r.key}
            </button>
          ))}
        </div>
      </div>

      {data.length === 0 ? (
        <p className="py-12 text-center text-sm text-white/50">
          {loading ? "Loading…" : "No readings in this range yet."}
        </p>
      ) : (
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 8, right: 16, bottom: 4, left: 0 }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={tickFormatter}
                stroke="rgba(255,255,255,0.4)"
                tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 11 }}
                minTickGap={40}
              />
              <YAxis
                yAxisId="temp"
                orientation="left"
                stroke="#c49a46"
                tick={{ fill: "#c49a46", fontSize: 11 }}
                tickFormatter={(v) => `${v.toFixed(1)}`}
                domain={["auto", "auto"]}
                width={40}
              />
              <YAxis
                yAxisId="hum"
                orientation="right"
                stroke="#e5c880"
                tick={{ fill: "#e5c880", fontSize: 11 }}
                tickFormatter={(v) => `${v.toFixed(0)}`}
                domain={["auto", "auto"]}
                width={34}
              />
              <Tooltip
                contentStyle={{
                  background: "#0a0f0a",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "rgba(255,255,255,0.6)" }}
                labelFormatter={(ts) => {
                  const d = new Date(ts as number);
                  return d.toLocaleString(undefined, {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  });
                }}
                formatter={(value, name) => {
                  const n = typeof value === "number" ? value : Number(value);
                  if (!Number.isFinite(n)) return ["—", String(name ?? "")];
                  if (name === "Temperature")
                    return [`${n.toFixed(2)} °C`, name];
                  if (name === "Humidity")
                    return [`${n.toFixed(1)} %`, name];
                  return [String(value ?? "—"), String(name ?? "")];
                }}
              />
              <Line
                yAxisId="temp"
                type="monotone"
                dataKey="temp"
                name="Temperature"
                stroke="#c49a46"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                yAxisId="hum"
                type="monotone"
                dataKey="hum"
                name="Humidity"
                stroke="#e5c880"
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-white/50">
        <div className="flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 bg-grass" />
            Temperature (°C)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 border-t-2 border-dashed border-light" />
            Humidity (%)
          </span>
        </div>
        <span>{data.length.toLocaleString()} readings</span>
      </div>
    </div>
  );
}
