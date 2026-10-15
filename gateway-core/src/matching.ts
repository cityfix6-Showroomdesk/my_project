/**
 * The one place that decides what a reported payment means for an order.
 * Pure function: no I/O, fully unit-tested. Money rules live here.
 */
export type MatchOutcome = "matched" | "duplicate_payment" | "late" | "amount_mismatch" | "not_captured";

export function decideOutcome(
  order: { status: string; amount_paise: number | string; currency: string },
  pay: { status: string; amountPaise: number; currency: string }
): MatchOutcome {
  if (pay.status !== "captured") return "not_captured";
  if (pay.currency !== order.currency || pay.amountPaise !== Number(order.amount_paise)) return "amount_mismatch";
  if (order.status === "paid") return "duplicate_payment"; // customer paid twice: merchant should refund one
  if (order.status === "created" || order.status === "pending") return "matched";
  return "late"; // expired/failed order but money arrived: flag for the merchant, never auto-complete
}

export const isFlagged = (o: MatchOutcome) => o !== "matched" && o !== "not_captured";
