import { pool } from "./db.js";
import { decrypt } from "./crypto.js";
import { getVerifier } from "./verifiers/index.js";
import { ProviderAuthError } from "./verifiers/types.js";
import { recordProviderPayment } from "./settlement.js";

/**
 * Next-check schedule (a lease is taken first, so crashed workers just get retried):
 *  - while the order is open: every 5s, 10s, then 15s
 *  - after expiry: every 2 min for a 15 min grace period, to catch in-flight/late payments
 *  - then stop (webhooks can still wake an order up)
 */
const SCHEDULE_SQL = `
  UPDATE orders SET check_count = check_count + 1, next_check_at = CASE
    WHEN status = 'paid' THEN NULL
    WHEN expires_at > now() THEN now() + interval '5 seconds' * LEAST(check_count + 1, 3)
    WHEN now() < expires_at + interval '15 minutes' THEN now() + interval '2 minutes'
    ELSE NULL END
  WHERE id = $1`;

const RETRY_SQL = `
  UPDATE orders SET check_count = check_count + 1, next_check_at = CASE
    WHEN status = 'paid' THEN NULL
    WHEN now() < expires_at + interval '15 minutes' THEN now() + interval '1 minute'
    ELSE NULL END
  WHERE id = $1`;

/** Check one order against its provider. Throttled: only runs if the order is due. */
export async function checkOrder(orderId: string, log?: { error: (...a: any[]) => void }): Promise<void> {
  const { rows } = await pool.query(
    `UPDATE orders SET next_check_at = now() + interval '30 seconds'
      WHERE id=$1 AND next_check_at IS NOT NULL AND next_check_at <= now() AND provider NOT IN ('direct','sandbox')
      RETURNING *, (expires_at < now()) AS past_expiry`, [orderId]);
  const o = rows[0];
  if (!o) return;

  const conn = (await pool.query("SELECT * FROM provider_connections WHERE id=$1", [o.connection_id])).rows[0];
  if (!conn || conn.status === "disabled") {
    await pool.query("UPDATE orders SET next_check_at=NULL WHERE id=$1", [o.id]);
    return;
  }

  try {
    const verifier = getVerifier(o.provider);
    const creds = JSON.parse(decrypt(conn.credentials_enc));

    // Our deadline passed: stop customers paying a dead order by closing the provider QR.
    if (o.past_expiry && o.status !== "paid" && !o.provider_closed && verifier.close) {
      await verifier.close(creds, o.provider_ref).catch(() => {}); // already closed is fine
      await pool.query("UPDATE orders SET provider_closed=true WHERE id=$1", [o.id]);
    }

    for (const p of await verifier.fetchPayments(creds, o.provider_ref))
      await recordProviderPayment(o.id, o.provider, p, "poll");

    await pool.query(SCHEDULE_SQL, [o.id]);
  } catch (e) {
    if (e instanceof ProviderAuthError)
      await pool.query("UPDATE provider_connections SET status='invalid' WHERE id=$1", [conn.id]);
    log?.error({ err: e, orderId: o.id }, "reconcile check failed");
    await pool.query(RETRY_SQL, [o.id]);
  }
}

export async function runReconcileOnce(log?: { error: (...a: any[]) => void }): Promise<number> {
  const { rows } = await pool.query(
    "SELECT id FROM orders WHERE next_check_at IS NOT NULL AND next_check_at <= now() ORDER BY next_check_at LIMIT 100");
  for (let i = 0; i < rows.length; i += 5)
    await Promise.all(rows.slice(i, i + 5).map((r) => checkOrder(r.id, log)));
  return rows.length;
}

export function startReconciler(log: { error: (...a: any[]) => void }) {
  let running = false;
  return setInterval(async () => {
    if (running) return; // never overlap runs
    running = true;
    try { await runReconcileOnce(log); } catch (e) { log.error(e); } finally { running = false; }
  }, 5_000);
}
