import { withTx } from "./db.js";
import { newId } from "./ids.js";
import { emitEvent } from "./events.js";
import { transitionOrder } from "./orderService.js";
import { decideOutcome, isFlagged, type MatchOutcome } from "./matching.js";
import type { ProviderPayment } from "./verifiers/types.js";

export type SettleResult = { outcome: MatchOutcome | "already_recorded" | "unknown_order" };

/**
 * EVERY way a payment can enter the system (poll, webhook, simulate, manual) ends up here.
 * One transaction: lock order -> record payment -> maybe mark paid -> write outbox event.
 * Safe to call repeatedly with the same payment.
 */
export async function recordProviderPayment(
  orderId: string, provider: string, pay: ProviderPayment, source: string
): Promise<SettleResult> {
  return withTx(async (c) => {
    const o = (await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId])).rows[0];
    if (!o) return { outcome: "unknown_order" as const };

    const existing = (await c.query(
      "SELECT id, status FROM payments WHERE provider=$1 AND provider_payment_id=$2 FOR UPDATE",
      [provider, pay.providerPaymentId])).rows[0];
    // Already counted, or nothing new to learn.
    if (existing && (existing.status === "captured" || pay.status !== "captured")) return { outcome: "already_recorded" as const };

    const outcome = decideOutcome(o, pay);
    const params = [pay.status, outcome, pay.payerVpa ?? null, pay.rrn ?? null, pay.paidAt ?? null, JSON.stringify(pay.raw ?? null)];
    let paymentId: string;
    if (existing) {
      paymentId = existing.id;
      await c.query(
        "UPDATE payments SET status=$2, match_status=$3, payer_vpa=$4, rrn=$5, paid_at=$6, raw=$7 WHERE id=$1",
        [paymentId, ...params]);
    } else {
      paymentId = newId("pay");
      await c.query(
        `INSERT INTO payments (id, order_id, merchant_id, mode, provider, provider_payment_id, amount_paise, currency,
                               status, match_status, payer_vpa, rrn, paid_at, raw, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [paymentId, o.id, o.merchant_id, o.mode, provider, pay.providerPaymentId, pay.amountPaise, pay.currency,
         ...params, source]);
    }

    const info = {
      order_id: o.id, reference: o.reference, amount: Number(o.amount_paise), currency: o.currency,
      payment_id: paymentId, provider_payment_id: pay.providerPaymentId, rrn: pay.rrn ?? null,
    };
    if (outcome === "matched") {
      await transitionOrder(c, o.id, o.status, "paid", `payment ${pay.providerPaymentId} via ${source}`);
      await c.query("UPDATE orders SET next_check_at=NULL WHERE id=$1", [o.id]);
      await emitEvent(c, o, "order.paid", info);
    } else if (isFlagged(outcome)) {
      await emitEvent(c, o, "payment.flagged", { ...info, reason: outcome, received_amount: pay.amountPaise });
    }
    return { outcome };
  });
}
