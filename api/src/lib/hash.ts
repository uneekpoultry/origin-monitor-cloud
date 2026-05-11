import { createHash, randomBytes } from "node:crypto";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Generates a 32-byte URL-safe token (e.g. for Primus device API keys).
export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}
