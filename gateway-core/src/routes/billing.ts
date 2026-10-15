import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { pool } from "../db.js";
import { requireSession, requireStepUp } from "../authContext.js";
import { requireAdmin } from "../admin.js";
import { billingSnapshot, ensureSubscription, markInvoicePaid, payLinkForInvoice } from "../billing.js";
import { GSTIN_STATE_RE } from "../gst.js";
import { GSTIN_RE } from "../kycPolicy.js";
import { renderInvoice } from "../invoiceHtml.js";

const serializeInvoice = (r: any) => ({
  id: r.id, number: r.number, plan: r.plan_code, description: r.description, status: r.status,
  subtotal: Number(r.subtotal_paise), cgst: Number(r.cgst_paise), sgst: Number(r.sgst_paise), igst: Number(r.igst_paise), total: Number(r.total_paise),
  due_at: r.due_at, paid_at: r.paid_at, created_at: r.created_at,
});

export async function billingRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply) => { reply.header("cache-control", "no-store"); });

  app.get("/dashboard/billing", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const [snap, plans, inv, prof] = await Promise.all([
      billingSnapshot(a.merchantId),
      pool.query("SELECT code, name, price_paise, monthly_order_limit FROM plans WHERE active ORDER BY price_paise"),
      pool.query("SELECT * FROM invoices WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 12", [a.merchantId]),
      pool.query("SELECT legal_name, gstin, state_code, address FROM billing_profiles WHERE merchant_id=$1", [a.merchantId]),
    ]);
    return { subscription: snap, plans: plans.rows.map((p) => ({ ...p, price_paise: Number(p.price_paise), gst_note: "+18% GST" })),
             invoices: inv.rows.map(serializeInvoice), billing_profile: prof.rows[0] ?? null };
  });

  app.put("/dashboard/billing/profile", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const b = z.object({
      legal_name: z.string().trim().min(2).max(150), gstin: z.string().trim().toUpperCase().regex(GSTIN_RE).optional(),
      state_code: z.string().regex(GSTIN_STATE_RE), address: z.string().trim().max(300).optional(),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: { code: "invalid_request", details: b.error.flatten() } });
    if (b.data.gstin && b.data.gstin.slice(0, 2) !== b.data.state_code)
      return reply.code(422).send({ error: { code: "state_gstin_mismatch", message: "The first two digits of the GSTIN are the state code." } });
    await pool.query(
      `INSERT INTO billing_profiles (merchant_id, legal_name, gstin, state_code, address) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (merchant_id) DO UPDATE SET legal_name=$2, gstin=$3, state_code=$4, address=$5, updated_at=now()`,
      [a.merchantId, b.data.legal_name, b.data.gstin ?? null, b.data.state_code, b.data.address ?? null]);
    return { ok: true, note: "Applies to invoices issued from now on. Issued invoices never change." };
  });

  app.post("/dashboard/billing/plan", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    if (!requireStepUp(req, reply)) return reply;
    const b = z.object({ plan_code: z.string().max(30) }).safeParse(req.body);
    if (!b.success || !(await pool.query("SELECT 1 FROM plans WHERE code=$1 AND active", [b.data.plan_code])).rowCount)
      return reply.code(400).send({ error: { code: "unknown_plan" } });
    const sub = await ensureSubscription(a.merchantId);
    // Trial: switch now. Paid period: the new plan starts at the next invoice (no mid-month refunds to compute).
    if (sub.status === "trialing") await pool.query("UPDATE subscriptions SET plan_code=$2, pending_plan_code=NULL, updated_at=now() WHERE merchant_id=$1", [a.merchantId, b.data.plan_code]);
    else await pool.query("UPDATE subscriptions SET pending_plan_code=$2, updated_at=now() WHERE merchant_id=$1", [a.merchantId, b.data.plan_code === sub.plan_code ? null : b.data.plan_code]);
    return { ok: true, effective: sub.status === "trialing" ? "now" : "next_invoice" };
  });

  for (const [path, flag] of [["cancel", true], ["resume", false]] as const)
    app.post(`/dashboard/billing/${path}`, async (req, reply) => {
      const a = await requireSession(req, reply); if (!a) return reply;
      if (!requireStepUp(req, reply)) return reply;
      await ensureSubscription(a.merchantId);
      await pool.query("UPDATE subscriptions SET cancel_at_period_end=$2, updated_at=now() WHERE merchant_id=$1 AND status IN ('trialing','active','past_due')", [a.merchantId, flag]);
      return { ok: true, cancel_at_period_end: flag };
    });

  app.post("/dashboard/billing/invoices/:id/pay", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const { id } = req.params as { id: string };
    try {
      const url = await payLinkForInvoice(id, a.merchantId);
      return url ? { checkout_url: url } : reply.code(404).send({ error: { code: "not_found_or_not_open" } });
    } catch (e) {
      req.log.error(e);
      return reply.code(503).send({ error: { code: "billing_unavailable", message: "Could not create a payment link. Try again shortly." } });
    }
  });

  app.get("/dashboard/billing/invoices/:id/html", async (req, reply) => {
    const a = await requireSession(req, reply); if (!a) return reply;
    const { id } = req.params as { id: string };
    const inv = (await pool.query("SELECT * FROM invoices WHERE id=$1 AND merchant_id=$2", [id, a.merchantId])).rows[0];
    if (!inv) return reply.code(404).send({ error: { code: "not_found" } });
    const n = randomBytes(16).toString("base64");
    return reply.header("content-security-policy", `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}'; frame-ancestors 'none'`)
      .header("x-content-type-options", "nosniff").type("text/html; charset=utf-8").send(renderInvoice(inv, n));
  });
}

/** Operator tools (x-admin-token) for support cases. */
export async function adminBillingRoutes(app: FastifyInstance) {
  app.post("/admin/invoices/:id/mark-paid", async (req, reply) => { // e.g. a late payment that arrived after the pay-link order expired
    if (!requireAdmin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const ok = await markInvoicePaid(id);
    return ok ? { ok: true } : reply.code(404).send({ error: { code: "not_found_or_not_open" } });
  });

  app.post("/admin/merchants/:id/subscription", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const b = z.object({ action: z.enum(["extend_trial", "suspend", "reinstate"]), days: z.number().int().min(1).max(90).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    await ensureSubscription(id);
    if (b.data.action === "extend_trial")
      await pool.query("UPDATE subscriptions SET status='trialing', trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + ($2 || ' days')::interval, grace_ends_at=NULL, updated_at=now() WHERE merchant_id=$1", [id, String(b.data.days ?? 7)]);
    else if (b.data.action === "suspend") await pool.query("UPDATE subscriptions SET status='suspended', updated_at=now() WHERE merchant_id=$1", [id]);
    else await pool.query("UPDATE subscriptions SET status = CASE WHEN current_period_end > now() THEN 'active' ELSE 'past_due' END, grace_ends_at = now() + interval '2 days', updated_at=now() WHERE merchant_id=$1 AND status IN ('suspended','canceled')", [id]);
    await pool.query("INSERT INTO audit_logs (merchant_id, action, detail, ip) VALUES ($1,'admin.subscription',$2,$3)", [id, JSON.stringify(b.data), req.ip]);
    return { ok: true };
  });
}
