export const DUE_DAYS = 5;    // invoice due this long after it is issued
export const GRACE_DAYS = 2;  // service continues this long after the due date, then suspends

export type SubState = {
  status: string; trial_ends_at: Date | null; current_period_end: Date | null;
  grace_ends_at: Date | null; cancel_at_period_end: boolean;
};
export type Action = "generate_invoice" | "suspend" | "cancel" | "none";

/** What should happen to this subscription right now? Pure, so every edge is tested. */
export function planTransition(s: SubState, now: Date, hasOpenInvoice: boolean): Action {
  if (s.status === "trialing" && s.trial_ends_at && now >= s.trial_ends_at)
    return s.cancel_at_period_end ? "cancel" : hasOpenInvoice ? "none" : "generate_invoice";
  if (s.status === "active" && s.current_period_end && now >= s.current_period_end)
    return s.cancel_at_period_end ? "cancel" : hasOpenInvoice ? "none" : "generate_invoice";
  if (s.status === "past_due" && s.grace_ends_at && now > s.grace_ends_at) return "suspend";
  return "none";
}

/** Only LIVE order creation is gated. Existing orders, payment detection and webhooks always keep working. */
export function entitlement(
  status: string, used: number, limit: number
): null | { code: "subscription_inactive" | "plan_limit_reached"; message: string } {
  if (status === "suspended" || status === "canceled")
    return { code: "subscription_inactive", message: "Your subscription is not active. Pay your open invoice in the dashboard to resume live orders." };
  if (used >= limit) return { code: "plan_limit_reached", message: `Monthly live order limit (${limit}) reached. Upgrade your plan in the dashboard.` };
  return null;
}
