import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { z } from "zod";
import { pool, withTx } from "../db.js";
import { newId, sha256 } from "../ids.js";
import { config } from "../config.js";
import { encrypt, decrypt } from "../crypto.js";
import { hashPassword, verifyPassword, checkPasswordPolicy } from "../password.js";
import { base32Encode, base32Decode, verifyTotp } from "../totp.js";
import { sendMail } from "../mailer.js";
import { createSession, revokeSession, revokeAllSessions, sessionCookie, clearCookie } from "../sessions.js";
import { requireSession, requireStepUp } from "../authContext.js";

const email = z.string().trim().toLowerCase().email().max(254);
const strict = (max: number, window = "1 minute") => ({ config: { rateLimit: { max, timeWindow: window } } });
const audit = (merchantId: string | null, action: string, detail: object, ip: string) =>
  pool.query("INSERT INTO audit_logs (merchant_id, action, detail, ip) VALUES ($1,$2,$3,$4)", [merchantId, action, JSON.stringify(detail), ip]);

const me = (m: any, mode?: string) => ({
  id: m.id, email: m.email, business_name: m.business_name, kyc_status: m.kyc_status,
  email_verified: !!m.email_verified_at, totp_enabled: m.totp_enabled, mode,
});

async function issueEmailToken(merchantId: string, purpose: "verify_email" | "reset_password", minutes: number) {
  const token = randomBytes(32).toString("base64url");
  await pool.query("INSERT INTO email_tokens (token_hash, merchant_id, purpose, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)",
    [sha256(token), merchantId, purpose, String(minutes)]);
  return token;
}
/** Atomic single use: two clicks of the same link can't both succeed. */
async function consumeEmailToken(token: string, purpose: string): Promise<string | null> {
  const { rows } = await pool.query(
    "UPDATE email_tokens SET used_at=now() WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at > now() RETURNING merchant_id",
    [sha256(token), purpose]);
  return rows[0]?.merchant_id ?? null;
}

async function recordFailure(merchantId: string) {
  await pool.query(
    `UPDATE merchants SET locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
                          failed_logins = CASE WHEN failed_logins + 1 >= 5 THEN 0 ELSE failed_logins + 1 END WHERE id=$1`, [merchantId]);
}

/** A 6-digit authenticator code (each usable once) OR a one-time recovery code. */
async function checkSecondFactor(m: any, code: string): Promise<boolean> {
  const c = code.trim();
  if (/^\d{6}$/.test(c)) {
    if (!m.totp_secret_enc) return false;
    const step = verifyTotp(base32Decode(decrypt(m.totp_secret_enc)), c, Date.now(), m.totp_last_step == null ? null : Number(m.totp_last_step));
    if (step === null) return false;
    const r = await pool.query("UPDATE merchants SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2)", [m.id, step]);
    return r.rowCount === 1;
  }
  const norm = c.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm.length !== 10) return false;
  const r = await pool.query("UPDATE recovery_codes SET used_at=now() WHERE merchant_id=$1 AND code_hash=$2 AND used_at IS NULL", [m.id, sha256(norm)]);
  return r.rowCount === 1;
}

const RC_ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
function newRecoveryCode(): string {
  let s = "";
  while (s.length < 10) for (const b of randomBytes(16)) if (b < 248 && s.length < 10) s += RC_ALPHA[b % RC_ALPHA.length]; // no modulo bias
  return s;
}

export async function authRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply) => { reply.header("cache-control", "no-store"); });

  app.post("/auth/signup", strict(5, "1 hour"), async (req, reply) => {
    const body = z.object({ email, password: z.string().max(128), business_name: z.string().trim().min(2).max(120) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request", details: body.error.flatten() } });
    const bad = checkPasswordPolicy(body.data.password, body.data.email);
    if (bad) return reply.code(422).send({ error: { code: "weak_password", message: `Password ${bad}.` } });

    const hash = await hashPassword(body.data.password); // same cost whether or not the email exists
    const generic = { ok: true, message: "If this email can be used, a verification link has been sent to it." };
    try {
      const id = newId("mer");
      await pool.query("INSERT INTO merchants (id, email, business_name, password_hash) VALUES ($1,$2,$3,$4)", [id, body.data.email, body.data.business_name, hash]);
      await pool.query("INSERT INTO subscriptions (merchant_id, status, trial_ends_at) VALUES ($1,'trialing', now() + ($2 || ' days')::interval) ON CONFLICT DO NOTHING", [id, String(config.trialDays)]);
      const token = await issueEmailToken(id, "verify_email", 24 * 60);
      await sendMail({ to: body.data.email, subject: "Verify your email",
        text: `Welcome! Confirm your email within 24 hours:\n${config.publicBaseUrl}/dashboard/#/verify-email?token=${token}\n\n(API: POST /auth/verify-email {"token":"${token}"})` });
      await audit(id, "merchant.signup", {}, req.ip);
    } catch (e: any) {
      if (e.code !== "23505") throw e;
      // Existing account: say nothing different to the caller, but tell the real owner.
      await sendMail({ to: body.data.email, subject: "Sign-up attempt on your account",
        text: "Someone tried to create an account with your email. If that was you, log in or reset your password. Otherwise ignore this." });
    }
    return reply.code(202).send(generic);
  });

  app.post("/auth/verify-email", strict(10), async (req, reply) => {
    const body = z.object({ token: z.string().min(20).max(100) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const mid = await consumeEmailToken(body.data.token, "verify_email");
    if (!mid) return reply.code(400).send({ error: { code: "invalid_or_expired_token" } });
    await pool.query("UPDATE merchants SET email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1", [mid]);
    await audit(mid, "merchant.email_verified", {}, req.ip);
    return { ok: true };
  });

  app.post("/auth/login", strict(10), async (req, reply) => {
    const body = z.object({ email, password: z.string().min(1).max(128), code: z.string().max(32).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const m = (await pool.query("SELECT * FROM merchants WHERE email=$1", [body.data.email])).rows[0];

    const pwOk = await verifyPassword(body.data.password, m?.password_hash ?? null);
    if (m?.locked_until && new Date(m.locked_until) > new Date())
      return reply.code(429).send({ error: { code: "account_locked", message: "Too many failed attempts. Try again in 15 minutes." } });
    if (!m || !pwOk || m.status !== "active") {
      if (m) { await recordFailure(m.id); await audit(m.id, "login.failed", { reason: "password" }, req.ip); }
      return reply.code(401).send({ error: { code: "invalid_credentials" } });
    }
    if (!m.email_verified_at) return reply.code(403).send({ error: { code: "email_not_verified" } });

    if (m.totp_enabled) {
      if (!body.data.code) return reply.code(401).send({ error: { code: "totp_required" } }); // password was right; ask for the 2nd factor
      if (!(await checkSecondFactor(m, body.data.code))) {
        await recordFailure(m.id); await audit(m.id, "login.failed", { reason: "2fa" }, req.ip);
        return reply.code(401).send({ error: { code: "invalid_code" } });
      }
    }
    await pool.query("UPDATE merchants SET failed_logins=0, locked_until=NULL WHERE id=$1", [m.id]);
    const s = await createSession(m.id, req.ip, req.headers["user-agent"]); // fresh session id on every login
    await audit(m.id, "login.success", {}, req.ip);
    return reply.header("set-cookie", sessionCookie(s.token)).send({ csrf_token: s.csrf, merchant: me(m, "test") });
  });

  app.post("/auth/logout", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    await revokeSession(a.sessionId!);
    return reply.header("set-cookie", clearCookie()).send({ ok: true });
  });

  app.get("/auth/session", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const s = (await pool.query("SELECT csrf_token, stepped_up_at FROM sessions WHERE id=$1", [a.sessionId])).rows[0];
    const m = (await pool.query("SELECT * FROM merchants WHERE id=$1", [a.merchantId])).rows[0];
    return { csrf_token: s.csrf_token, merchant: me(m, a.mode), step_up_active: !!a.steppedUp };
  });

  app.post("/auth/mode", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const body = z.object({ mode: z.enum(["test", "live"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    if (body.data.mode === "live" && a.kycStatus !== "approved") return reply.code(403).send({ error: { code: "kyc_required" } });
    await pool.query("UPDATE sessions SET mode=$2 WHERE id=$1", [a.sessionId, body.data.mode]);
    return { mode: body.data.mode };
  });

  // Re-confirm identity before sensitive actions: 2FA code if enabled, otherwise password. Valid for 10 minutes.
  app.post("/auth/step-up", strict(10), async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const body = z.object({ password: z.string().max(128).optional(), code: z.string().max(32).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const m = (await pool.query("SELECT * FROM merchants WHERE id=$1", [a.merchantId])).rows[0];
    const ok = m.totp_enabled
      ? !!body.data.code && (await checkSecondFactor(m, body.data.code))
      : !!body.data.password && (await verifyPassword(body.data.password, m.password_hash));
    if (!ok) { await recordFailure(m.id); await audit(m.id, "step_up.failed", {}, req.ip); return reply.code(401).send({ error: { code: "invalid_credentials" } }); }
    await pool.query("UPDATE sessions SET stepped_up_at=now() WHERE id=$1", [a.sessionId]);
    return { ok: true, valid_for_seconds: 600 };
  });

  // ---------- passwords ----------
  app.post("/auth/password/forgot", strict(5, "1 hour"), async (req, reply) => {
    const body = z.object({ email }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const m = (await pool.query("SELECT id FROM merchants WHERE email=$1 AND status='active'", [body.data.email])).rows[0];
    if (m) {
      const token = await issueEmailToken(m.id, "reset_password", 60);
      await sendMail({ to: body.data.email, subject: "Reset your password",
        text: `Reset link (valid 1 hour):\n${config.publicBaseUrl}/dashboard/#/reset-password?token=${token}\n\nIf you didn't ask for this, ignore it.` });
      await audit(m.id, "password.reset_requested", {}, req.ip);
    }
    return reply.code(202).send({ ok: true, message: "If that email has an account, a reset link has been sent." });
  });

  app.post("/auth/password/reset", strict(10), async (req, reply) => {
    const body = z.object({ token: z.string().min(20).max(100), new_password: z.string().max(128) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const mid = await consumeEmailToken(body.data.token, "reset_password");
    if (!mid) return reply.code(400).send({ error: { code: "invalid_or_expired_token" } });
    const m = (await pool.query("SELECT email FROM merchants WHERE id=$1", [mid])).rows[0];
    const bad = checkPasswordPolicy(body.data.new_password, m.email);
    if (bad) return reply.code(422).send({ error: { code: "weak_password", message: `Password ${bad}.` } }); // token already spent: request a new link
    await pool.query("UPDATE merchants SET password_hash=$2, failed_logins=0, locked_until=NULL, email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1",
      [mid, await hashPassword(body.data.new_password)]);
    await pool.query("UPDATE email_tokens SET used_at=now() WHERE merchant_id=$1 AND purpose='reset_password' AND used_at IS NULL", [mid]);
    await revokeAllSessions(mid); // anyone holding an old session is thrown out
    await audit(mid, "password.reset", {}, req.ip);
    return { ok: true };
  });

  app.post("/auth/password/change", strict(10), async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const body = z.object({ current_password: z.string().max(128), new_password: z.string().max(128) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const m = (await pool.query("SELECT * FROM merchants WHERE id=$1", [a.merchantId])).rows[0];
    if (!(await verifyPassword(body.data.current_password, m.password_hash))) { await recordFailure(m.id); return reply.code(401).send({ error: { code: "invalid_credentials" } }); }
    const bad = checkPasswordPolicy(body.data.new_password, m.email);
    if (bad) return reply.code(422).send({ error: { code: "weak_password", message: `Password ${bad}.` } });
    await pool.query("UPDATE merchants SET password_hash=$2 WHERE id=$1", [m.id, await hashPassword(body.data.new_password)]);
    await revokeAllSessions(m.id, a.sessionId); // keep this session, drop the rest
    await audit(m.id, "password.changed", {}, req.ip);
    return { ok: true };
  });

  // ---------- two-factor ----------
  app.post("/auth/2fa/setup", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    if (!requireStepUp(req, reply)) return reply;
    const m = (await pool.query("SELECT * FROM merchants WHERE id=$1", [a.merchantId])).rows[0];
    if (m.totp_enabled) return reply.code(409).send({ error: { code: "already_enabled" } });
    const secret = base32Encode(randomBytes(20));
    await pool.query("UPDATE merchants SET totp_secret_enc=$2 WHERE id=$1", [m.id, encrypt(secret)]);
    const uri = `otpauth://totp/${encodeURIComponent(`${config.appName}:${m.email}`)}?secret=${secret}&issuer=${encodeURIComponent(config.appName)}&algorithm=SHA1&digits=6&period=30`;
    return { secret, otpauth_uri: uri, qr_svg: await QRCode.toString(uri, { type: "svg", margin: 1 }) };
  });

  app.post("/auth/2fa/enable", strict(10), async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    if (!requireStepUp(req, reply)) return reply;
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const m = (await pool.query("SELECT * FROM merchants WHERE id=$1", [a.merchantId])).rows[0];
    if (m.totp_enabled || !m.totp_secret_enc) return reply.code(409).send({ error: { code: "setup_required" } });
    const step = verifyTotp(base32Decode(decrypt(m.totp_secret_enc)), body.data.code, Date.now(), null);
    if (step === null) return reply.code(401).send({ error: { code: "invalid_code" } });

    const codes = Array.from({ length: 10 }, newRecoveryCode);
    await withTx(async (c) => {
      await c.query("UPDATE merchants SET totp_enabled=true, totp_last_step=$2 WHERE id=$1", [m.id, step]);
      await c.query("DELETE FROM recovery_codes WHERE merchant_id=$1", [m.id]);
      for (const code of codes) await c.query("INSERT INTO recovery_codes (merchant_id, code_hash) VALUES ($1,$2)", [m.id, sha256(code)]);
    });
    await audit(m.id, "2fa.enabled", {}, req.ip);
    return { enabled: true, recovery_codes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`), note: "Save these now. Each works once, and they are not shown again." };
  });

  app.post("/auth/2fa/recovery-codes", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    if (!requireStepUp(req, reply)) return reply;
    const m = (await pool.query("SELECT totp_enabled FROM merchants WHERE id=$1", [a.merchantId])).rows[0];
    if (!m.totp_enabled) return reply.code(409).send({ error: { code: "2fa_not_enabled" } });
    const codes = Array.from({ length: 10 }, newRecoveryCode);
    await withTx(async (c) => {
      await c.query("DELETE FROM recovery_codes WHERE merchant_id=$1", [a.merchantId]);
      for (const code of codes) await c.query("INSERT INTO recovery_codes (merchant_id, code_hash) VALUES ($1,$2)", [a.merchantId, sha256(code)]);
    });
    await audit(a.merchantId, "2fa.recovery_codes_regenerated", {}, req.ip);
    return { recovery_codes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`) };
  });

  app.post("/auth/2fa/disable", strict(10), async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const body = z.object({ password: z.string().max(128), code: z.string().max(32) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const m = (await pool.query("SELECT * FROM merchants WHERE id=$1", [a.merchantId])).rows[0];
    if (!m.totp_enabled) return reply.code(409).send({ error: { code: "2fa_not_enabled" } });
    // Turning protection OFF needs BOTH factors, so a stolen session alone can't strip 2FA.
    if (!(await verifyPassword(body.data.password, m.password_hash)) || !(await checkSecondFactor(m, body.data.code))) {
      await recordFailure(m.id); return reply.code(401).send({ error: { code: "invalid_credentials" } });
    }
    await withTx(async (c) => {
      await c.query("UPDATE merchants SET totp_enabled=false, totp_secret_enc=NULL, totp_last_step=NULL WHERE id=$1", [m.id]);
      await c.query("DELETE FROM recovery_codes WHERE merchant_id=$1", [m.id]);
    });
    await audit(m.id, "2fa.disabled", {}, req.ip);
    return { enabled: false };
  });
}
