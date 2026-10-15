import {
  ProviderAuthError, ProviderRequestError, ProviderTransientError,
  type PaymentVerifier, type ProviderCredentials, type ProviderPayment,
} from "./types.js";

/**
 * Paytm (Paytm Payments / "Paytm for Business") adapter, using the merchant's OWN MID + merchant key.
 *   credentials.keyId     = MID
 *   credentials.keySecret = merchant key (signs every request)
 * Flow: Dynamic QR API creates a per-order UPI QR; the Transaction Status API (by orderId) tells us if it was paid.
 * Hosts/paths are overridable by env because Paytm has moved its API domains before. CONFIRM them in your Paytm dashboard.
 */
const HOST = (mode: string | undefined) =>
  mode === "live"
    ? process.env.PAYTM_LIVE_BASE_URL ?? "https://securegw.paytmpayments.in"
    : process.env.PAYTM_TEST_BASE_URL ?? "https://securegw-stage.paytmpayments.in";
const QR_PATH = "/paymentservices/qr/create";
const STATUS_PATH = "/v3/order/status";

export type Signer = (bodyJson: string, merchantKey: string) => Promise<string>;

/** Paytm's official checksum library does the signing (loaded lazily so the rest of the app never depends on it). */
const officialSigner: Signer = async (body, key) => {
  const name = "paytmchecksum";
  const m: any = await import(name);
  return (m.default ?? m).generateSignature(body, key);
};

export function createPaytm(signer: Signer = officialSigner): PaymentVerifier {
  async function call(c: ProviderCredentials, path: string, body: object): Promise<any> {
    const bodyJson = JSON.stringify(body);
    const signature = await signer(bodyJson, c.keySecret);
    // The signed string and the sent string must be byte-identical, so embed bodyJson as-is.
    const payload = `{"body":${bodyJson},"head":${JSON.stringify({ clientId: c.clientId ?? "C11", version: "v1", signature })}}`;
    let res: Response;
    try {
      res = await fetch(HOST(c.mode) + path, {
        method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(10_000),
      });
    } catch (e) { throw new ProviderTransientError(`paytm unreachable: ${(e as Error).message}`); }
    if (res.status === 401 || res.status === 403) throw new ProviderAuthError("paytm rejected the request (check MID and merchant key)");
    if (res.status === 429 || res.status >= 500) throw new ProviderTransientError(`paytm ${res.status}`);
    const json: any = await res.json().catch(() => null);
    if (!json?.body) throw new ProviderRequestError(`paytm returned an unreadable response (HTTP ${res.status})`);
    return json.body;
  }

  const fail = (r: any) => new ProviderRequestError(`paytm: ${r?.resultInfo?.resultCode ?? "?"} ${r?.resultInfo?.resultMsg ?? "unknown error"}`);
  const statusBody = (c: ProviderCredentials, orderId: string) => call(c, STATUS_PATH, { mid: c.keyId, orderId });

  return {
    id: "paytm",
    maxExpirySeconds: 600, // Paytm's default QR life is 10 minutes; longer needs Paytm's approval, so orders never outlive the QR

    async validateCredentials(c) {
      // Ask about an order that cannot exist: valid credentials answer "No Record Found" (331); bad ones are rejected.
      const r = await statusBody(c, `GWCHECK${Date.now()}`);
      const code = String(r?.resultInfo?.resultCode ?? "");
      if (code === "331") return;
      const msg = String(r?.resultInfo?.resultMsg ?? "");
      if (code === "335" || code === "2005" || /checksum|mid is invalid/i.test(msg)) throw new ProviderAuthError(msg || "invalid MID or key");
      throw fail(r);
    },

    async prepare(c, o) {
      const r = await call(c, QR_PATH, {
        mid: c.keyId, orderId: o.id, amount: (o.amountPaise / 100).toFixed(2),
        businessType: "UPI_QR_CODE", posId: o.id.slice(0, 50), imageRequired: false,
      });
      if (r?.resultInfo?.resultStatus !== "SUCCESS") throw fail(r);
      // Fail closed: only ever hand a customer a plain UPI link.
      if (typeof r.qrData !== "string" || !r.qrData.startsWith("upi://"))
        throw new ProviderRequestError("paytm returned a QR payload that is not a upi:// link; send this response to the developer");
      return { providerRef: o.id, upiUri: r.qrData }; // status is queried by our order id
    },

    async fetchPayments(c, ref) {
      const r = await statusBody(c, ref);
      if (r?.orderId && r.orderId !== ref) return [];            // never trust an answer about a different order
      if (r?.mid && r.mid !== c.keyId) return [];
      const st = r?.resultInfo?.resultStatus;
      if ((st !== "TXN_SUCCESS" && st !== "TXN_FAILURE") || !r.txnId) return []; // PENDING / NO_RECORD_FOUND: nothing yet
      const amount = Math.round(Number(r.txnAmount) * 100);
      if (!Number.isFinite(amount)) return [];
      const refunded = Number(r.refundAmt ?? 0);
      const date = typeof r.txnDate === "string" ? new Date(r.txnDate.replace(" ", "T") + "+05:30") : undefined; // Paytm dates are IST
      return [{
        providerPaymentId: String(r.txnId), amountPaise: amount, currency: "INR",
        status: st === "TXN_FAILURE" ? "failed" : refunded > 0 && refunded >= Number(r.txnAmount) ? "refunded" : "captured",
        paidAt: date && !Number.isNaN(date.getTime()) ? date : undefined,
        payerVpa: null, rrn: r.rrnCode ?? r.bankTxnId ?? null, raw: r,
      } satisfies ProviderPayment];
    },
  };
}

export const paytm = createPaytm();
