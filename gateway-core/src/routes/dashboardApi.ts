import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { newId } from "../ids.js";
import { encrypt } from "../crypto.js";
import { createApiKey } from "../apiKeys.js";
import { requireSession, requireStepUp } from "../authContext.js";
import { billingSnapshot } from "../billing.js";
import { BUSINESS_TYPES, CATEGORIES, GSTIN_RE, PAN_RE, screenRisk } from "../kycPolicy.js";

const audit = (merchantId: string, action: string, detail: object, ip: string) =>
  pool.query("INSERT INTO audit_logs (merchant_id, action, detail, ip) VALUES ($1,$2,$3,$4)", [merchantId, action, JSON.stringify(detail), ip]);

const kycSchema = z.object({
  legal_name: z.string().trim().min(2).max(150),
  business_type: z.enum(BUSINESS_TYPES),
  pan: z.string().trim().toUpperCase().regex(PAN_RE),
  gstin: z.string().trim().toUpperCase().regex(GSTIN_RE).optional(),
  website: z.string().url().max(300).optional(),
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(10).max(500),
  no_prohibited_activity: z.literal(true), // attests: no gambling, betting, loan apps, adult, crypto, etc.
  accepts_terms: z.literal(true),
});

export async function dashboardApiRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply) => { reply.header("cache-control", "no-store"); });

  // ---------- API keys (dashboard-only: a leaked key must not be able to mint or revoke keys) ----------
  app.get("/dashboard/api-keys", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const { rows } = await pool.query("SELECT id, mode, prefix, last_used_at, revoked_at, created_at FROM api_keys WHERE merchant_id=$1 ORDER BY created_at DESC", [a.merchantId]);
    return { data: rows };
  });

  app.post("/dashboard/api-keys", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    if (!requireStepUp(req, reply)) return reply;
    const body = z.object({ mode: z.enum(["test", "live"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    if (body.data.mode === "live" && a.kycStatus !== "approved") return reply.code(403).send({ error: { code: "kyc_required" } });
    const n = (await pool.query("SELECT count(*)::int n FROM api_keys WHERE merchant_id=$1 AND mode=$2 AND revoked_at IS NULL", [a.merchantId, body.data.mode])).rows[0].n;
    if (n >= 10) return reply.code(422).send({ error: { code: "key_limit_reached" } });
    const k = await createApiKey(pool, a.merchantId, body.data.mode);
    await audit(a.merchantId, "api_key.created", { id: k.id, mode: body.data.mode }, req.ip);
    return reply.code(201).send({ id: k.id, mode: body.data.mode, key: k.key, note: "Copy this key now. It is shown only once." });
  });

  app.delete("/dashboard/api-keys/:id", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    if (!requireStepUp(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const r = await pool.query("UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND merchant_id=$2 AND revoked_at IS NULL", [id, a.merchantId]);
    if (!r.rowCount) return reply.code(404).send({ error: { code: "not_found" } });
    await audit(a.merchantId, "api_key.revoked", { id }, req.ip);
    return reply.code(204).send();
  });

  // ---------- KYC: the gate to live mode ----------
  app.get("/dashboard/kyc", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const sub = (await pool.query("SELECT status, reviewer_note, created_at, reviewed_at FROM kyc_submissions WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 1", [a.merchantId])).rows[0];
    return { kyc_status: a.kycStatus, latest_submission: sub ?? null };
  });

  app.post("/dashboard/kyc", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const body = kycSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request", details: body.error.flatten() } });
    if (a.kycStatus !== "pending" && a.kycStatus !== "rejected") return reply.code(409).send({ error: { code: "kyc_already_" + a.kycStatus } });
    const m = (await pool.query("SELECT business_name FROM merchants WHERE id=$1", [a.merchantId])).rows[0];
    const flags = screenRisk(m.business_name, body.data.legal_name, body.data.description, body.data.website);
    await pool.query("INSERT INTO kyc_submissions (id, merchant_id, data_enc, risk_flags) VALUES ($1,$2,$3,$4)",
      [newId("kyc"), a.merchantId, encrypt(JSON.stringify(body.data)), flags]);
    await pool.query("UPDATE merchants SET kyc_status='submitted' WHERE id=$1", [a.merchantId]);
    await audit(a.merchantId, "kyc.submitted", { risk_flags: flags.length }, req.ip);
    return reply.code(202).send({ kyc_status: "submitted", message: "Submitted for review." });
  });

  // ---------- overview numbers for the dashboard home ----------
  app.get("/dashboard/summary", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const p = [a.merchantId, a.mode];
    const [orders, today, flagged, hooks, setup] = await Promise.all([
      pool.query(`SELECT status, count(*)::int n, COALESCE(sum(amount_paise),0)::bigint amt FROM orders
                   WHERE merchant_id=$1 AND mode=$2 AND created_at > now() - interval '30 days' GROUP BY status`, p),
      pool.query(`SELECT COALESCE(sum(amount_paise),0)::bigint amt, count(*)::int n FROM orders
                   WHERE merchant_id=$1 AND mode=$2 AND status='paid'
                     AND (paid_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`, p),
      pool.query(`SELECT count(*)::int n FROM payments WHERE merchant_id=$1 AND mode=$2
                   AND match_status IN ('amount_mismatch','late','duplicate_payment') AND created_at > now() - interval '30 days'`, p),
      pool.query(`SELECT count(*)::int n FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id=d.endpoint_id
                   WHERE w.merchant_id=$1 AND w.mode=$2 AND d.status='failed' AND d.created_at > now() - interval '7 days'`, p),
      pool.query(`SELECT (SELECT count(*)::int FROM merchant_accounts WHERE merchant_id=$1 AND status='active') accounts,
                         (SELECT count(*)::int FROM webhook_endpoints WHERE merchant_id=$1 AND mode=$2 AND status='active') endpoints,
                         (SELECT count(*)::int FROM api_keys WHERE merchant_id=$1 AND mode=$2 AND revoked_at IS NULL) keys`, p),
    ]);
    const by: Record<string, { count: number; amount: number }> = {};
    for (const r of orders.rows) by[r.status] = { count: r.n, amount: Number(r.amt) };
    const paid = by.paid?.count ?? 0, closed = paid + (by.expired?.count ?? 0) + (by.failed?.count ?? 0);
    return {
      mode: a.mode, kyc_status: a.kycStatus, billing: await billingSnapshot(a.merchantId),
      last_30_days: { orders_by_status: by, success_rate: closed ? Math.round((paid / closed) * 1000) / 10 : null },
      today_ist: { paid_amount: Number(today.rows[0].amt), paid_orders: today.rows[0].n },
      needs_attention: { flagged_payments: flagged.rows[0].n, failed_webhook_deliveries: hooks.rows[0].n },
      setup: { payment_accounts: setup.rows[0].accounts, webhook_endpoints: setup.rows[0].endpoints, api_keys: setup.rows[0].keys },
    };
  });
}
