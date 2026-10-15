import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ProviderAuthError, ProviderRequestError, ProviderTransientError,
  type PaymentVerifier, type ProviderCredentials, type ProviderPayment,
} from "./types.js";

const BASE = "https://api.razorpay.com/v1";

async function call(c: ProviderCredentials, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        authorization: "Basic " + Buffer.from(`${c.keyId}:${c.keySecret}`).toString("base64"),
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new ProviderTransientError(`razorpay unreachable: ${(e as Error).message}`);
  }
  if (res.status === 401) throw new ProviderAuthError("razorpay rejected the credentials");
  if (res.status === 429 || res.status >= 500) throw new ProviderTransientError(`razorpay ${res.status}`);
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw new ProviderRequestError(json?.error?.description ?? `razorpay ${res.status}`);
  return json;
}

const mapStatus = (s: string): ProviderPayment["status"] =>
  s === "captured" ? "captured" : s === "refunded" ? "refunded" : s === "failed" ? "failed" : "pending";

export const razorpay: PaymentVerifier = {
  id: "razorpay",

  async validateCredentials(c) {
    await call(c, "GET", "/payments?count=1");
  },

  async prepare(c, o) {
    // Razorpay wants close_by a couple of minutes ahead at minimum; we close the QR ourselves at our expiry.
    const closeBy = Math.max(Math.floor(o.expiresAt.getTime() / 1000), Math.floor(Date.now() / 1000) + 130);
    const qr = await call(c, "POST", "/payments/qr_codes", {
      type: "upi_qr",
      name: `Order ${o.id}`.slice(0, 40),
      usage: "single_use",
      fixed_amount: true,
      payment_amount: o.amountPaise,
      description: (o.reference ?? o.id).slice(0, 100),
      close_by: closeBy,
      notes: { order_id: o.id },
    });
    // Never hand a customer something we haven't sanity-checked.
    if (typeof qr?.id !== "string" || !qr.id.startsWith("qr_") || typeof qr?.image_content !== "string" || !qr.image_content.startsWith("upi://"))
      throw new ProviderRequestError("razorpay returned an unexpected QR response");
    return { providerRef: qr.id, upiUri: qr.image_content };
  },

  async fetchPayments(c, ref) {
    const r = await call(c, "GET", `/payments/qr_codes/${encodeURIComponent(ref)}/payments?count=100`);
    return ((r?.items ?? []) as any[]).map((p): ProviderPayment => ({
      providerPaymentId: String(p.id),
      amountPaise: Number(p.amount),
      currency: String(p.currency ?? "INR"),
      status: mapStatus(String(p.status)),
      paidAt: p.created_at ? new Date(Number(p.created_at) * 1000) : undefined,
      payerVpa: p.vpa ?? null,
      rrn: p.acquirer_data?.rrn ?? null,
      raw: p,
    }));
  },

  async close(c, ref) {
    await call(c, "POST", `/payments/qr_codes/${encodeURIComponent(ref)}/close`);
  },

  verifyWebhook(raw, signature, secret) {
    if (!signature) return false;
    const want = createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(want), b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  },

  extractProviderRef(payload) {
    const id = payload?.payload?.qr_code?.entity?.id;
    return typeof id === "string" ? id : null;
  },
};
