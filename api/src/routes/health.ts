import { Router } from "express";
import { supabaseAdmin } from "../lib/supabase.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "origin-monitor-api",
    time: new Date().toISOString(),
  });
});

healthRouter.get("/health/db", async (_req, res) => {
  const { error } = await supabaseAdmin
    .from("profiles")
    .select("id", { count: "exact", head: true });
  if (error) {
    return res.status(503).json({ ok: false, error: error.message });
  }
  res.json({ ok: true, db: "reachable" });
});
