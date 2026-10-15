import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, withTx } from "./db.js";
import { newId, sha256 } from "./ids.js";
import { canTransition, type OrderStatus } from "./orderStateMachine.js";
import type { AuthContext } from "./apiKeys.js";
import { config } from "./config.js";
import { emitEvent } from "./events.js";
import { decrypt } from "./crypto.js";
import { getVerifier } from "./verifiers/index.js";
import type { PreparedPayment, ProviderCredentials } from "./verifiers/types.js";

export interface CreateOrderInput {
  amount: number; // paise
  currency: "INR";
  reference?: string;
  customer?: { name?: string; email?: string; phone?: string };
  metadata?: Record<string, string>;
  expires_in_seconds: number;
}

export class IdempotencyConflict extends Error {}
export class NoPaymentAccount extends Error {}

interface Payee {
  accountId: string | null; vpa: string | null; name: string;
  provider: "direct" | "razorpay" | "paytm" | "sandbox"; connectionId: string | null; credentials: ProviderCredentials | null;
}

/**
 * Where will the customer's money go, and how will we learn it arrived?
 * Provider-backed accounts confirm automatically; raw UPI IDs need the merchant to confirm.
 * Live mode only ever uses verified accounts. Test mode falls back to a sandbox.
 */
async function resolvePayee(auth: AuthContext): Promise<Payee> {
  const { rows } = await pool.query(
    `SELECT a.id, a.type, a.vpa, a.payee_name, a.connection_id, c.credentials_enc
       FROM merchant_accounts a LEFT JOIN provider_connections c ON c.id = a.connection_id
      WHERE a.merchant_id=$1 AND a.status='active' AND (
              (a.type IN ('razorpay','paytm') AND c.status='active' AND c.mode=$2)
           OR (a.type='upi_vpa' AND ($2='test' OR a.verification_status='verified')))
      ORDER BY a.is_default DESC, (a.type <> 'upi_vpa') DESC, a.created_at LIMIT 1`,
    [auth.merchantId, auth.mode]);
  const r = rows[0];
  if (r && r.type !== "upi_vpa")
    return { accountId: r.id, vpa: null, name: r.payee_name, provider: r.type, connectionId: r.connection_id,
             credentials: JSON.parse(decrypt(r.credentials_enc)) };
  if (r) return { accountId: r.id, vpa: r.vpa, name: r.payee_name, provider: "direct", connectionId: null, credentials: null };
  if (auth.mode === "test")
    return { accountId: null, vpa: "sandbox@paygate", name: "Test Merchant", provider: "sandbox", connectionId: null, credentials: null };
  throw new NoPaymentAccount("No verified payment account");
}

export function serializeOrder(r: any) {
  return {
    id: r.id,
    object: "order",
    mode: r.mode,
    amount: Number(r.amount_paise),
    currency: r.currency,
    reference: r.reference,
    status: r.status,
    customer: { name: r.customer_name, email: r.customer_email, phone: r.customer_phone },
    metadata: r.metadata,
    checkout_url: `${config.checkoutBaseUrl}/${r.checkout_token}`,
    payee: { vpa: r.payee_vpa, name: r.payee_name },
    confirmation: r.provider === "sandbox" ? "simulated" : r.provider === "direct" ? "merchant" : "automatic",
    expires_at: r.expires_at,
    paid_at: r.paid_at,
    created_at: r.created_at,
  };
}

export async function createOrder(auth: AuthContext, input: CreateOrderInput, idemKey?: string) {
  const requestHash = sha256(JSON.stringify(input));

  const replay = async (q: { query: (text: string, params?: any[]) => Promise<any> }) => {
    const prev = await q.query("SELECT * FROM orders WHERE merchant_id=$1 AND idempotency_key=$2", [auth.merchantId, idemKey]);
    if (!prev.rows[0]) return null;
    if (prev.rows[0].request_hash !== requestHash)
      throw new IdempotencyConflict("Idempotency-Key was already used with a different request body");
    return { order: prev.rows[0], replayed: true };
  };

  // Check replays BEFORE calling the provider, so a retry never creates a second provider QR.
  if (idemKey) { const r = await replay(pool); if (r) return r; }

  const payee = await resolvePayee(auth);
  const id = newId("ord");
  const verifier = payee.provider === "direct" || payee.provider === "sandbox" ? null : getVerifier(payee.provider);
  // An order must never outlive the provider's own QR/link (Paytm's lives 10 minutes), so clamp to what the provider supports.
  const expirySeconds = Math.min(input.expires_in_seconds, verifier?.maxExpirySeconds ?? Infinity);
  let prepared: PreparedPayment | null = null;
  if (verifier) {
    prepared = await verifier.prepare(payee.credentials!, {
      id, amountPaise: input.amount, expiresAt: new Date(Date.now() + expirySeconds * 1000), reference: input.reference,
    });
  }
  const orphanCleanup = () => {
    if (prepared && payee.credentials) verifier?.close?.(payee.credentials, prepared.providerRef).catch(() => {});
  };

  try {
    return await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO orders
           (id, merchant_id, mode, amount_paise, currency, reference,
            customer_name, customer_email, customer_phone, metadata,
            checkout_token, expires_at, idempotency_key, request_hash,
            merchant_account_id, payee_vpa, payee_name, provider, provider_ref, provider_upi_uri, connection_id, next_check_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + ($12 || ' seconds')::interval, $13,$14,$15,$16,$17,$18,$19,$20,$21,
                 CASE WHEN $19::text IS NULL THEN NULL ELSE now() + interval '3 seconds' END)
         ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [id, auth.merchantId, auth.mode, input.amount, input.currency, input.reference ?? null,
         input.customer?.name ?? null, input.customer?.email ?? null, input.customer?.phone ?? null,
         JSON.stringify(input.metadata ?? {}), randomBytes(18).toString("base64url"), String(expirySeconds),
         idemKey ?? null, requestHash, payee.accountId, payee.vpa, payee.name, payee.provider,
         prepared?.providerRef ?? null, prepared?.upiUri ?? null, payee.connectionId]);

      if (rows[0]) {
        await c.query("INSERT INTO order_events (order_id, from_status, to_status) VALUES ($1,NULL,'created')", [id]);
        return { order: rows[0], replayed: false };
      }
      orphanCleanup(); // lost a race with an identical request
      return (await replay(c))!;
    });
  } catch (e) {
    orphanCleanup();
    throw e;
  }
}

export async function getOrder(auth: AuthContext, id: string) {
  const { rows } = await pool.query(
    "SELECT * FROM orders WHERE id=$1 AND merchant_id=$2 AND mode=$3", [id, auth.merchantId, auth.mode]
  );
  return rows[0] ?? null;
}

export async function listOrders(auth: AuthContext, limit: number, cursor?: string, status?: string) {
  const params: unknown[] = [auth.merchantId, auth.mode];
  let where = "merchant_id=$1 AND mode=$2";
  if (status) { params.push(status); where += ` AND status=$${params.length}`; }
  if (cursor) {
    params.push(cursor);
    where += ` AND (created_at, id) < (SELECT created_at, id FROM orders WHERE id=$${params.length} AND merchant_id=$1)`;
  }
  params.push(limit + 1);
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { data: page, next_cursor: hasMore ? page[page.length - 1].id : null };
}

/**
 * The ONLY way an order's status should change. Guarded UPDATE so two
 * concurrent writers (e.g. webhook + reconciliation job) can't both win.
 * Returns the updated row, or null if the order wasn't in `from`.
 */
export async function transitionOrder(
  c: Pick<PoolClient, "query">, orderId: string, from: OrderStatus, to: OrderStatus, reason?: string
) {
  if (!canTransition(from, to)) throw new Error(`Illegal transition ${from} -> ${to}`);
  const { rows } = await c.query(
    `UPDATE orders SET status=$3, updated_at=now(), paid_at = CASE WHEN $3='paid' THEN now() ELSE paid_at END
      WHERE id=$1 AND status=$2 RETURNING *`,
    [orderId, from, to]
  );
  if (!rows[0]) return null;
  await c.query("INSERT INTO order_events (order_id, from_status, to_status, reason) VALUES ($1,$2,$3,$4)",
    [orderId, from, to, reason ?? null]);
  return rows[0];
}

/** Expire an order and emit `order.expired` in the same transaction. Every expiry path must use this. */
export async function expireOrder(c: Pick<PoolClient, "query">, orderId: string, from: OrderStatus) {
  const row = await transitionOrder(c, orderId, from, "expired", "deadline passed");
  if (row) await emitEvent(c, row, "order.expired", {
    order_id: row.id, reference: row.reference, amount: Number(row.amount_paise), currency: row.currency });
  return row;
}

/** Expires open orders past their deadline. Safe to run on an interval. */
export async function expireStaleOrders(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT id, status FROM orders WHERE status IN ('created','pending') AND expires_at < now() LIMIT 500"
  );
  let n = 0;
  for (const r of rows) {
    if (await withTx((c) => expireOrder(c, r.id, r.status))) n++;
  }
  return n;
}
