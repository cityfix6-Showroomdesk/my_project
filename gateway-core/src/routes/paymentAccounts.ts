import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool, withTx } from "../db.js";
import { newId } from "../ids.js";
import { authenticateRequest, requireStepUp } from "../authContext.js";
import { config } from "../config.js";
import { VPA_RE } from "../upi.js";

const MAX_ACCOUNTS = 5;

const serialize = (r: any) => ({
  id: r.id, object: "payment_account", type: r.type, vpa: r.vpa, payee_name: r.payee_name,
  verification_status: r.verification_status, status: r.status, is_default: r.is_default, created_at: r.created_at,
});

const addSchema = z.object({
  vpa: z.string().trim().regex(VPA_RE, "invalid UPI ID"),
  payee_name: z.string().trim().min(2).max(99),
});

const audit = (merchantId: string, action: string, detail: object, ip: string) =>
  pool.query("INSERT INTO audit_logs (merchant_id, action, detail, ip) VALUES ($1,$2,$3,$4)",
    [merchantId, action, JSON.stringify(detail), ip]);

export async function paymentAccountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/v1/")) return; // admin routes use their own token
    const auth = await authenticateRequest(req);
    if (!auth) return reply.code(401).send({ error: { code: "unauthorized" } });
    req.auth = auth;
  });

  app.post("/v1/payment-accounts", async (req, reply) => {
    if (!requireStepUp(req, reply)) return reply;
    const body = addSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request", details: body.error.flatten() } });
    const mid = req.auth.merchantId;

    const count = await pool.query("SELECT count(*)::int n FROM merchant_accounts WHERE merchant_id=$1 AND status='active'", [mid]);
    if (count.rows[0].n >= MAX_ACCOUNTS) return reply.code(422).send({ error: { code: "account_limit_reached" } });

    const insert = (autoDefault: boolean) => pool.query(
      `INSERT INTO merchant_accounts (id, merchant_id, vpa, payee_name, is_default)
       VALUES ($1,$2,$3,$4, $5 AND NOT EXISTS (SELECT 1 FROM merchant_accounts WHERE merchant_id=$2 AND is_default AND status='active'))
       RETURNING *`,
      [newId("acc"), mid, body.data.vpa, body.data.payee_name, autoDefault]);

    let rows;
    try {
      ({ rows } = await insert(true));
    } catch (e: any) {
      if (e.constraint === "merchant_accounts_vpa_uidx") return reply.code(409).send({ error: { code: "vpa_already_added" } });
      if (e.constraint === "merchant_accounts_default_uidx") ({ rows } = await insert(false)); // lost a race
      else throw e;
    }
    await audit(mid, "payment_account.added", { id: rows[0].id, vpa: rows[0].vpa }, req.ip);
    return reply.code(201).send(serialize(rows[0]));
  });

  app.get("/v1/payment-accounts", async (req) => {
    const { rows } = await pool.query(
      "SELECT * FROM merchant_accounts WHERE merchant_id=$1 AND status='active' ORDER BY created_at", [req.auth.merchantId]);
    return { data: rows.map(serialize) };
  });

  app.post("/v1/payment-accounts/:id/default", async (req, reply) => {
    if (!requireStepUp(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const mid = req.auth.merchantId;
    const ok = await withTx(async (c) => {
      const acc = await c.query("SELECT id FROM merchant_accounts WHERE id=$1 AND merchant_id=$2 AND status='active' FOR UPDATE", [id, mid]);
      if (!acc.rows[0]) return false;
      await c.query("UPDATE merchant_accounts SET is_default=false WHERE merchant_id=$1 AND is_default", [mid]);
      await c.query("UPDATE merchant_accounts SET is_default=true WHERE id=$1", [id]);
      return true;
    });
    if (!ok) return reply.code(404).send({ error: { code: "not_found" } });
    await audit(mid, "payment_account.default_changed", { id }, req.ip);
    return { ok: true };
  });

  app.delete("/v1/payment-accounts/:id", async (req, reply) => {
    if (!requireStepUp(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const { rowCount } = await pool.query(
      "UPDATE merchant_accounts SET status='disabled', is_default=false WHERE id=$1 AND merchant_id=$2 AND status='active'",
      [id, req.auth.merchantId]);
    if (!rowCount) return reply.code(404).send({ error: { code: "not_found" } });
    await audit(req.auth.merchantId, "payment_account.disabled", { id }, req.ip);
    return reply.code(204).send();
  });

  // INTERIM verification by an operator. Module 3 adds automatic verification through provider adapters.
  app.post("/admin/payment-accounts/:id/verify", async (req, reply) => {
    const sent = String(req.headers["x-admin-token"] ?? "");
    const want = config.adminToken;
    if (!want) return reply.code(404).send();
    const a = Buffer.from(sent), b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: { code: "unauthorized" } });

    const { id } = req.params as { id: string };
    const { result } = z.object({ result: z.enum(["verified", "rejected"]) }).parse(req.body);
    try {
      const { rows } = await pool.query(
        `UPDATE merchant_accounts SET verification_status=$2, verified_at = CASE WHEN $2='verified' THEN now() END
          WHERE id=$1 AND status='active' RETURNING *`, [id, result]);
      if (!rows[0]) return reply.code(404).send({ error: { code: "not_found" } });
      await audit(rows[0].merchant_id, `payment_account.${result}`, { id, by: "admin" }, req.ip);
      return serialize(rows[0]);
    } catch (e: any) {
      if (e.constraint === "merchant_accounts_verified_vpa_uidx")
        return reply.code(409).send({ error: { code: "vpa_verified_for_another_merchant" } });
      throw e;
    }
  });
}
