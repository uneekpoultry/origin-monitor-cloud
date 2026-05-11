import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase.js";
import { sha256 } from "../lib/hash.js";

export interface PrimusAuthedRequest extends Request {
  primus?: {
    deviceId: string;
    userId: string;
  };
}

/**
 * Validates the Authorization: Bearer <token> header against
 * primus_devices.api_key_hash and attaches { deviceId, userId } to req.primus.
 */
export async function requirePrimusAuth(
  req: PrimusAuthedRequest,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    return res.status(401).json({ error: "missing_bearer_token" });
  }
  const token = match[1].trim();
  const hash = sha256(token);

  const { data, error } = await supabaseAdmin
    .from("primus_devices")
    .select("id, user_id")
    .eq("api_key_hash", hash)
    .maybeSingle();

  if (error) {
    console.error("primus-auth lookup error", error);
    return res.status(500).json({ error: "auth_lookup_failed" });
  }
  if (!data) {
    return res.status(401).json({ error: "invalid_token" });
  }

  req.primus = { deviceId: data.id, userId: data.user_id };
  next();
}
