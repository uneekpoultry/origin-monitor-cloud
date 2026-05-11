"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  registerPrimus,
  requestResync,
  revokePrimus,
  rotatePrimusKey,
} from "./actions";
import { Timestamp } from "@/components/timestamp";

type User = { id: string; label: string };
type Device = {
  id: string;
  name: string | null;
  user_id: string;
  user_label: string;
  firmware_version: string | null;
  last_seen: string | null;
  registered_at: string;
};

export function PrimusPanel({
  users,
  devices,
}: {
  users: User[];
  devices: Device[];
}) {
  const [pending, startTransition] = useTransition();
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    tone: "ok" | "err";
    text: string;
  } | null>(null);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setIssuedKey(null);
    setMessage(null);
    startTransition(async () => {
      const r = await registerPrimus(userId, name);
      if (r.error) setMessage({ tone: "err", text: r.error });
      else if (r.apiKey) {
        setIssuedKey(r.apiKey);
        setMessage({ tone: "ok", text: r.message ?? "" });
        setUserId("");
        setName("");
      }
    });
  }

  function handleRevoke(deviceId: string, label: string) {
    if (!confirm(`Revoke "${label}"? The device will stop working.`)) return;
    startTransition(async () => {
      const r = await revokePrimus(deviceId);
      if (r.error) setMessage({ tone: "err", text: r.error });
      else setMessage({ tone: "ok", text: r.message ?? "" });
    });
  }

  function handleResync(deviceId: string, label: string) {
    const input = prompt(
      `Request resync for "${label}" — optional start time (ISO, e.g. 2026-04-22T00:00:00Z). Leave blank for full sensor-buffer replay.`,
      "",
    );
    if (input === null) return; // cancel
    const sinceIso = input.trim() || null;
    if (sinceIso) {
      const parsed = new Date(sinceIso);
      if (isNaN(parsed.getTime())) {
        setMessage({
          tone: "err",
          text: "That doesn't look like a valid ISO date.",
        });
        return;
      }
    }
    startTransition(async () => {
      const r = await requestResync(deviceId, sinceIso);
      if (r.error) setMessage({ tone: "err", text: r.error });
      else setMessage({ tone: "ok", text: r.message ?? "Resync queued." });
    });
  }

  function handleRotate(deviceId: string, label: string) {
    if (
      !confirm(
        `Rotate API key for "${label}"? The old key will stop working immediately.`,
      )
    )
      return;
    startTransition(async () => {
      const r = await rotatePrimusKey(deviceId);
      if (r.error) setMessage({ tone: "err", text: r.error });
      else if (r.apiKey) {
        setIssuedKey(r.apiKey);
        setMessage({ tone: "ok", text: r.message ?? "" });
      }
    });
  }

  return (
    <div className="space-y-10">
      <section className="card">
        <h2 className="text-lg font-semibold">Register a new Primus</h2>
        <p className="mt-1 text-sm text-white/60">
          Assigns the basestation to a customer and issues its API key.
        </p>
        <form onSubmit={handleRegister} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Owner
            </label>
            <select
              required
              className="input"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            >
              <option value="">Select a customer…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Device name
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Main hatching room"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button className="btn-primary" disabled={pending}>
            {pending ? "Registering…" : "Register & issue key"}
          </button>
        </form>
      </section>

      {issuedKey && (
        <div className="card border-light/40 bg-light/[0.04]">
          <h2 className="text-lg font-semibold text-light">
            API key — copy now
          </h2>
          <p className="mt-1 text-sm text-white/60">
            This key is shown only once. Paste it into the Primus device
            settings. If lost, you'll have to rotate to issue a new one.
          </p>
          <div className="mt-4 overflow-x-auto rounded-md bg-black/40 p-3 font-mono text-sm text-light">
            {issuedKey}
          </div>
          <button
            onClick={() => {
              navigator.clipboard.writeText(issuedKey);
              setMessage({ tone: "ok", text: "Copied to clipboard." });
            }}
            className="btn-primary mt-4"
          >
            Copy to clipboard
          </button>
        </div>
      )}

      {message && (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            message.tone === "ok"
              ? "border-light/30 bg-light/10 text-light"
              : "border-red-500/30 bg-red-500/10 text-red-300"
          }`}
        >
          {message.text}
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold">Registered devices</h2>
        {devices.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">
            No Primus devices registered yet.
          </p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-white/5">
            <table className="w-full text-sm">
              <thead className="bg-white/[0.02] text-left text-xs uppercase tracking-widest text-white/40">
                <tr>
                  <th className="px-4 py-3">Device</th>
                  <th className="px-4 py-3">Owner</th>
                  <th className="px-4 py-3">Firmware</th>
                  <th className="px-4 py-3">Last seen</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => {
                  const label = d.name || d.id.slice(0, 8);
                  return (
                    <tr key={d.id} className="border-t border-white/5">
                      <td className="px-4 py-3">{label}</td>
                      <td className="px-4 py-3 text-white/70">{d.user_label}</td>
                      <td className="px-4 py-3 text-white/70">
                        {d.firmware_version || "—"}
                      </td>
                      <td className="px-4 py-3 text-white/50">
                        {d.last_seen ? <Timestamp iso={d.last_seen} /> : "Never"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleResync(d.id, label)}
                          className="mr-3 text-light hover:underline disabled:opacity-50"
                          disabled={pending}
                        >
                          Resync
                        </button>
                        <Link
                          href={`/admin/primus/${d.id}/events`}
                          className="mr-3 text-white/70 hover:underline"
                        >
                          Events
                        </Link>
                        <button
                          onClick={() => handleRotate(d.id, label)}
                          className="mr-3 text-white/60 hover:underline disabled:opacity-50"
                          disabled={pending}
                        >
                          Rotate key
                        </button>
                        <button
                          onClick={() => handleRevoke(d.id, label)}
                          className="text-red-300 hover:underline disabled:opacity-50"
                          disabled={pending}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
