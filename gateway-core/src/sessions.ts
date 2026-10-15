import { randomBytes } from "node:crypto";
import { pool } from "./db.js";
import { sha256 } from "./ids.js";
import { config } from "./config.js";
import { serializeCookie } from "./cookies.js";

export const COOKIE = "gw_session";
export const STEP_UP_MS = 10 * 60_000;           // how long a password/2FA confirmation stays fresh
const ABSOLUTE_S = 7 * 24 * 3600;                // hard cap on a session's life
const IDLE_HOURS = 12;                           // signs out after 12h of inactivity

export async function createSession(merchantId: string, ip: string, userAgent: string | undefined, mode: "test" | "live" = "test") {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (id, merchant_id, csrf_token, mode, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
    [sha256(token), merchantId, csrf, mode, ip, (userAgent ?? "").slice(0, 300), String(ABSOLUTE_S)]);
  return { token, csrf };
}

export async function loadSession(token: string) {
  const { rows } = await pool.query(
    `SELECT s.*, m.kyc_status FROM sessions s JOIN merchants m ON m.id = s.merchant_id
      WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - ($2 || ' hours')::interval AND m.status='active'`,
    [sha256(token), String(IDLE_HOURS)]);
  if (!rows[0]) return null;
  pool.query("UPDATE sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval '1 minute'", [rows[0].id]).catch(() => {});
  return rows[0];
}

export const revokeSession = (id: string) => pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL", [id]);

export const revokeAllSessions = (merchantId: string, exceptId?: string) =>
  pool.query("UPDATE sessions SET revoked_at=now() WHERE merchant_id=$1 AND revoked_at IS NULL AND ($2::text IS NULL OR id <> $2)", [merchantId, exceptId ?? null]);

export const sessionCookie = (token: string) => serializeCookie(COOKIE, token, { maxAgeSec: ABSOLUTE_S, secure: config.cookieSecure });
export const clearCookie = () => serializeCookie(COOKIE, "", { maxAgeSec: 0, secure: config.cookieSecure });

export async function cleanupAuth() {
  await pool.query("DELETE FROM sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'");
  await pool.query("DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days'");
}
