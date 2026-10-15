export interface ProviderCredentials { keyId: string; keySecret: string; mode?: "test" | "live"; clientId?: string }

export interface ProviderPayment {
  providerPaymentId: string;
  amountPaise: number;
  currency: string;
  status: "captured" | "failed" | "refunded" | "pending";
  paidAt?: Date;
  payerVpa?: string | null;
  rrn?: string | null;
  raw: unknown;
}

export interface PreparedPayment { providerRef: string; upiUri: string }

/**
 * One adapter per provider. The rest of the system only talks to this interface,
 * so adding a bank API later means adding one file, not touching orders/checkout.
 */
export interface PaymentVerifier {
  readonly id: string;
  /** Longest an order may stay payable when the provider's own QR/link dies sooner (e.g. Paytm: 10 minutes). */
  readonly maxExpirySeconds?: number;
  validateCredentials(c: ProviderCredentials): Promise<void>;
  /** Ask the provider for something the customer can pay (e.g. a single-use fixed-amount QR). */
  prepare(c: ProviderCredentials, o: { id: string; amountPaise: number; expiresAt: Date; reference?: string }): Promise<PreparedPayment>;
  /** Source of truth: what money has the provider actually received for this order? */
  fetchPayments(c: ProviderCredentials, providerRef: string): Promise<ProviderPayment[]>;
  close?(c: ProviderCredentials, providerRef: string): Promise<void>;
  verifyWebhook?(rawBody: Buffer, signature: string | undefined, secret: string): boolean;
  extractProviderRef?(payload: any): string | null;
}

export class ProviderAuthError extends Error {}       // bad/revoked credentials
export class ProviderTransientError extends Error {}  // network, 429, 5xx: retry later
export class ProviderRequestError extends Error {}    // provider rejected the request
