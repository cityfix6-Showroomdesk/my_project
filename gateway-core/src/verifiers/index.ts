import type { PaymentVerifier } from "./types.js";
import { razorpay } from "./razorpay.js";
import { paytm } from "./paytm.js";

const registry: Record<string, PaymentVerifier> = { razorpay, paytm };

export function getVerifier(id: string): PaymentVerifier {
  const v = registry[id];
  if (!v) throw new Error(`No verifier for provider "${id}"`);
  return v;
}
