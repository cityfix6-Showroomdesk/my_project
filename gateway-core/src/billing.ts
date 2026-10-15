import { pool, withTx } from "./db.js";
import { newId } from "./ids.js";
import { config } from "./config.js";
import { sendMail } from "./mailer.js";
import { createOrder } from "./orderService.js";
import { addMonths, computeTax, financialYear, formatInvoiceNumber, SAC_CODE } from "./gst.js";
import { DUE_DAYS, GRACE_DAYS, entitlement, planTransition } from "./billingPolicy.js";

const isPlatform = (merchantId: string) => merchantId === config.platformMerchantId;

export async function ensureSubscription(merchantId: string) {
  await pool.query("INSERT INTO subscriptions (merchant_id, status, trial_ends_at) VALUES ($1,'trialing', now() + ($2 || ' days')::interval) ON CONFLICT DO NOTHING",
    [merchantId, String(config.trialDays)]);
  return (await pool.query(
    "SELECT s.*, p.name AS plan_name, p.price_paise, p.monthly_order_limit FROM subscriptions s JOIN plans p ON p.code=s.plan_code WHERE s.merchant_id=$1", [merchantId])).rows[0];
}

/** Live orders created in the current billing window. */
export async function usage(merchantId: string, sub: any): Promise<number> {
  const since = sub.current_period_start ?? sub.created_at;
  return (await pool.query("SELECT count(*)::int n FROM orders WHERE merchant_id=$1 AND mode='live' AND created_at >= $2", [merchantId, since])).rows[0].n;
}

/** Called by POST /v1/orders (Module 1). Test mode and the platform's own account are never gated. */
export async function checkOrderEntitlement(merchantId: string, mode: string) {
  if (mode !== "live" || isPlatform(merchantId)) return null;
  const sub = await ensureSubscription(merchantId);
  return entitlement(sub.status, await usage(merchantId, sub), sub.monthly_order_limit);
}

export async function billingSnapshot(merchantId: string) {
  const sub = await ensureSubscription(merchantId);
  return { status: sub.status, plan: sub.plan_code, trial_ends_at: sub.trial_ends_at, current_period_end: sub.current_period_end,
           grace_ends_at: sub.grace_ends_at, cancel_at_period_end: sub.cancel_at_period_end,
           live_orders_used: await usage(merchantId, sub), live_order_limit: sub.monthly_order_limit };
}

const supplier = () => ({ name: config.platformLegalName, gstin: config.platformGstin, address: config.platformAddress, state_code: config.platformStateCode, sac: SAC_CODE });

async function generateInvoice(merchantId: string): Promise<void> {
  const email = await withTx(async (c) => {
    const sub = (await c.query("SELECT * FROM subscriptions WHERE merchant_id=$1 FOR UPDATE", [merchantId])).rows[0]; // serialises concurrent workers
    if (!sub || !["trialing", "active"].includes(sub.status)) return null;
    const start: Date = sub.status === "trialing" ? sub.trial_ends_at : sub.current_period_end;
    if ((await c.query("SELECT 1 FROM invoices WHERE merchant_id=$1 AND period_start=$2", [merchantId, start])).rowCount) return null;

    const planCode = sub.pending_plan_code ?? sub.plan_code;
    const plan = (await c.query("SELECT * FROM plans WHERE code=$1", [planCode])).rows[0];
    const m = (await c.query("SELECT email, business_name FROM merchants WHERE id=$1", [merchantId])).rows[0];
    const prof = (await c.query("SELECT * FROM billing_profiles WHERE merchant_id=$1", [merchantId])).rows[0];
    const customer = { name: prof?.legal_name ?? m.business_name, gstin: prof?.gstin ?? null, state_code: prof?.state_code ?? config.platformStateCode, address: prof?.address ?? null };
    const tax = computeTax(Number(plan.price_paise), config.platformStateCode, customer.state_code);

    const fy = financialYear(new Date());
    const n = (await c.query("INSERT INTO invoice_counters (fy, last) VALUES ($1,1) ON CONFLICT (fy) DO UPDATE SET last = invoice_counters.last + 1 RETURNING last", [fy])).rows[0].last;
    const end = addMonths(start, 1);
    await c.query(
      `INSERT INTO invoices (id, merchant_id, number, plan_code, description, period_start, period_end, subtotal_paise, cgst_paise, sgst_paise, igst_paise,
                             total_paise, due_at, supplier, customer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + ($13 || ' days')::interval,$14,$15)`,
      [newId("inv"), merchantId, formatInvoiceNumber(fy, n), plan.code, `${plan.name} plan, ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
       start, end, plan.price_paise, tax.cgst, tax.sgst, tax.igst, tax.total, String(DUE_DAYS), JSON.stringify(supplier()), JSON.stringify(customer)]);
    await c.query("UPDATE subscriptions SET status='past_due', grace_ends_at = now() + ($2 || ' days')::interval, updated_at=now() WHERE merchant_id=$1", [merchantId, String(DUE_DAYS + GRACE_DAYS)]);
    return m.email as string;
  });
  if (email) await sendMail({ to: email, subject: "Your invoice is ready",
    text: `A new invoice is ready. Pay it within ${DUE_DAYS} days to keep live payments running:\n${config.publicBaseUrl}/dashboard/#/billing` });
}

/** An invoice paid (via its order, or by an operator) renews the subscription. Idempotent. */
export async function markInvoicePaid(invoiceId: string): Promise<boolean> {
  const out = await withTx(async (c) => {
    const inv = (await c.query("UPDATE invoices SET status='paid', paid_at=now() WHERE id=$1 AND status='open' RETURNING *", [invoiceId])).rows[0];
    if (!inv) return null;
    const stale = new Date(inv.period_start).getTime() + 7 * 86400_000 < Date.now(); // paid very late: restart the period from now
    const start = stale ? new Date() : new Date(inv.period_start), end = stale ? addMonths(start, 1) : new Date(inv.period_end);
    await c.query(
      `UPDATE subscriptions SET status='active', plan_code=$2, pending_plan_code=NULL, current_period_start=$3, current_period_end=$4,
              grace_ends_at=NULL, updated_at=now() WHERE merchant_id=$1`, [inv.merchant_id, inv.plan_code, start, end]);
    await c.query("INSERT INTO audit_logs (merchant_id, action, detail) VALUES ($1,'invoice.paid',$2)", [inv.merchant_id, JSON.stringify({ invoice: inv.number })]);
    return (await c.query("SELECT email FROM merchants WHERE id=$1", [inv.merchant_id])).rows[0].email as string;
  });
  if (out) await sendMail({ to: out, subject: "Payment received, thank you", text: "We received your payment and your subscription is active." });
  return !!out;
}

/** Pay link for an invoice: a normal order on the PLATFORM's own merchant account, so the whole M1-M4 pipeline does the work. */
export async function payLinkForInvoice(invoiceId: string, merchantId: string): Promise<string | null> {
  const inv = (await pool.query("SELECT * FROM invoices WHERE id=$1 AND merchant_id=$2 AND status='open'", [invoiceId, merchantId])).rows[0];
  if (!inv) return null;
  const open = (await pool.query(
    `SELECT o.checkout_token FROM invoice_orders io JOIN orders o ON o.id=io.order_id
      WHERE io.invoice_id=$1 AND o.status IN ('created','pending') AND o.expires_at > now() + interval '10 minutes' ORDER BY o.created_at DESC LIMIT 1`, [invoiceId])).rows[0];
  if (open) return `${config.checkoutBaseUrl}/${open.checkout_token}`;
  const { order } = await createOrder(
    { merchantId: config.platformMerchantId, mode: config.billingMode, kycStatus: "approved", via: "api_key" },
    { amount: Number(inv.total_paise), currency: "INR", reference: inv.number, metadata: { invoice_id: inv.id }, expires_in_seconds: 86_400 });
  await pool.query("INSERT INTO invoice_orders (invoice_id, order_id) VALUES ($1,$2)", [invoiceId, order.id]);
  return `${config.checkoutBaseUrl}/${order.checkout_token}`;
}

export async function runBillingOnce(log?: { error: (...a: any[]) => void }): Promise<void> {
  // 1) invoices whose payment order has been paid
  for (const r of (await pool.query(
    `SELECT DISTINCT i.id FROM invoices i JOIN invoice_orders io ON io.invoice_id=i.id JOIN orders o ON o.id=io.order_id
      WHERE i.status='open' AND o.status='paid'`)).rows) await markInvoicePaid(r.id).catch((e) => log?.error(e));

  // 2) subscriptions that need a state change
  const due = await pool.query(
    `SELECT s.*, EXISTS (SELECT 1 FROM invoices i WHERE i.merchant_id=s.merchant_id AND i.status='open') AS has_open, m.email
       FROM subscriptions s JOIN merchants m ON m.id=s.merchant_id
      WHERE s.merchant_id <> $1 AND ((s.status='trialing' AND s.trial_ends_at <= now()) OR (s.status='active' AND s.current_period_end <= now())
         OR (s.status='past_due' AND s.grace_ends_at < now())) LIMIT 200`, [config.platformMerchantId ?? ""]);
  for (const s of due.rows) {
    try {
      const a = planTransition(s, new Date(), s.has_open);
      if (a === "generate_invoice") await generateInvoice(s.merchant_id);
      else if (a === "suspend") {
        await pool.query("UPDATE subscriptions SET status='suspended', updated_at=now() WHERE merchant_id=$1 AND status='past_due'", [s.merchant_id]);
        await sendMail({ to: s.email, subject: "Live payments paused", text: `Your invoice is unpaid, so new live orders are paused. Existing payments still complete. Pay here to resume:\n${config.publicBaseUrl}/dashboard/#/billing` });
      } else if (a === "cancel") await pool.query("UPDATE subscriptions SET status='canceled', updated_at=now() WHERE merchant_id=$1", [s.merchant_id]);
    } catch (e) { log?.error({ err: e, merchant: s.merchant_id }, "billing step failed"); }
  }
}

export function startBillingWorker(log: { error: (...a: any[]) => void }) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try { await runBillingOnce(log); } catch (e) { log.error(e); } finally { running = false; }
  }, 60_000);
}
