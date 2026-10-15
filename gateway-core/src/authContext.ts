import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { authenticate, type AuthContext } from "./apiKeys.js";
import { COOKIE, STEP_UP_MS, loadSession } from "./sessions.js";
import { parseCookies } from "./cookies.js";
import { config } from "./config.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * ONE place that answers "who is calling?" for every protected route.
 *  - Authorization: Bearer sk_...  -> server-to-server API key (via: "api_key")
 *  - session cookie                -> a person in the dashboard (via: "session"), with CSRF + Origin checks on writes
 * A bad Authorization header never falls back to the cookie.
 */
export async function authenticateRequest(req: FastifyRequest): Promise<AuthContext | null> {
  if (req.headers.authorization) return authenticate(req.headers.authorization);
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = await loadSession(token);
  if (!s) return null;
  if (!SAFE.has(req.method)) {
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.publicBaseUrl).origin) return null;
    const sent = req.headers["x-csrf-token"];
    if (typeof sent !== "string" || !eq(sent, s.csrf_token)) return null;
  }
  const stepped = !!s.stepped_up_at && Date.now() - new Date(s.stepped_up_at).getTime() < STEP_UP_MS;
  return { merchantId: s.merchant_id, mode: s.mode, kycStatus: s.kyc_status, via: "session", sessionId: s.id, steppedUp: stepped };
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> {
  const a = await authenticateRequest(req);
  if (!a || a.via !== "session") { reply.code(401).send({ error: { code: "unauthorized" } }); return null; }
  req.auth = a;
  return a;
}

/** Money-moving or trust-changing actions are for a logged-in human, never for an API key that may have leaked. */
export function dashboardOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.auth.via === "session") return true;
  reply.code(403).send({ error: { code: "dashboard_only", message: "This action is only available from the dashboard." } });
  return false;
}

/** dashboardOnly + the person confirmed their password / 2FA code in the last 10 minutes (POST /auth/step-up). */
export function requireStepUp(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!dashboardOnly(req, reply)) return false;
  if (req.auth.steppedUp) return true;
  reply.code(403).send({ error: { code: "step_up_required", message: "Confirm your password or 2FA code first (POST /auth/step-up)." } });
  return false;
}
