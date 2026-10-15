import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTx } from "../db.js";
import { newId } from "../ids.js";
import { authenticateRequest, requireStepUp } from "../authContext.js";
import { encrypt, decrypt } from "../crypto.js";
import { config } from "../config.js";
import { getVerifier } from "../verifiers/index.js";
import { ProviderAuthError, ProviderTransientError } from "../verifiers/types.js";
import { checkOrder } from "../reconciler.js";

const connSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("razorpay"),
    key_id: z.string().regex(/^rzp_(test|live)_[A-Za-z0-9]{8,}$/),
    key_secret: z.string().min(10).max(100),
    webhook_secret: z.string().min(8).max(100).optional(),
  }),
  z.object({ // Paytm: key_id = your MID, key_secret = your merchant key, mode is explicit (MIDs carry no test/live prefix)
    provider: z.literal("paytm"),
    key_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    key_secret: z.string().min(8).max(100),
    mode: z.enum(["test", "live"]),
    webhook_secret: z.string().min(8).max(100).optional(),
  }),
]);

const serializeConn = (r: any) => ({
  id: r.id, object: "provider_connection", provider: r.provider, mode: r.mode, status: r.status,
  webhook_url: r.provider === "razorpay" ? `${config.publicBaseUrl}/webhooks/${r.provider}/${r.id}` : null, // Paytm is detected by polling created_at: r.created_at,
});

const serializePayment = (r: any) => ({
  id: r.id, order_id: r.order_id, provider: r.provider, provider_payment_id: r.provider_payment_id,
  amount: Number(r.amount_paise), currency: r.currency, status: r.status, match_status: r.match_status,
  payer_vpa: r.payer_vpa, rrn: r.rrn, paid_at: r.paid_at, created_at: r.created_at,
});

export async function providerRoutes(app: FastifyInstance) {
  // ---------- authenticated merchant API ----------
  await app.register(async (api) => {
    api.addHook("preHandler", async (req, reply) => {
      const auth = await authenticateRequest(req);
      if (!auth) return reply.code(401).send({ error: { code: "unauthorized" } });
      req.auth = auth;
    });

    api.post("/v1/provider-connections", async (req, reply) => {
    if (!requireStepUp(req, reply)) return reply;
      const body = connSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: { code: "invalid_request", details: body.error.flatten() } });
      const { key_id, key_secret, webhook_secret } = body.data;
      const provider = body.data.provider;
      const mode = body.data.provider === "paytm" ? body.data.mode : key_id.startsWith("rzp_live_") ? "live" : "test";

      try {
        await getVerifier(provider).validateCredentials({ keyId: key_id, keySecret: key_secret, mode });
      } catch (e) {
        if (e instanceof ProviderAuthError) return reply.code(422).send({ error: { code: "invalid_credentials" } });
        if (e instanceof ProviderTransientError) return reply.code(503).send({ error: { code: "provider_unavailable" } });
        throw e;
      }

      const mid = req.auth.merchantId;
      const conn = await withTx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO provider_connections (id, merchant_id, provider, mode, credentials_enc, webhook_secret_enc)
           VALUES ($1,$2,$6,$3,$4,$5)
           ON CONFLICT (merchant_id, provider, mode)
           DO UPDATE SET credentials_enc=EXCLUDED.credentials_enc, webhook_secret_enc=EXCLUDED.webhook_secret_enc, status='active'
           RETURNING *`,
          [newId("con"), mid, mode, encrypt(JSON.stringify({ keyId: key_id, keySecret: key_secret, mode })),
           webhook_secret ? encrypt(webhook_secret) : null, provider]);
        const row = rows[0];
        const acc = await c.query("SELECT id FROM merchant_accounts WHERE connection_id=$1", [row.id]);
        if (acc.rows[0]) {
          await c.query("UPDATE merchant_accounts SET status='active' WHERE id=$1", [acc.rows[0].id]);
        } else {
          const name = (await c.query("SELECT business_name FROM merchants WHERE id=$1", [mid])).rows[0].business_name;
          await c.query(
            `INSERT INTO merchant_accounts (id, merchant_id, type, payee_name, verification_status, verified_at, connection_id, is_default)
             VALUES ($1,$2,$5,$3,'verified',now(),$4,
                     NOT EXISTS (SELECT 1 FROM merchant_accounts WHERE merchant_id=$2 AND is_default AND status='active'))`,
            [newId("acc"), mid, name, row.id, provider]);
        }
        await c.query("INSERT INTO audit_logs (merchant_id, action, detail, ip) VALUES ($1,'provider_connection.saved',$2,$3)",
          [mid, JSON.stringify({ id: row.id, provider, mode }), req.ip]);
        return row;
      });
      return reply.code(201).send({
        ...serializeConn(conn),
        next_step: provider === "razorpay"
          ? "In the Razorpay dashboard add a webhook to webhook_url using the same webhook secret. Webhooks only prompt a re-check; without them we still detect payments by polling."
          : "Paytm payments are detected by polling Paytm's status API; no webhook setup is needed.",
      });
    });

    api.get("/v1/provider-connections", async (req) => {
      const { rows } = await pool.query("SELECT * FROM provider_connections WHERE merchant_id=$1 ORDER BY created_at", [req.auth.merchantId]);
      return { data: rows.map(serializeConn) };
    });

    api.delete("/v1/provider-connections/:id", async (req, reply) => {
    if (!requireStepUp(req, reply)) return reply;
      const { id } = req.params as { id: string };
      const ok = await withTx(async (c) => {
        const r = await c.query("UPDATE provider_connections SET status='disabled' WHERE id=$1 AND merchant_id=$2 AND status<>'disabled'", [id, req.auth.merchantId]);
        if (!r.rowCount) return false;
        await c.query("UPDATE merchant_accounts SET status='disabled', is_default=false WHERE connection_id=$1", [id]);
        await c.query("INSERT INTO audit_logs (merchant_id, action, detail, ip) VALUES ($1,'provider_connection.disabled',$2,$3)",
          [req.auth.merchantId, JSON.stringify({ id }), req.ip]);
        return true;
      });
      return ok ? reply.code(204).send() : reply.code(404).send({ error: { code: "not_found" } });
    });

    // Payments incl. the ones that need merchant attention (wrong amount, late, paid twice)
    api.get("/v1/payments", async (req) => {
      const q = z.object({
        match_status: z.enum(["matched", "amount_mismatch", "late", "duplicate_payment", "not_captured"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }).parse(req.query);
      const params: unknown[] = [req.auth.merchantId, req.auth.mode];
      let where = "merchant_id=$1 AND mode=$2";
      if (q.match_status) { params.push(q.match_status); where += ` AND match_status=$${params.length}`; }
      params.push(q.limit);
      const { rows } = await pool.query(`SELECT * FROM payments WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return { data: rows.map(serializePayment) };
    });
  });

  // ---------- provider webhooks (public, signature-verified) ----------
  await app.register(async (hooks) => {
    // Keep the raw bytes: the signature is computed over them, not over re-serialized JSON.
    hooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
      (req as any).rawBody = body;
      try { done(null, JSON.parse((body as Buffer).toString("utf8"))); } catch (e) { done(e as Error, undefined); }
    });

    hooks.post("/webhooks/razorpay/:connectionId", async (req, reply) => {
      const { connectionId } = req.params as { connectionId: string };
      const conn = (await pool.query("SELECT * FROM provider_connections WHERE id=$1 AND provider='razorpay'", [connectionId])).rows[0];
      if (!conn || !conn.webhook_secret_enc) return reply.code(404).send();

      const verifier = getVerifier("razorpay");
      const sig = req.headers["x-razorpay-signature"];
      const ok = verifier.verifyWebhook!((req as any).rawBody, typeof sig === "string" ? sig : undefined, decrypt(conn.webhook_secret_enc));
      if (!ok) return reply.code(401).send({ error: { code: "bad_signature" } });

      // A webhook is only a PROMPT. We never trust its payload for money: we re-fetch from the provider.
      const ref = verifier.extractProviderRef!(req.body);
      if (ref) {
        const o = (await pool.query(
          "UPDATE orders SET next_check_at=now() WHERE provider='razorpay' AND provider_ref=$1 AND connection_id=$2 AND status<>'paid' RETURNING id",
          [ref, conn.id])).rows[0];
        if (o) checkOrder(o.id, req.log).catch((e) => req.log.error(e));
      }
      return { ok: true };
    });
  });
}
