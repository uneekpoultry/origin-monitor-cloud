import { Router } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import {
  humidityTargetForPhase,
  phaseForDay,
  speciesTarget,
} from "../lib/species-targets.js";
import {
  requirePrimusAuth,
  type PrimusAuthedRequest,
} from "../middleware/primus-auth.js";

export const primusRouter = Router();

// ----------------------------------------------------------------------------
// makeStageTimer — small helper for Server-Timing header generation.
//
// Use:
//   const t = makeStageTimer();
//   await stage1();   t.mark("stage1");
//   await stage2();   t.mark("stage2");
//   res.setHeader("Server-Timing", t.header());
//
// The Primus reads the Server-Timing response header to log a per-stage
// breakdown of where the cloud spent its time. Standardised header
// format per W3C Server-Timing spec:
//   Server-Timing: stage1;dur=12, stage2;dur=45
//
// Stage names are kept SHORT (≤8 chars) to fit comfortably in the header
// without bloating the response — the Primus parses these to extract
// timing info, but they're also human-readable when staring at the log.
// ----------------------------------------------------------------------------
function makeStageTimer(): {
  mark: (name: string) => void;
  header: () => string;
} {
  const stages: { name: string; ms: number }[] = [];
  let last = Date.now();
  return {
    mark(name) {
      const now = Date.now();
      stages.push({ name, ms: now - last });
      last = now;
    },
    header() {
      return stages
        .filter((s) => s.ms > 0)
        .map((s) => `${s.name};dur=${s.ms}`)
        .join(", ");
    },
  };
}


// ---------- TLS warm-up endpoint ----------
// Lightweight no-op endpoint the Primus calls right after `STA_GOT_IP`,
// BEFORE the first authenticated heartbeat. Purpose: do the expensive
// first TLS handshake (mbedtls allocates session state in PSRAM, peer
// cert chain, record buffer) at a quiet moment, so when the user-visible
// heartbeat fires its TLS state is already warm. Reduces the PSRAM
// contention spike that causes display tearing on first cloud-connect
// on the ESP32-S3 + 4.3" RGB LCD hardware.
//
// Auth is intentionally REQUIRED so this can't be hammered anonymously,
// but the handler does zero DB work beyond the one indexed lookup
// performed by the auth middleware. Response body is < 30 bytes.
primusRouter.get(
  "/ping",
  requirePrimusAuth,
  async (_req: PrimusAuthedRequest, res) => {
    res.json({ ok: true, t: Date.now() });
  },
);

// ---------- List sensors owned by this Primus's user ----------
// Primus polls this (e.g. every 60s) to pick up name/model changes made via
// the web portal or the Origin Monitor app, plus settings changes synced
// from any of the three readers (Primus, App, Cloud admin). Returns both
// claimed and pending sensors — Primus can decide which to display.
//
// `settings` is the JSONB blob per CLAUDE_PRIMUS_GLOBAL_SETTINGS_SCHEMA.md:
//   { version: 1,
//     calibration_temp_offset, calibration_humid_offset,
//     alert_temp_low, alert_temp_high, alert_humid_low, alert_humid_high,
//     alert_temp_low_enabled, alert_temp_high_enabled,
//     alert_humid_low_enabled, alert_humid_high_enabled }
// All settings fields except `version` are optional/nullable. Missing
// field = "not set, use default" — readers must apply defaults locally.
primusRouter.get(
  "/sensors",
  requirePrimusAuth,
  async (req: PrimusAuthedRequest, res) => {
    const { data, error } = await supabaseAdmin
      .from("sensors")
      .select(
        "id, serial_number, name, model, claimed_at, last_seen, firmware_version, is_ambient, settings, settings_updated_at",
      )
      .eq("user_id", req.primus!.userId)
      .order("registered_at", { ascending: true });

    if (error) {
      console.error("primus sensors list error", error);
      return res.status(500).json({ error: "list_failed" });
    }
    res.json({ sensors: data ?? [] });
  },
);

// ---------- Update a sensor's name and/or settings from Primus ----------
//
// Name is a top-level scalar (preserves the original v1 contract). The
// new `settings` block is a partial JSON object that gets deep-merged
// into the existing `sensors.settings` JSONB column. Either field can
// be sent independently or both together — at least one of them is
// required.
//
// Schema is the canonical "global per-sensor settings v1" agreed
// across Primus / App / Cloud. See CLAUDE_PRIMUS_GLOBAL_SETTINGS_SCHEMA.md
// for the full spec, defaults, and sync rules.
const sensorSettingsSchema = z
  .object({
    version: z.literal(1).optional(),
    calibration_temp_offset: z.number().min(-10).max(10).optional(),
    calibration_humid_offset: z.number().min(-20).max(20).optional(),
    alert_temp_low: z.number().min(-40).max(80).nullable().optional(),
    alert_temp_high: z.number().min(-40).max(80).nullable().optional(),
    alert_humid_low: z.number().min(0).max(100).nullable().optional(),
    alert_humid_high: z.number().min(0).max(100).nullable().optional(),
    alert_temp_low_enabled: z.boolean().optional(),
    alert_temp_high_enabled: z.boolean().optional(),
    alert_humid_low_enabled: z.boolean().optional(),
    alert_humid_high_enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (s) =>
      s.alert_temp_low == null ||
      s.alert_temp_high == null ||
      s.alert_temp_low < s.alert_temp_high,
    {
      message: "alert_temp_low must be less than alert_temp_high",
      path: ["alert_temp_low"],
    },
  )
  .refine(
    (s) =>
      s.alert_humid_low == null ||
      s.alert_humid_high == null ||
      s.alert_humid_low < s.alert_humid_high,
    {
      message: "alert_humid_low must be less than alert_humid_high",
      path: ["alert_humid_low"],
    },
  );

const patchSensorSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    settings: sensorSettingsSchema.optional(),
  })
  .refine((b) => b.name !== undefined || b.settings !== undefined, {
    message: "must include at least one of: name, settings",
  });

// ---------- Hatches dashboard ----------
// Used by the Primus 4.3" LCD to show active hatch status at a glance.
// Poll every ~5 minutes. Returns up to 10 active hatches (Primus paginates
// in-UI if there's more than one).
primusRouter.get(
  "/hatches",
  requirePrimusAuth,
  async (req: PrimusAuthedRequest, res) => {
    const userId = req.primus!.userId;

    const { data: hatches, error } = await supabaseAdmin
      .from("hatch_logs")
      .select(
        "id, name, species, start_date, expected_hatch_date, ambient_sensor_id",
      )
      .eq("user_id", userId)
      .eq("status", "active")
      .order("start_date", { ascending: false })
      .limit(10);

    if (error) {
      console.error("primus hatches list error", error);
      return res.status(500).json({ error: "list_failed" });
    }
    if (!hatches || hatches.length === 0) {
      return res.json({ active: [] });
    }

    const active = await Promise.all(
      hatches.map(async (h) => buildHatchDashboard(h)),
    );

    res.json({ active });
  },
);

// ---------- Trigger an email of the current hatch report ----------
// Primus presses a button; cloud builds + emails the XLSX to the owner's
// account email. Body { hatch_id? } — if omitted, picks the user's most
// recent active hatch.
primusRouter.post(
  "/email-report",
  requirePrimusAuth,
  async (req: PrimusAuthedRequest, res) => {
    const userId = req.primus!.userId;

    let hatchId =
      typeof req.body?.hatch_id === "string" ? req.body.hatch_id : null;

    if (!hatchId) {
      const { data } = await supabaseAdmin
        .from("hatch_logs")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "active")
        .order("start_date", { ascending: false })
        .limit(1);
      hatchId = data?.[0]?.id ?? null;
    }
    if (!hatchId) {
      return res.status(404).json({
        ok: false,
        error: "no_active_hatch",
        message: "No active hatch for this Primus's owner.",
      });
    }

    const portalBase =
      process.env.PORTAL_INTERNAL_URL ??
      process.env.NEXT_PUBLIC_SITE_URL ??
      "http://127.0.0.1:3000";
    const serviceKey = process.env.SUPABASE_SECRET_KEY;
    if (!serviceKey) {
      return res.status(500).json({ error: "missing_service_key" });
    }

    try {
      const portalRes = await fetch(
        `${portalBase}/internal/primus-email-report`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            user_id: userId,
            hatch_id: hatchId,
            source: "primus",
          }),
        },
      );
      const payload: unknown = await portalRes.json().catch(() => ({}));
      if (!portalRes.ok) {
        return res.status(portalRes.status).json(payload);
      }
      return res.json(payload);
    } catch (err: unknown) {
      console.error("primus/email-report proxy failed", err);
      return res.status(502).json({ error: "portal_unreachable" });
    }
  },
);

primusRouter.patch(
  "/sensors/:id",
  requirePrimusAuth,
  async (req: PrimusAuthedRequest, res) => {
    const { id } = req.params;
    const parsed = patchSensorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    }

    // If settings are being updated, deep-merge into the existing
    // JSONB rather than overwriting it. The PATCH semantic is partial
    // update — sender ships only what changed, cloud preserves
    // everything else. We do this in two steps (read existing, merge,
    // write) under a single round-trip per request — Postgres jsonb
    // concatenation operator (||) does deep merge for top-level keys
    // which is what we want for a flat settings shape.
    //
    // Cloud always sets settings_updated_at = now() on a successful
    // settings update. Clients must NOT send their own value for it.
    const updatePayload: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) {
      updatePayload.name = parsed.data.name;
    }
    if (parsed.data.settings !== undefined) {
      // Always stamp version: 1 on every settings write so the merge
      // always lands a defined version field even if the client
      // omitted it. Cheap forward compatibility.
      const incoming = { version: 1, ...parsed.data.settings };

      // Read existing settings, merge, write back. The .single()
      // ensures we get an error if no row matched (caught below).
      const { data: existing, error: readErr } = await supabaseAdmin
        .from("sensors")
        .select("settings")
        .eq("id", id)
        .eq("user_id", req.primus!.userId)
        .not("claimed_at", "is", null)
        .maybeSingle();

      if (readErr) {
        console.error("primus sensor settings read error", readErr);
        return res.status(500).json({ error: "update_failed" });
      }
      if (!existing) {
        return res.status(404).json({ error: "not_found_or_pending" });
      }

      const merged = {
        ...((existing.settings as Record<string, unknown>) ?? {}),
        ...incoming,
      };
      updatePayload.settings = merged;
      updatePayload.settings_updated_at = new Date().toISOString();
    }

    // Scope: only the Primus's user's sensors; only claimed ones
    // (pending sensors get their name from advertised_name on
    // readings).
    const { data, error } = await supabaseAdmin
      .from("sensors")
      .update(updatePayload)
      .eq("id", id)
      .eq("user_id", req.primus!.userId)
      .not("claimed_at", "is", null)
      .select("id, name, settings, settings_updated_at")
      .maybeSingle();

    if (error) {
      console.error("primus sensor patch error", error);
      return res.status(500).json({ error: "update_failed" });
    }
    if (!data) {
      return res.status(404).json({ error: "not_found_or_pending" });
    }
    res.json({
      ok: true,
      id: data.id,
      name: data.name,
      settings: data.settings,
      settings_updated_at: data.settings_updated_at,
    });
  },
);

// ---------- Heartbeat ----------
const heartbeatSchema = z.object({
  firmware_version: z.string().optional(),
  wifi_ssid: z.string().optional(),
  // IANA timezone (e.g. "Australia/Perth"). Used to populate profile.timezone
  // for this Primus's owner if they haven't set it themselves.
  timezone: z.string().max(60).optional(),
  // Recent entries from the Primus's on-device log ring buffers (sensor
  // warnings + cloud warnings/errors). Primus may retransmit the same
  // entries across heartbeats until they're acked — dedup is
  // (primus_id, observed_at, source, message). Capped at 200 per
  // heartbeat to accommodate the 2026-05-01 cadence change (heartbeat
  // moved from 60s to up to 10 min, so events accumulate longer in the
  // Primus's on-device ring before each upload).
  events: z
    .array(
      z.object({
        observed_at: z.string().datetime(),
        severity: z.enum(["info", "warn", "error"]),
        source: z.string().trim().min(1).max(40),
        message: z.string().trim().min(1).max(500),
      }),
    )
    .max(200)
    .optional(),
  // Results for commands previously delivered in a heartbeat response.
  // Primus reports here after executing. See /docs/PRIMUS_ADDENDUM_COMMANDS.md
  command_results: z
    .array(
      z.object({
        id: z.string().uuid(),
        status: z.enum(["ok", "error"]),
        result: z.record(z.unknown()).optional(),
      }),
    )
    .max(20)
    .optional(),
});

const PRIMUS_EVENTS_RETENTION_PER_DEVICE = 500;
const PRIMUS_COMMANDS_PER_HEARTBEAT = 10;

primusRouter.post(
  "/heartbeat",
  requirePrimusAuth,
  async (req: PrimusAuthedRequest, res) => {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    }

    // Stage timer for Server-Timing header. The Primus reads this to log
    // a per-stage breakdown of where the cloud spent its time. Useful
    // when diagnosing slow heartbeats — distinguishes DB-bound from
    // logic-bound from RPC-bound stages. Overhead per stage call is
    // microseconds (Date.now() + Map ops); negligible vs the work itself.
    const t = makeStageTimer();

    // First-after-absence detection. If the Primus's previous last_seen
    // was > 30 min ago (or never), this is the first heartbeat of a new
    // session — defer non-essential work to keep the response cheap.
    //
    // 2026-05-01: threshold widened from 2 min → 30 min after the
    // heartbeat cadence moved from 60s to up to 10 min (BLE-scan PSRAM
    // contention mitigation — see DISPLAY_TEARING_INVESTIGATION.md).
    // With 10-min cadence, a 2-min threshold would trigger on EVERY
    // heartbeat, defeating the purpose. 30 min = "real outage of more
    // than 2-3 missed cycles" — only fires on a true reboot or
    // multi-cycle Wi-Fi loss.
    //
    // Display-tearing is no longer the primary motivation for the
    // deferred path (BLE scanning was the actual root cause and that
    // mitigation lives firmware-side now), but the deferred path is
    // still useful for keeping the post-reboot heartbeat cheap.
    //
    // On a deferred heartbeat we still process command_results (state
    // changes can't safely be deferred — the Primus expects ack), but
    // we skip everything else: no events ingest, no gap-detection, no
    // opportunistic backlog, no retry sweep, no commands delivered.
    // Response is minimal (~30 bytes), Primus parses it cheaply, the
    // peak contention spike shrinks substantially. Real work happens
    // 60s later on the next heartbeat, when the icon is already green
    // and steady-state and there's no transition spike to worry about.
    const FIRST_AFTER_ABSENCE_MS = 30 * 60 * 1000;
    const { data: prevDevice } = await supabaseAdmin
      .from("primus_devices")
      .select("last_seen")
      .eq("id", req.primus!.deviceId)
      .maybeSingle();
    const prevLastSeenMs = prevDevice?.last_seen
      ? new Date(prevDevice.last_seen).getTime()
      : 0;
    const isFirstAfterAbsence =
      prevLastSeenMs === 0 ||
      Date.now() - prevLastSeenMs > FIRST_AFTER_ABSENCE_MS;

    const { error } = await supabaseAdmin
      .from("primus_devices")
      .update({
        last_seen: new Date().toISOString(),
        firmware_version: parsed.data.firmware_version,
        wifi_ssid: parsed.data.wifi_ssid,
      })
      .eq("id", req.primus!.deviceId);

    if (error) {
      console.error("heartbeat update error", error);
      return res.status(500).json({ error: "update_failed" });
    }
    t.mark("dev"); // primus_devices read + update

    // If Primus reports a timezone and the owner's profile is still the
    // "UTC" default, adopt Primus's TZ. Don't override a manually-set value.
    const primusTz = parsed.data.timezone?.trim();
    if (primusTz && primusTz !== "UTC") {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("timezone")
        .eq("id", req.primus!.userId)
        .maybeSingle();
      if (profile && (profile.timezone === "UTC" || !profile.timezone)) {
        await supabaseAdmin
          .from("profiles")
          .update({ timezone: primusTz })
          .eq("id", req.primus!.userId);
      }
    }
    t.mark("tz"); // timezone adoption (no-op when not needed)

    // Ingest events from the Primus's on-device log ring buffers. Dedup is
    // (primus_id, observed_at, source, message) — Primus retransmits until
    // acked, so duplicates across heartbeats are expected. Response echoes
    // the dedup keys it saw so the firmware can purge its ring buffer.
    //
    // SKIPPED on first-after-absence heartbeat to keep this response
    // minimal during the display-tearing-prone moment. Events stay in
    // the Primus's ring buffer (retransmitted next cycle) — no data loss.
    const acked: { observed_at: string; source: string; message: string }[] = [];
    const incomingEvents = parsed.data.events ?? [];
    if (incomingEvents.length > 0 && !isFirstAfterAbsence) {
      const rows = incomingEvents.map((e) => ({
        primus_id: req.primus!.deviceId,
        observed_at: e.observed_at,
        severity: e.severity,
        source: e.source,
        message: e.message,
      }));

      const { error: eventsErr } = await supabaseAdmin
        .from("primus_events")
        .upsert(rows, {
          onConflict: "primus_id,observed_at,source,message",
          ignoreDuplicates: true,
        });

      if (eventsErr) {
        console.error("heartbeat events upsert error", eventsErr);
        // Don't fail the whole heartbeat — Primus will retry these events
        // on its next heartbeat (they're still in its ring buffer).
      } else {
        // Ack every incoming row (whether newly inserted or deduped — both
        // are now safely stored), so Primus can free the buffer slots.
        for (const e of incomingEvents) {
          acked.push({
            observed_at: e.observed_at,
            source: e.source,
            message: e.message,
          });
        }

        // Trim to N newest for this device. Cheap single query; runs only
        // when a heartbeat actually wrote events, not on every heartbeat.
        await supabaseAdmin.rpc("trim_primus_events", {
          p_primus_id: req.primus!.deviceId,
          p_keep: PRIMUS_EVENTS_RETENTION_PER_DEVICE,
        });
      }
    }
    t.mark("events"); // events ingest + trim

    const nowMs = Date.now();

    // Record results for commands the Primus has finished executing. This
    // runs before we hand out new commands so a device reporting + polling
    // in the same request gets a clean cycle.
    const incomingResults = parsed.data.command_results ?? [];
    let justCompletedResyncSuccessfully = false;
    // Side-effect events raised during result processing (a recurring
    // Primus "skipped" needs support visibility). Batched after the loop.
    const resultDerivedEvents: {
      primus_id: string;
      observed_at: string;
      severity: "warn";
      source: string;
      message: string;
    }[] = [];
    if (incomingResults.length > 0) {
      for (const r of incomingResults) {
        // Scope to this device so a compromised key can't mark another
        // device's commands complete.
        const { data: updated } = await supabaseAdmin
          .from("primus_commands")
          .update({
            completed_at: new Date().toISOString(),
            result: { status: r.status, ...(r.result ?? {}) },
          })
          .eq("id", r.id)
          .eq("primus_id", req.primus!.deviceId)
          .select("type, params")
          .maybeSingle();

        if (updated?.type !== "resync") continue;

        // ── fine_status: the richer resync outcome lives inside the
        // result JSON (the wire `status` stays a binary ok|error so the
        // schema contract doesn't change). Old firmware doesn't send it
        // — fall back to the binary status, mapping a bare "error" to
        // "skipped" so the retry sweep re-queues, matching the
        // pre-fine_status behaviour where any non-ok set fulfilled_error.
        // New firmware sends ok | partial | no_data | skipped.
        // Contract: CLAUDE_PRIMUS_RESYNC_FIXES.md §Priority 1.
        const result = (r.result ?? {}) as Record<string, unknown>;
        const rawFine = result.fine_status;
        const fineStatus: "ok" | "partial" | "no_data" | "skipped" =
          rawFine === "ok" ||
          rawFine === "partial" ||
          rawFine === "no_data" ||
          rawFine === "skipped"
            ? rawFine
            : r.status === "ok"
              ? "ok"
              : "skipped";

        // Honest stored count: prefer cloud-confirmed inserted
        // (Priority 2), then posted, then the legacy readings_uploaded
        // alias.
        const num = (v: unknown): number | null =>
          typeof v === "number" && Number.isFinite(v) ? v : null;
        const storedCount =
          num(result.readings_inserted) ??
          num(result.readings_posted) ??
          num(result.readings_uploaded);

        let fulfilledError: string | null = null;
        let fulfilledCount: number | null = storedCount;

        switch (fineStatus) {
          case "ok":
            // Closed-loop 72h density check below verifies completeness.
            justCompletedResyncSuccessfully = true;
            break;
          case "partial":
            // Data lost mid-drain. fulfilled_error makes the retry
            // sweep re-queue automatically.
            fulfilledError = "primus_partial_drain";
            break;
          case "no_data":
            // Primus correctly observed an empty sensor buffer — not a
            // failure. Fulfilled with zero, no retry, no density check.
            fulfilledCount = 0;
            break;
          case "skipped": {
            const skipReason =
              typeof result.skip_reason === "string" &&
              result.skip_reason.trim() !== ""
                ? result.skip_reason.trim()
                : typeof result.error === "string" &&
                    result.error.trim() !== ""
                  ? result.error.trim()
                  : "unknown";
            fulfilledError = `primus_skipped:${skipReason}`;
            // Surface recurring skips to support — a Primus that keeps
            // skipping resyncs (WiFi never reconnects, key empty) is a
            // field problem the density check alone won't explain.
            resultDerivedEvents.push({
              primus_id: req.primus!.deviceId,
              observed_at: new Date().toISOString(),
              severity: "warn",
              source: "resync",
              message: `Resync skipped: ${skipReason}`,
            });
            break;
          }
        }

        // Link to sensor_resync_requests. The gap-fill-retry path links
        // a single id; the auto-gap-detect path links many (one per
        // gappy sensor) since one Primus resync covers multiple sensors.
        const params = updated.params as
          | { resync_request_id?: string; resync_request_ids?: string[] }
          | null;
        const linkedIds = [
          ...(params?.resync_request_id ? [params.resync_request_id] : []),
          ...(params?.resync_request_ids ?? []),
        ];
        if (linkedIds.length > 0) {
          await supabaseAdmin
            .from("sensor_resync_requests")
            .update({
              fulfilled_at: new Date().toISOString(),
              fulfilled_count: fulfilledCount,
              fulfilled_error: fulfilledError,
            })
            .in("id", linkedIds);
        }
      }

      if (resultDerivedEvents.length > 0) {
        await supabaseAdmin.from("primus_events").upsert(resultDerivedEvents, {
          onConflict: "primus_id,observed_at,source,message",
          ignoreDuplicates: true,
        });
      }
    }
    t.mark("results"); // command_results processing

    // First-after-absence heartbeat: short-circuit here. We've updated
    // last_seen, processed any command_results (state changes can't be
    // deferred), and that's it. Skip everything else: no events ingest,
    // no gap-fill density check, no timeout cascade, no retry sweep, no
    // opportunistic backlog, no auto gap-detection, no command delivery.
    // All of those will run on the very next heartbeat (~60s later) when
    // the Primus's display state is steady-state and there's no
    // user-visible cloud-icon transition spike to worry about.
    //
    // The Primus knows from `deferred: true` in the response that it
    // should NOT trim its events ring buffer this cycle, and that any
    // pending commands will be delivered on the next heartbeat instead.
    if (isFirstAfterAbsence) {
      res.setHeader("Server-Timing", t.header());
      return res.json({
        ok: true,
        deferred: true,
        events_acked: [],
        commands: [],
      });
    }

    // Gap-fill verification: after a successful resync, check whether any
    // linked sensor still has missing data. If so, queue another resync
    // targeting the gap. This is the closed-loop "don't trust, verify"
    // safeguard — serious customers won't accept gaps, so the cloud keeps
    // chasing until the data is complete.
    //
    // Check spans last 72h (covers weekend-long Primus outages) against
    // expected 5-min-resolution density (~12 readings/hour/sensor). If any
    // sensor has < 50% of expected, queue another resync.
    //
    // Safety cap: max 5 gap-fill resyncs per device per hour. If after 5
    // retries there's still a gap, it's not a cloud-side problem anymore —
    // likely a sensor fault or firmware bug. Stop + let admin investigate.
    if (justCompletedResyncSuccessfully) {
      const GAPFILL_WINDOW_HOURS = 72;
      const GAPFILL_EXPECTED_PER_HOUR = 12; // 5-min resolution from sensor buffer
      const GAPFILL_MIN_DENSITY = 0.5; // 50% of expected = gap
      const GAPFILL_MAX_RETRIES_PER_HOUR = 5;

      // Cap retries: count gap-fill resyncs issued in the last hour
      const hourCutoff = new Date(nowMs - 60 * 60 * 1000).toISOString();
      const { count: recentRetries } = await supabaseAdmin
        .from("primus_commands")
        .select("id", { count: "exact", head: true })
        .eq("primus_id", req.primus!.deviceId)
        .eq("type", "resync")
        .is("issued_by", null)
        .contains("params", { reason: "gap_fill_retry" })
        .gte("created_at", hourCutoff);

      if ((recentRetries ?? 0) < GAPFILL_MAX_RETRIES_PER_HOUR) {
        // Get all sensors linked to any active hatch for this user
        const { data: linkedSensors } = await supabaseAdmin
          .from("hatch_sensors")
          .select("sensor_id, hatch_logs!inner(status, user_id)")
          .eq("hatch_logs.user_id", req.primus!.userId)
          .eq("hatch_logs.status", "active");

        const sensorIds = Array.from(
          new Set((linkedSensors ?? []).map((l) => l.sensor_id)),
        );

        if (sensorIds.length > 0) {
          const windowStart = new Date(
            nowMs - GAPFILL_WINDOW_HOURS * 60 * 60 * 1000,
          );
          const expectedCount =
            GAPFILL_WINDOW_HOURS * GAPFILL_EXPECTED_PER_HOUR;
          const minAcceptable = Math.floor(
            expectedCount * GAPFILL_MIN_DENSITY,
          );

          let earliestGapSensor: string | null = null;
          for (const sid of sensorIds) {
            const { count: actualCount } = await supabaseAdmin
              .from("sensor_readings")
              .select("id", { count: "exact", head: true })
              .eq("sensor_id", sid)
              .gte("recorded_at", windowStart.toISOString());

            if ((actualCount ?? 0) < minAcceptable) {
              earliestGapSensor = sid;
              break; // one gap is enough to trigger; no need to check rest
            }
          }

          if (earliestGapSensor) {
            // Skip if there's already an open request for this sensor —
            // some other path (auto-detect, prior retry, app-user) has
            // already queued one. No point doubling up.
            const { data: existingForSensor } = await supabaseAdmin
              .from("sensor_resync_requests")
              .select("id")
              .eq("sensor_id", earliestGapSensor)
              .is("claimed_at", null)
              .is("fulfilled_at", null)
              .is("cancelled_at", null)
              .gt("expires_at", new Date(nowMs).toISOString())
              .limit(1);

            if (!existingForSensor || existingForSensor.length === 0) {
              // Insert into the unified resync request queue first — App
              // subscribes to this table via Realtime and may fulfill if
              // it's in BLE range. Then ALSO queue a primus_commands row
              // for the heartbeating Primus, linking via resync_request_id
              // so both rows get marked complete together when fulfilled.
              const { data: req_row } = await supabaseAdmin
                .from("sensor_resync_requests")
                .insert({
                  sensor_id: earliestGapSensor,
                  user_id: req.primus!.userId,
                  range_start: windowStart.toISOString(),
                  range_end: new Date(nowMs).toISOString(),
                  reason: "gap_fill_retry",
                })
                .select("id")
                .single();

              await supabaseAdmin.from("primus_commands").insert({
                primus_id: req.primus!.deviceId,
                type: "resync",
                params: {
                  since: Math.floor(windowStart.getTime() / 1000),
                  auto: true,
                  reason: "gap_fill_retry",
                  gap_sensor_id: earliestGapSensor,
                  window_hours: GAPFILL_WINDOW_HOURS,
                  resync_request_id: req_row?.id ?? null,
                },
                issued_by: null,
              });
            }
          }
        }
      }
    }
    t.mark("density"); // post-resync gap-fill density verification

    // Timeout sweep: any command "running" (delivered, not completed) for
    // more than COMMAND_TIMEOUT_MS is assumed to have failed. 30 min gives
    // room for legitimate long catch-ups: a 12-24h Primus-offline window
    // can produce 500-1000 records across multiple sensors, requiring
    // per-sensor BLE history pull + chunked upload. In testing, a 12-hour
    // overnight gap legitimately takes 10-15 min to resync — the original
    // 10-min cap was too aggressive and cut off real work.
    // 2026-05-01: bumped to 60 min after heartbeat cadence widened to
    // up to 10 min. Worst case round-trip (queue → up to 10 min wait
    // for next heartbeat to deliver → 10-15 min execution → up to 10
    // min wait for next heartbeat to report back) is ~30-35 min. 60
    // min gives margin without being so generous that genuinely
    // abandoned commands sit forever.
    const COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
    const timeoutCutoff = new Date(nowMs - COMMAND_TIMEOUT_MS).toISOString();
    const { data: timedOutCommands } = await supabaseAdmin
      .from("primus_commands")
      .update({
        completed_at: new Date().toISOString(),
        result: {
          status: "timeout",
          error: "no_response_assumed_reboot",
        },
      })
      .eq("primus_id", req.primus!.deviceId)
      .not("delivered_at", "is", null)
      .is("completed_at", null)
      .lt("delivered_at", timeoutCutoff)
      .select("id, type, params");

    // Cascade timeouts to any sensor_resync_requests rows linked via
    // params.resync_request_id(s). Without this they'd sit open until
    // expires_at (24h), blocking the dedup guard that prevents requeue.
    if (timedOutCommands && timedOutCommands.length > 0) {
      const linkedReqIds: string[] = [];
      for (const cmd of timedOutCommands) {
        if (cmd.type !== "resync") continue;
        const params = cmd.params as
          | { resync_request_id?: string; resync_request_ids?: string[] }
          | null;
        if (params?.resync_request_id) linkedReqIds.push(params.resync_request_id);
        if (params?.resync_request_ids?.length) {
          linkedReqIds.push(...params.resync_request_ids);
        }
      }
      if (linkedReqIds.length > 0) {
        await supabaseAdmin
          .from("sensor_resync_requests")
          .update({
            cancelled_at: new Date().toISOString(),
            fulfilled_error: "primus_command_timed_out",
          })
          .in("id", linkedReqIds)
          .is("fulfilled_at", null)
          .is("cancelled_at", null);
      }
    }
    t.mark("timeout"); // primus_commands timeout sweep + cascade

    // Re-queue any failed sensor_resync_requests rows that are due for
    // retry (fulfilled_error set, backoff elapsed, retry_count < 5).
    // For Primus users this catches retries every heartbeat (~60s); the
    // pg_cron schedule (migration 016) is the safety net that also
    // covers app-only users with no heartbeat.
    await supabaseAdmin.rpc("requeue_due_failed_resyncs", {
      p_user_id: req.primus!.userId,
      p_max_retries: 5,
    });
    t.mark("retry"); // requeue_due_failed_resyncs RPC

    // Opportunistic backlog pickup: any sensor_resync_requests rows that
    // have been sitting OPEN > 2 min should be handled by the Primus when
    // it heartbeats — the App is unreliable (phone moves around, OS
    // suspends BLE, calls interrupt sessions). The 2-min window gives the
    // App a fair shot to claim from its Realtime subscription first; if
    // it didn't, the Primus picks them up. Filtered to active-hatch
    // sensors (casual-mode sensors don't need backfill).
    //
    // This closes the architectural hole exposed on 2026-04-28 where a
    // Primus outage queued primus_offline requests that the App couldn't
    // claim (BLE interrupted), and once the Primus came back, no chain
    // re-queued the work for it because gap-detection only fires on
    // currently-stale sensors.
    // Normal floor: every backlog row waits at least this long so the
    // App's Realtime subscription gets first refusal. The circuit
    // breaker (below) stretches this to 30 min for sensors the Primus
    // has been repeatedly failing to resync.
    const OPPORTUNISTIC_PICKUP_DELAY_MS = 2 * 60 * 1000;
    const OPPORTUNISTIC_PICKUP_DELAY_TRIPPED_MS = 30 * 60 * 1000;
    const opportunisticCutoff = new Date(
      nowMs - OPPORTUNISTIC_PICKUP_DELAY_MS,
    ).toISOString();

    // Skip if there's already an open primus_commands resync — don't stack.
    const { data: openCmd } = await supabaseAdmin
      .from("primus_commands")
      .select("id")
      .eq("primus_id", req.primus!.deviceId)
      .eq("type", "resync")
      .is("completed_at", null)
      .limit(1);

    if (!openCmd || openCmd.length === 0) {
      const { data: backlog } = await supabaseAdmin
        .from("sensor_resync_requests")
        .select("id, sensor_id, range_start, range_end, reason, requested_at")
        .eq("user_id", req.primus!.userId)
        .is("claimed_at", null)
        .is("fulfilled_at", null)
        .is("cancelled_at", null)
        .gt("expires_at", new Date(nowMs).toISOString())
        .lt("requested_at", opportunisticCutoff)
        .order("requested_at", { ascending: true })
        .limit(20);

      if (backlog && backlog.length > 0) {
        const inActiveHatch = await sensorsInActiveHatch(
          req.primus!.userId,
          [...new Set(backlog.map((r) => r.sensor_id))],
        );
        const activeEligible = backlog.filter((r) =>
          inActiveHatch.has(r.sensor_id),
        );

        // Circuit breaker: for sensors the Primus has been repeatedly
        // failing to resync, hold its pickup back from the 2-min floor
        // to 30 min so the App's Realtime subscription gets a long
        // uncontested window to backfill from BLE. A single Primus
        // success on the sensor clears the breaker. Backlog rows
        // already passed the 2-min floor in the query above; tripped
        // sensors additionally need to have waited the 30-min window.
        const trippedCutoff = new Date(
          nowMs - OPPORTUNISTIC_PICKUP_DELAY_TRIPPED_MS,
        ).toISOString();
        const trippedSensors = await primusBreakerTrippedSensors(
          req.primus!.userId,
          [...new Set(activeEligible.map((r) => r.sensor_id))],
          nowMs,
        );
        const eligible = activeEligible.filter((r) =>
          trippedSensors.has(r.sensor_id)
            ? r.requested_at < trippedCutoff
            : true,
        );

        if (eligible.length > 0) {
          // Claim atomically: set claimed_by to this Primus, but ONLY for
          // rows still unclaimed. The App might race us on the very same
          // millisecond — atomic UPDATE filters out anything it already
          // grabbed. We only proceed for rows we actually claimed.
          const { data: claimed } = await supabaseAdmin
            .from("sensor_resync_requests")
            .update({
              claimed_at: new Date().toISOString(),
              claimed_by: `primus:${req.primus!.deviceId}`,
            })
            .in("id", eligible.map((r) => r.id))
            .is("claimed_at", null)
            .select("id, sensor_id, range_start, range_end");

          if (claimed && claimed.length > 0) {
            // Compute the union range — earliest start to latest end.
            // The Primus's resync command takes a single window and pulls
            // every sensor's records in it; dedup catches overlap.
            let earliestStart = claimed[0].range_start;
            let latestEnd = claimed[0].range_end;
            for (const r of claimed) {
              if (r.range_start < earliestStart) earliestStart = r.range_start;
              if (r.range_end > latestEnd) latestEnd = r.range_end;
            }

            await supabaseAdmin.from("primus_commands").insert({
              primus_id: req.primus!.deviceId,
              type: "resync",
              params: {
                since: Math.floor(
                  new Date(earliestStart).getTime() / 1000,
                ),
                auto: true,
                reason: "opportunistic_backlog",
                window_hours: Math.ceil(
                  (new Date(latestEnd).getTime() -
                    new Date(earliestStart).getTime()) /
                    3_600_000,
                ),
                resync_request_ids: claimed.map((r) => r.id),
                claimed_request_count: claimed.length,
              },
              issued_by: null,
            });
          }
        }
      }
    }
    t.mark("backlog"); // opportunistic backlog pickup

    // Auto gap-detection: if any of this Primus's sensors hasn't reported
    // in the last 15 minutes, queue an automatic resync. Safeguarded with:
    //   - no uncompleted resync already open
    //   - 30-min cooldown since the last auto-resync (lets the Primus fully
    //     recover from each attempt — firmware memory issues can take time
    //     to shake out, don't pile on)
    //   - max 3 auto-queued resyncs per device per 24h (hard cap against
    //     runaway reboot loops if the resync itself is crashing the device)
    //
    // 2026-05-01: threshold widened from 5 min to 15 min after the Primus
    // heartbeat cadence moved from 60s to up to 10 min (BLE-scan PSRAM
    // contention mitigation). With 10-min cadence, sensors.last_seen
    // oscillates between 0 and 10 min stale during normal operation; a
    // 5-min threshold would constantly false-fire. 15 min gives margin
    // for a slightly delayed cycle without missing real outages.
    const SENSOR_GAP_THRESHOLD_MS = 15 * 60 * 1000;
    const AUTO_RESYNC_COOLDOWN_MS = 30 * 60 * 1000;
    const AUTO_RESYNC_CONSECUTIVE_FAILURE_CAP = 3;

    const staleCutoff = new Date(
      nowMs - SENSOR_GAP_THRESHOLD_MS,
    ).toISOString();

    const { data: candidateGappySensors } = await supabaseAdmin
      .from("sensors")
      .select("id, last_seen")
      .eq("user_id", req.primus!.userId)
      .not("claimed_at", "is", null)
      .not("last_seen", "is", null)
      .lt("last_seen", staleCutoff)
      .limit(50);

    // Restrict gap-detection to sensors that are actually being recorded
    // (in an active hatch). Casual-mode sensors with no hatch should not
    // trigger resyncs — there's nothing to fill in, by design.
    let gappySensors: { id: string; last_seen: string | null }[] = [];
    if (candidateGappySensors && candidateGappySensors.length > 0) {
      const inActiveHatch = await sensorsInActiveHatch(
        req.primus!.userId,
        candidateGappySensors.map((s) => s.id),
      );
      gappySensors = candidateGappySensors.filter((s) =>
        inActiveHatch.has(s.id),
      );
    }

    if (gappySensors.length > 0) {
      const { data: openResync } = await supabaseAdmin
        .from("primus_commands")
        .select("id")
        .eq("primus_id", req.primus!.deviceId)
        .eq("type", "resync")
        .is("completed_at", null)
        .limit(1);

      if (!openResync || openResync.length === 0) {
        const cooldownCutoff = new Date(
          nowMs - AUTO_RESYNC_COOLDOWN_MS,
        ).toISOString();
        const { data: recentAuto } = await supabaseAdmin
          .from("primus_commands")
          .select("id")
          .eq("primus_id", req.primus!.deviceId)
          .eq("type", "resync")
          .is("issued_by", null)
          .gte("created_at", cooldownCutoff)
          .limit(1);

        const inCooldown = recentAuto && recentAuto.length > 0;

        if (!inCooldown) {
          // Consecutive-failure cap: protects against runaway reboot loops
          // where every auto-resync crashes the device. Walk the most recent
          // auto-resyncs backwards — if we hit N failed/timed-out/cancelled
          // in a row without any success, stop auto-firing (manual admin
          // Resync still works). A single successful resync resets the count.
          const { data: recentHistory } = await supabaseAdmin
            .from("primus_commands")
            .select("result")
            .eq("primus_id", req.primus!.deviceId)
            .eq("type", "resync")
            .is("issued_by", null)
            .not("completed_at", "is", null)
            .order("completed_at", { ascending: false })
            .limit(AUTO_RESYNC_CONSECUTIVE_FAILURE_CAP);

          let consecutiveFailures = 0;
          for (const row of recentHistory ?? []) {
            const status =
              (row.result as { status?: string } | null)?.status ?? "";
            if (status === "ok") break; // a success resets the streak
            consecutiveFailures++;
          }

          if (consecutiveFailures < AUTO_RESYNC_CONSECUTIVE_FAILURE_CAP) {
            // Skip any sensor that already has an open sensor_resync_requests
            // row — prevents pile-up if the same sensor stays stale across
            // multiple cooldown windows. The existing open row will fulfil
            // (or expire), and the next gap-detect after that will re-arm.
            const gappyIds = gappySensors.map((s) => s.id);
            const { data: existingOpen } = await supabaseAdmin
              .from("sensor_resync_requests")
              .select("sensor_id")
              .in("sensor_id", gappyIds)
              .is("claimed_at", null)
              .is("fulfilled_at", null)
              .is("cancelled_at", null)
              .gt("expires_at", new Date(nowMs).toISOString());
            const blocked = new Set(
              (existingOpen ?? []).map((r) => r.sensor_id),
            );
            const sensorsToQueue = gappySensors.filter(
              (s) => !blocked.has(s.id),
            );

            if (sensorsToQueue.length > 0) {
              // Insert one sensor_resync_requests row per gappy sensor so
              // App-only readers can see and claim per-sensor (in case the
              // app is in BLE range of some sensors but not others). Each
              // row's range covers the last 24h — Primus will pull from
              // its on-board buffer using its default window logic.
              const reqWindowStart = new Date(nowMs - 24 * 60 * 60 * 1000);
              const reqRows = sensorsToQueue.map((s) => ({
                sensor_id: s.id,
                user_id: req.primus!.userId,
                range_start: reqWindowStart.toISOString(),
                range_end: new Date(nowMs).toISOString(),
                reason: "auto_gap_detected" as const,
              }));
              const { data: insertedReqs } = await supabaseAdmin
                .from("sensor_resync_requests")
                .insert(reqRows)
                .select("id, sensor_id");

              // Then queue ONE primus_commands row covering all gappy
              // sensors (Primus pulls them all in one resync flow).
              // params.resync_request_ids carries the linked rows so
              // we can mark them all fulfilled together.
              await supabaseAdmin.from("primus_commands").insert({
                primus_id: req.primus!.deviceId,
                type: "resync",
                params: {
                  since: null,
                  auto: true,
                  reason: "sensor_gap_detected",
                  gappy_sensor_ids: sensorsToQueue.map((s) => s.id),
                  resync_request_ids:
                    (insertedReqs ?? []).map((r) => r.id),
                },
                issued_by: null, // null = cloud-automated (no admin user)
              });
            }
          }
        }
      }
    }
    t.mark("gapdet"); // auto gap-detection

    // Deliver any pending (undelivered) commands for this device.
    const { data: pending } = await supabaseAdmin
      .from("primus_commands")
      .select("id, type, params, created_at")
      .eq("primus_id", req.primus!.deviceId)
      .is("delivered_at", null)
      .order("created_at", { ascending: true })
      .limit(PRIMUS_COMMANDS_PER_HEARTBEAT);

    const deliveringCommands = pending ?? [];
    if (deliveringCommands.length > 0) {
      const ids = deliveringCommands.map((c) => c.id);
      await supabaseAdmin
        .from("primus_commands")
        .update({ delivered_at: new Date().toISOString() })
        .in("id", ids);
    }
    t.mark("deliver"); // pending command delivery

    res.setHeader("Server-Timing", t.header());
    res.json({
      ok: true,
      events_acked: acked,
      commands: deliveringCommands.map((c) => ({
        id: c.id,
        type: c.type,
        params: c.params,
      })),
    });
  },
);

// ---------- Sensor readings batch ----------
const readingsSchema = z.object({
  readings: z
    .array(
      z.object({
        serial_number: z.string().min(1),
        model: z.enum(["pro", "lite"]).optional(), // Primus hint — optional
        advertised_name: z.string().max(60).optional(), // BLE local name, optional
        temperature: z.number().finite().optional(),
        humidity: z.number().finite().optional(),
        battery_mv: z.number().int().nonnegative().optional(),
        recorded_at: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(100),
});

primusRouter.post(
  "/readings",
  requirePrimusAuth,
  async (req: PrimusAuthedRequest, res) => {
    const parsed = readingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    }

    // Stage timer for Server-Timing header — same as in /primus/heartbeat.
    const t = makeStageTimer();

    const userId = req.primus!.userId;
    const primusId = req.primus!.deviceId;

    const serialsInBatch = Array.from(
      new Set(parsed.data.readings.map((r) => r.serial_number)),
    );

    // Look up existing sensors for these serials (across all users — the
    // unique constraint means one serial maps to at most one sensor).
    const { data: existing, error: sensorErr } = await supabaseAdmin
      .from("sensors")
      .select("id, serial_number, user_id")
      .in("serial_number", serialsInBatch);

    if (sensorErr) {
      console.error("sensor lookup error", sensorErr);
      return res.status(500).json({ error: "sensor_lookup_failed" });
    }
    t.mark("lookup");

    const bySerial = new Map(existing?.map((s) => [s.serial_number, s]) ?? []);

    // Auto-create pending sensors for any serial this user hasn't seen yet.
    const unknownSerials = serialsInBatch.filter((s) => !bySerial.has(s));
    if (unknownSerials.length > 0) {
      const pendingRows = unknownSerials.map((serial) => {
        const firstReading = parsed.data.readings.find(
          (r) => r.serial_number === serial,
        )!;
        return {
          user_id: userId,
          serial_number: serial,
          model: firstReading.model ?? "pro",
          name: firstReading.advertised_name?.trim() || null,
          claimed_at: null,
          discovered_by_primus: primusId,
        };
      });

      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from("sensors")
        .insert(pendingRows)
        .select("id, serial_number, user_id");

      if (insertErr) {
        // Unique-violation means another Primus / path already created the
        // sensor between our lookup and insert — not fatal, just log.
        console.warn("pending sensor insert:", insertErr.message);
      }
      for (const row of inserted ?? []) {
        bySerial.set(row.serial_number, row);
      }
    }

    // Refresh advertised name on still-pending sensors if Primus sends a
    // newer one (user renamed via the app since first discovery).
    for (const r of parsed.data.readings) {
      const adv = r.advertised_name?.trim();
      if (!adv) continue;
      const sensor = bySerial.get(r.serial_number);
      if (!sensor || sensor.user_id !== userId) continue;
      await supabaseAdmin
        .from("sensors")
        .update({ name: adv })
        .eq("id", sensor.id)
        .is("claimed_at", null);
    }
    t.mark("provision"); // pending-sensor creation + name refresh

    // Now build the readings rows.
    const rows: {
      sensor_id: string;
      temperature?: number;
      humidity?: number;
      battery_mv?: number;
      recorded_at?: string;
    }[] = [];
    const skipped: string[] = [];

    for (const r of parsed.data.readings) {
      const sensor = bySerial.get(r.serial_number);
      if (!sensor || sensor.user_id !== userId) {
        // Owned by someone else (rare — neighbour's sensor in range)
        skipped.push(r.serial_number);
        continue;
      }
      rows.push({
        sensor_id: sensor.id,
        temperature: r.temperature,
        humidity: r.humidity,
        battery_mv: r.battery_mv,
        recorded_at: r.recorded_at ?? new Date().toISOString(),
      });
    }

    let insertedCount = 0;
    let liveOnlyCount = 0;
    if (rows.length > 0) {
      // Split rows into "record" (sensor is in an active hatch — store
      // permanently) vs "live-only" (sensor not in any active hatch —
      // broadcast live and discard). The Primus is the always-on
      // professional gateway; it uploads regardless of hatch state, and
      // the cloud decides whether to record or just rebroadcast.
      const sensorIdsInBatch = Array.from(
        new Set(rows.map((r) => r.sensor_id)),
      );
      const activeHatchSensorIds = await sensorsInActiveHatch(
        userId,
        sensorIdsInBatch,
      );
      t.mark("hatch_q"); // active-hatch query

      const recordRows = rows.filter((r) =>
        activeHatchSensorIds.has(r.sensor_id),
      );
      const liveOnlyRows = rows.filter(
        (r) => !activeHatchSensorIds.has(r.sensor_id),
      );

      // Persistent path — existing dedup + upsert. Trigger from
      // migration 014 also bumps sensors.last_seen on each INSERT.
      if (recordRows.length > 0) {
        const { data: inserted, error: readingsErr } = await supabaseAdmin
          .from("sensor_readings")
          .upsert(recordRows, {
            onConflict: "sensor_id,recorded_at",
            ignoreDuplicates: true,
          })
          .select("id");
        if (readingsErr) {
          console.error("readings upsert error", readingsErr);
          return res.status(500).json({ error: "insert_failed" });
        }
        insertedCount = inserted?.length ?? 0;
      }
      t.mark("upsert"); // sensor_readings UPSERT

      // Live-only path — broadcast on a per-sensor Realtime channel for
      // any client (app, web dashboard) subscribed to that sensor. No DB
      // writes; if no subscriber is listening, the reading is dropped.
      // httpSend uses the REST broadcast endpoint, so we don't need to
      // manage a WebSocket subscription server-side.
      if (liveOnlyRows.length > 0) {
        await Promise.all(
          liveOnlyRows.map((r) =>
            supabaseAdmin
              .channel(`sensor_live:${r.sensor_id}`)
              .httpSend("reading", {
                sensor_id: r.sensor_id,
                temperature: r.temperature ?? null,
                humidity: r.humidity ?? null,
                battery_mv: r.battery_mv ?? null,
                recorded_at: r.recorded_at,
              })
              .catch((err: unknown) => {
                // Don't fail the whole request on a broadcast hiccup —
                // live data is best-effort by design. Log and continue.
                console.warn("live broadcast failed", r.sensor_id, err);
              }),
          ),
        );
        liveOnlyCount = liveOnlyRows.length;
      }

      // Always bump last_seen for every sensor in the batch — including
      // live-only ones, where no INSERT fires the migration-014 trigger.
      // Keeps gap-detection accurate for casual-mode sensors too: they
      // aren't "offline" just because they aren't recording.
      await supabaseAdmin
        .from("sensors")
        .update({ last_seen: new Date().toISOString() })
        .in("id", sensorIdsInBatch);
      t.mark("bcast_seen"); // live broadcast + last_seen bump
    }

    res.setHeader("Server-Timing", t.header());
    res.json({
      ok: true,
      accepted: rows.length,
      inserted: insertedCount,
      duplicates: Math.max(0, rows.length - insertedCount - liveOnlyCount),
      live_only: liveOnlyCount,
      pending_created: unknownSerials.length,
      skipped,
    });
  },
);

// ----------------------------------------------------------------------------
// sensorsInActiveHatch — returns the subset of `sensorIds` that are linked
// to at least one active hatch for `userId`. A sensor counts as "active" if
// it's referenced via hatch_sensors OR via hatch_logs.ambient_sensor_id.
//
// Used by /primus/readings to decide which readings to record vs broadcast,
// and by the heartbeat handler's gap-detection logic to ignore casual-mode
// sensors that don't need monitoring.
// ----------------------------------------------------------------------------
async function sensorsInActiveHatch(
  userId: string,
  sensorIds: string[],
): Promise<Set<string>> {
  if (sensorIds.length === 0) return new Set();

  const [linked, ambient] = await Promise.all([
    supabaseAdmin
      .from("hatch_sensors")
      .select("sensor_id, hatch_logs!inner(status, user_id)")
      .in("sensor_id", sensorIds)
      .eq("hatch_logs.status", "active")
      .eq("hatch_logs.user_id", userId),
    supabaseAdmin
      .from("hatch_logs")
      .select("ambient_sensor_id")
      .eq("user_id", userId)
      .eq("status", "active")
      .in("ambient_sensor_id", sensorIds),
  ]);

  const out = new Set<string>();
  for (const row of linked.data ?? []) {
    if (row.sensor_id) out.add(row.sensor_id);
  }
  for (const row of ambient.data ?? []) {
    if (row.ambient_sensor_id) out.add(row.ambient_sensor_id);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Circuit breaker — adaptive Primus/App resync arbitration
// ----------------------------------------------------------------------------
//
// Background (2026-05-17): a Primus with a firmware fault (BLE/PSRAM
// contention, TLS warm-up failure, key empty) can claim a sensor's
// resync backlog every heartbeat, fail it, and re-claim — monopolising
// the sensor so the App's Realtime subscription never gets an
// uncontested window to backfill from BLE. Observed in the field: 3
// sensors stuck IN_FLIGHT claimed by a Primus for 22h while an able App
// sat idle, because the 2-min opportunistic delay always elapsed before
// the App's next foreground Realtime tick.
//
// The breaker watches per-sensor Primus resync outcomes. If the Primus
// has failed a sensor's resyncs >= CIRCUIT_BREAKER_FAILURE_THRESHOLD
// times within CIRCUIT_BREAKER_WINDOW_MS *since its last success on that
// sensor*, the breaker trips for that sensor: the opportunistic backlog
// holds Primus pickup back from 2 min to 30 min, handing the App a long
// uncontested window. A single successful Primus resync (fine_status
// "ok" or "no_data") on the sensor clears the breaker for it.
//
// Failure signal = sensor_resync_requests rows claimed by a Primus
// (claimed_by LIKE 'primus:%') with fulfilled_error set. That covers
// primus_partial_drain, primus_skipped:*, primus_reported_error and
// primus_command_timed_out. fine_status "no_data" sets no error, so a
// genuinely-empty sensor buffer never trips the breaker — only real
// faults do. The design is symmetric in principle (an unreliable App
// could be throttled the same way) but the App claims directly via
// Supabase without an API round-trip, so only the Primus side is
// arbitrated here.

const CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;

async function primusBreakerTrippedSensors(
  userId: string,
  sensorIds: string[],
  nowMs: number,
): Promise<Set<string>> {
  const tripped = new Set<string>();
  if (sensorIds.length === 0) return tripped;

  const windowCutoff = new Date(
    nowMs - CIRCUIT_BREAKER_WINDOW_MS,
  ).toISOString();

  const { data } = await supabaseAdmin
    .from("sensor_resync_requests")
    .select("sensor_id, claimed_at, fulfilled_at, fulfilled_error")
    .eq("user_id", userId)
    .in("sensor_id", sensorIds)
    .like("claimed_by", "primus:%")
    .gte("claimed_at", windowCutoff);

  if (!data || data.length === 0) return tripped;

  // Per sensor: find the most recent successful Primus resync, then
  // count failures claimed strictly after it. A success resets the
  // count (the breaker is about *recent* unproductive contention, not
  // lifetime failures).
  const bySensor = new Map<
    string,
    { claimedAt: string; success: boolean; failure: boolean }[]
  >();
  for (const row of data) {
    if (!row.sensor_id || !row.claimed_at) continue;
    const success = row.fulfilled_at != null && row.fulfilled_error == null;
    const failure = row.fulfilled_error != null;
    if (!success && !failure) continue; // still in-flight — ignore
    if (!bySensor.has(row.sensor_id)) bySensor.set(row.sensor_id, []);
    bySensor.get(row.sensor_id)!.push({
      claimedAt: row.claimed_at,
      success,
      failure,
    });
  }

  for (const [sensorId, rows] of bySensor) {
    // ISO-8601 strings sort lexically by time. "" precedes any
    // timestamp, so if there's no success every failure counts.
    let lastSuccessAt = "";
    for (const r of rows) {
      if (r.success && r.claimedAt > lastSuccessAt) lastSuccessAt = r.claimedAt;
    }
    const failuresSinceSuccess = rows.filter(
      (r) => r.failure && r.claimedAt > lastSuccessAt,
    ).length;
    if (failuresSinceSuccess >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      tripped.add(sensorId);
    }
  }

  return tripped;
}

// ----------------------------------------------------------------------------
// buildHatchDashboard — assembles the dashboard payload for a single hatch
// ----------------------------------------------------------------------------

type HatchSlim = {
  id: string;
  name: string;
  species: string | null;
  start_date: string;
  expected_hatch_date: string | null;
  ambient_sensor_id: string | null;
};

async function buildHatchDashboard(h: HatchSlim) {
  const target = speciesTarget(h.species);
  const startMs = new Date(h.start_date + "T00:00:00Z").getTime();
  const nowMs = Date.now();
  const daysElapsed = Math.floor((nowMs - startMs) / (24 * 60 * 60 * 1000));
  const day = Math.max(1, daysElapsed + 1);
  const phase = phaseForDay(day, target);
  const humTarget = humidityTargetForPhase(target, phase);

  // Linked sensors
  const { data: links } = await supabaseAdmin
    .from("hatch_sensors")
    .select("sensor_id")
    .eq("hatch_id", h.id);
  const sensorIds = (links ?? []).map((l) => l.sensor_id);

  type EnvStats = {
    temperature_c: number | null;
    humidity_pct: number | null;
    updated_at: string | null;
  };
  let current: EnvStats = {
    temperature_c: null,
    humidity_pct: null,
    updated_at: null,
  };
  let today = {
    temp_avg: null as number | null,
    temp_min: null as number | null,
    temp_max: null as number | null,
    hum_avg: null as number | null,
    hum_min: null as number | null,
    hum_max: null as number | null,
  };
  let sensorsOnline = 0;

  if (sensorIds.length > 0) {
    // Last 24h of readings — used for both "current" and "today" stats
    const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const { data: readings } = await supabaseAdmin
      .from("sensor_readings")
      .select("sensor_id, temperature, humidity, recorded_at")
      .in("sensor_id", sensorIds)
      .gte("recorded_at", since)
      .order("recorded_at", { ascending: false })
      .limit(5000);

    const rows = readings ?? [];

    // Current — most recent reading per sensor
    const latestBySensor = new Map<
      string,
      { temperature: number | null; humidity: number | null; recorded_at: string }
    >();
    for (const r of rows) {
      if (!latestBySensor.has(r.sensor_id)) {
        latestBySensor.set(r.sensor_id, {
          temperature: r.temperature,
          humidity: r.humidity,
          recorded_at: r.recorded_at,
        });
      }
    }

    const fiveMinAgo = nowMs - 5 * 60 * 1000;
    const curTemps: number[] = [];
    const curHums: number[] = [];
    let latestTs: string | null = null;
    for (const [, r] of latestBySensor) {
      if (r.temperature != null && Number.isFinite(r.temperature))
        curTemps.push(r.temperature);
      if (r.humidity != null && Number.isFinite(r.humidity))
        curHums.push(r.humidity);
      if (!latestTs || r.recorded_at > latestTs) latestTs = r.recorded_at;
      if (new Date(r.recorded_at).getTime() > fiveMinAgo) sensorsOnline++;
    }

    current = {
      temperature_c: curTemps.length
        ? round2(curTemps.reduce((s, v) => s + v, 0) / curTemps.length)
        : null,
      humidity_pct: curHums.length
        ? round1(curHums.reduce((s, v) => s + v, 0) / curHums.length)
        : null,
      updated_at: latestTs,
    };

    // Today (last 24h) min/avg/max across all readings
    const temps = rows
      .map((r) => r.temperature)
      .filter((v): v is number => v != null && Number.isFinite(v));
    const hums = rows
      .map((r) => r.humidity)
      .filter((v): v is number => v != null && Number.isFinite(v));

    if (temps.length > 0) {
      today.temp_min = round2(Math.min(...temps));
      today.temp_max = round2(Math.max(...temps));
      today.temp_avg = round2(temps.reduce((s, v) => s + v, 0) / temps.length);
    }
    if (hums.length > 0) {
      today.hum_min = round1(Math.min(...hums));
      today.hum_max = round1(Math.max(...hums));
      today.hum_avg = round1(hums.reduce((s, v) => s + v, 0) / hums.length);
    }
  }

  // Alerts — based on current vs target
  const alerts: string[] = [];
  if (current.temperature_c != null) {
    if (current.temperature_c > target.tempMaxC) alerts.push("temp_high");
    if (current.temperature_c < target.tempMinC) alerts.push("temp_low");
  }
  if (current.humidity_pct != null) {
    if (current.humidity_pct > humTarget.max) alerts.push("humidity_high");
    if (current.humidity_pct < humTarget.min) alerts.push("humidity_low");
  }

  // Ambient (room) sensor — fetched separately so the Primus LCD can show
  // it as CONTEXT next to the incubator readings, NOT averaged with them.
  // The LCD should render this with a distinct colour (amber / gold) so
  // the user instantly reads it as "room" not "incubator".
  type AmbientPayload = {
    name: string;
    temperature_c: number | null;
    humidity_pct: number | null;
    updated_at: string | null;
  };
  let ambient: AmbientPayload | null = null;
  if (h.ambient_sensor_id) {
    const { data: ambSensor } = await supabaseAdmin
      .from("sensors")
      .select("id, name, serial_number")
      .eq("id", h.ambient_sensor_id)
      .maybeSingle();
    if (ambSensor) {
      const { data: ambLatest } = await supabaseAdmin
        .from("sensor_readings")
        .select("temperature, humidity, recorded_at")
        .eq("sensor_id", ambSensor.id)
        .order("recorded_at", { ascending: false })
        .limit(1);
      const r = ambLatest?.[0];
      ambient = {
        name: ambSensor.name || ambSensor.serial_number,
        temperature_c:
          r?.temperature != null && Number.isFinite(r.temperature)
            ? round2(r.temperature)
            : null,
        humidity_pct:
          r?.humidity != null && Number.isFinite(r.humidity)
            ? round1(r.humidity)
            : null,
        updated_at: r?.recorded_at ?? null,
      };
    }
  }

  return {
    id: h.id,
    name: h.name,
    species_label: target.label,
    day,
    total_days: target.days,
    days_to_lockdown: target.lockdown - day,
    days_to_hatch: target.days - day,
    phase,
    current,
    today,
    target: {
      temp_min: target.tempMinC,
      temp_max: target.tempMaxC,
      hum_min: humTarget.min,
      hum_max: humTarget.max,
    },
    sensors_online: sensorsOnline,
    sensors_total: sensorIds.length,
    alerts,
    ambient,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
