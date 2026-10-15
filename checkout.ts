import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { pool, withTx } from "../db.js";
import { transitionOrder, expireOrder } from "../orderService.js";
import { recordProviderPayment } from "../settlement.js";
import { checkOrder } from "../reconciler.js";
import { buildUpiUri, upiAppLinks } from "../upi.js";
import { renderCheckout, renderMessage } from "../checkoutPage.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;
const OPEN = new Set(["created", "pending"]);

async function load(token: string) {
  const { rows } = await pool.query(
    `SELECT o.*, m.business_name,
            (o.expires_at < now()) AS is_expired,
            GREATEST(0, EXTRACT(EPOCH FROM (o.expires_at - now())))::int AS seconds_left
       FROM orders o JOIN merchants m ON m.id = o.merchant_id
      WHERE o.checkout_token = $1`, [token]);
  return rows[0];
}

/** Lazily applies expiry (and created -> pending on first open) so the page is always truthful. */
async function fresh(token: string, markOpened: boolean) {
  let o = await load(token);
  if (!o) return null;
  if (OPEN.has(o.status) && o.is_expired) {
    await withTx((c) => expireOrder(c, o.id, o.status));
    o = await load(token);
  } else if (markOpened && o.status === "created") {
    await withTx((c) => transitionOrder(c, o.id, "created", "pending", "checkout opened"));
    o = await load(token);
  }
  return o;
}

function secure(reply: FastifyReply, nonce?: string) {
  reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff").header("X-Frame-Options", "DENY");
  if (nonce)
    reply.header("Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
}

export async function checkoutRoutes(app: FastifyInstance) {
  app.get("/pay/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    secure(reply);
    if (!TOKEN_RE.test(token)) return reply.code(404).type("text/html").send(renderMessage("Not found", "This payment link is invalid."));
    const o = await fresh(token, true);
    if (!o) return reply.code(404).type("text/html").send(renderMessage("Not found", "This payment link is invalid."));

    const status = (o.status === "created" ? "pending" : o.status) as "pending" | "paid" | "expired" | "failed";
    const upiUri = o.provider_upi_uri ?? buildUpiUri({ vpa: o.payee_vpa, payeeName: o.payee_name, amountPaise: Number(o.amount_paise), orderId: o.id });
    const qrSvg = status === "pending"
      ? await QRCode.toString(upiUri, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#111111", light: "#ffffff" } })
      : "";

    const nonce = randomBytes(16).toString("base64");
    secure(reply, nonce);
    return reply.type("text/html; charset=utf-8").send(renderCheckout({
      token, businessName: o.business_name, amountPaise: Number(o.amount_paise), status,
      secondsLeft: o.seconds_left, qrSvg, upiUri, apps: upiAppLinks(upiUri), autoConfirm: o.provider !== "direct", testMode: o.mode === "test",
    }, nonce));
  });

  app.get("/pay/:token/status", async (req, reply) => {
    const { token } = req.params as { token: string };
    secure(reply);
    if (!TOKEN_RE.test(token)) return reply.code(404).send({ error: { code: "not_found" } });
    const o = await fresh(token, false);
    if (!o) return reply.code(404).send({ error: { code: "not_found" } });
    // Each page poll doubles as a throttled "has the money arrived?" check, so the customer sees
    // success within seconds even before a webhook or the background worker gets to it.
    let cur = o;
    if (cur.provider !== "direct" && cur.provider !== "sandbox" && OPEN.has(cur.status)) {
      await checkOrder(cur.id, req.log).catch(() => {});
      cur = (await fresh(token, false)) ?? cur;
    }
    return { status: cur.status, seconds_left: cur.seconds_left };
  });

  // Test-mode only: lets you walk the whole flow without a real payment.
  app.post("/pay/:token/simulate", async (req, reply) => {
    const { token } = req.params as { token: string };
    secure(reply);
    if (!TOKEN_RE.test(token)) return reply.code(404).send({ error: { code: "not_found" } });
    const o = await fresh(token, false);
    if (!o) return reply.code(404).send({ error: { code: "not_found" } });
    if (o.mode !== "test") return reply.code(403).send({ error: { code: "test_mode_only" } });
    if (!OPEN.has(o.status)) return reply.code(409).send({ error: { code: "order_not_open", status: o.status } });
    await recordProviderPayment(o.id, "sandbox", {
      providerPaymentId: `sbx_${randomBytes(9).toString("base64url")}`, amountPaise: Number(o.amount_paise),
      currency: o.currency, status: "captured", paidAt: new Date(), raw: { simulated: true },
    }, "simulate");
    return { status: "paid" };
  });
}
