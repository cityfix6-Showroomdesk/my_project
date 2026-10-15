import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { pool } from "../db.js";
import { recordProviderPayment } from "../settlement.js";
import { checkOrderEntitlement } from "../billing.js";
import { ProviderAuthError, ProviderRequestError, ProviderTransientError } from "../verifiers/types.js";
import type { AuthContext } from "../apiKeys.js";
import { authenticateRequest, dashboardOnly } from "../authContext.js";
import { createOrder, getOrder, listOrders, serializeOrder, IdempotencyConflict, NoPaymentAccount } from "../orderService.js";

declare module "fastify" {
  interface FastifyRequest { auth: AuthContext }
}

const createSchema = z.object({
  amount: z.number().int().min(100).max(100_000_000), // paise: ₹1 to ₹10 lakh
  currency: z.literal("INR").default("INR"),
  reference: z.string().max(100).optional(),
  customer: z.object({
    name: z.string().max(100).optional(),
    email: z.string().email().optional(),
    phone: z.string().regex(/^\+?[0-9]{10,13}$/).optional(),
  }).optional(),
  metadata: z.record(z.string().max(500)).refine((m) => Object.keys(m).length <= 20).optional(),
  expires_in_seconds: z.number().int().min(60).max(86_400).default(900),
});

export async function orderRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    const auth = await authenticateRequest(req);
    if (!auth) return reply.code(401).send({ error: { code: "unauthorized" } });
    if (auth.mode === "live" && auth.kycStatus !== "approved")
      return reply.code(403).send({ error: { code: "kyc_required" } });
    req.auth = auth;
  });

  app.post("/v1/orders", async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request", details: body.error.flatten() } });

    const idem = req.headers["idempotency-key"];
    if (idem !== undefined && (typeof idem !== "string" || idem.length < 8 || idem.length > 100))
      return reply.code(400).send({ error: { code: "invalid_idempotency_key" } });

    try {
      const blocked = await checkOrderEntitlement(req.auth.merchantId, req.auth.mode); // M6: suspended / over plan limit
      if (blocked) return reply.code(402).send({ error: blocked });
      const { order, replayed } = await createOrder(req.auth, body.data, idem as string | undefined);
      if (replayed) reply.header("Idempotent-Replayed", "true");
      return reply.code(replayed ? 200 : 201).send(serializeOrder(order));
    } catch (e) {
      if (e instanceof NoPaymentAccount) return reply.code(422).send({ error: { code: "no_payment_account", message: "Add and verify a payment account first" } });
      if (e instanceof ProviderAuthError) return reply.code(422).send({ error: { code: "provider_credentials_invalid" } });
      if (e instanceof ProviderTransientError) return reply.code(503).send({ error: { code: "provider_unavailable" } });
      if (e instanceof ProviderRequestError) return reply.code(502).send({ error: { code: "provider_error", message: e.message } });
      if (e instanceof IdempotencyConflict) return reply.code(409).send({ error: { code: "idempotency_conflict", message: e.message } });
      throw e;
    }
  });

  app.get("/v1/orders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = await getOrder(req.auth, id);
    return order ? serializeOrder(order) : reply.code(404).send({ error: { code: "not_found" } });
  });

  // For orders on a raw UPI ID, nothing can detect the payment automatically. The merchant, who sees
  // their own bank credit, confirms it. Goes through the same pipeline as every other payment.
  app.post("/v1/orders/:id/mark-paid", async (req, reply) => {
    if (!dashboardOnly(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ utr: z.string().regex(/^[A-Za-z0-9]{6,30}$/).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const order = await getOrder(req.auth, id);
    if (!order) return reply.code(404).send({ error: { code: "not_found" } });
    if (order.provider !== "direct" && order.provider !== "sandbox") return reply.code(409).send({ error: { code: "confirmed_automatically" } });

    await recordProviderPayment(order.id, "manual", {
      providerPaymentId: body.data.utr ? `utr_${body.data.utr.toUpperCase()}` : `man_${randomBytes(9).toString("base64url")}`,
      amountPaise: Number(order.amount_paise), currency: order.currency, status: "captured", paidAt: new Date(),
      rrn: body.data.utr ?? null, raw: { confirmed_by: "merchant" },
    }, "merchant_manual");
    await pool.query("INSERT INTO audit_logs (merchant_id, action, detail, ip) VALUES ($1,'order.marked_paid',$2,$3)",
      [req.auth.merchantId, JSON.stringify({ order_id: order.id, utr: body.data.utr ?? null }), req.ip]);

    const after = await getOrder(req.auth, id);
    return after.status === "paid" ? serializeOrder(after)
      : reply.code(409).send({ error: { code: "could_not_mark_paid", status: after.status } });
  });

  app.get("/v1/orders", async (req) => {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().optional(),
      status: z.enum(["created", "pending", "paid", "expired", "failed"]).optional(),
    }).parse(req.query);
    const { data, next_cursor } = await listOrders(req.auth, q.limit, q.cursor, q.status);
    return { data: data.map(serializeOrder), next_cursor };
  });
}
