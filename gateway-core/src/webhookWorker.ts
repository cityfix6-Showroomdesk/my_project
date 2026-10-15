import { pool, withTx } from "./db.js";
import { decrypt } from "./crypto.js";
import { config } from "./config.js";
import { buildPayload } from "./events.js";
import { signPayload } from "./webhookSign.js";
import { postJson } from "./safeHttp.js";
import { ENDPOINT_DISABLE_AFTER, nextAttemptDelay } from "./webhookPolicy.js";

type Log = { error: (...a: any[]) => void };

/**
 * Step 1: events -> deliveries. One delivery per (event, subscribed endpoint of the same merchant AND mode).
 * SKIP LOCKED lets several server instances run this safely; UNIQUE(event_id, endpoint_id) makes it idempotent.
 */
export async function fanOutEvents(): Promise<number> {
  const { rowCount } = await pool.query(`
    WITH batch AS (
      SELECT id, merchant_id, mode, type FROM events
       WHERE dispatched_at IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED),
    ins AS (
      INSERT INTO webhook_deliveries (id, event_id, endpoint_id, next_attempt_at)
      SELECT 'whd_' || replace(gen_random_uuid()::text, '-', ''), b.id, w.id, now()
        FROM batch b JOIN webhook_endpoints w
          ON w.merchant_id = b.merchant_id AND w.mode = b.mode AND w.status = 'active'
         AND (w.events IS NULL OR b.type = ANY (w.events))
      ON CONFLICT DO NOTHING)
    UPDATE events SET dispatched_at = now() WHERE id IN (SELECT id FROM batch)`);
  return rowCount ?? 0;
}

/** Step 2: attempt one delivery over HTTP and record exactly what happened. */
export async function attemptDelivery(d: any): Promise<void> {
  const ep = (await pool.query("SELECT * FROM webhook_endpoints WHERE id=$1", [d.endpoint_id])).rows[0];
  const ev = (await pool.query("SELECT * FROM events WHERE id=$1", [d.event_id])).rows[0];
  if (!ep || !ev || ep.status !== "active") {
    await pool.query("UPDATE webhook_deliveries SET status='failed', next_attempt_at=NULL, last_error='endpoint_unavailable' WHERE id=$1", [d.id]);
    return;
  }

  const attemptNo = d.attempt_count + 1;
  const body = JSON.stringify(buildPayload(ev));
  const secrets = [decrypt(ep.secret_enc)];
  if (ep.prev_secret_enc && ep.prev_expires_at && new Date(ep.prev_expires_at) > new Date()) secrets.push(decrypt(ep.prev_secret_enc));

  const started = Date.now();
  let status: number | null = null, error: string | null = null, snippet: string | null = null;
  try {
    const r = await postJson(ep.url, body, {
      "content-type": "application/json",
      "user-agent": "GatewayWebhooks/1.0",
      "x-gateway-signature": signPayload(secrets, body),
      "x-gateway-event-id": `evt_${ev.id}`,
      "x-gateway-delivery-id": d.id,
      "x-gateway-delivery-attempt": String(attemptNo),
    }, { allowPrivate: config.allowPrivateWebhookTargets, timeoutMs: 10_000 });
    status = r.status; snippet = r.snippet;
  } catch (e) {
    error = String((e as Error).message ?? e).slice(0, 300).replace(/\u0000/g, "");
  }
  const ok = status !== null && status >= 200 && status < 300;
  if (!ok && error === null) error = `HTTP ${status}`;

  await withTx(async (c) => {
    await c.query(
      "INSERT INTO webhook_attempts (delivery_id, attempt_no, status_code, error, duration_ms, response_snippet) VALUES ($1,$2,$3,$4,$5,$6)",
      [d.id, attemptNo, status, error, Date.now() - started, snippet]);

    if (ok) {
      await c.query(
        "UPDATE webhook_deliveries SET status='succeeded', attempt_count=$2, next_attempt_at=NULL, last_status_code=$3, last_error=NULL, succeeded_at=now() WHERE id=$1",
        [d.id, attemptNo, status]);
      await c.query("UPDATE webhook_endpoints SET failure_streak=0 WHERE id=$1", [ep.id]);
      return;
    }

    const delay = ev.type === "ping" ? null : nextAttemptDelay(attemptNo); // a test ping is tried once
    if (delay !== null) {
      await c.query(
        "UPDATE webhook_deliveries SET attempt_count=$2, next_attempt_at=now() + ($3 || ' seconds')::interval, last_status_code=$4, last_error=$5 WHERE id=$1",
        [d.id, attemptNo, String(delay), status, error]);
      return;
    }
    await c.query(
      "UPDATE webhook_deliveries SET status='failed', attempt_count=$2, next_attempt_at=NULL, last_status_code=$3, last_error=$4 WHERE id=$1",
      [d.id, attemptNo, status, error]);
    if (ev.type !== "ping") {
      const s = (await c.query("UPDATE webhook_endpoints SET failure_streak=failure_streak+1 WHERE id=$1 RETURNING failure_streak", [ep.id])).rows[0];
      if (s.failure_streak >= ENDPOINT_DISABLE_AFTER) {
        await c.query("UPDATE webhook_endpoints SET status='disabled', disabled_reason='repeated_failures' WHERE id=$1", [ep.id]);
        await c.query("INSERT INTO audit_logs (merchant_id, action, detail) VALUES ($1,'webhook_endpoint.auto_disabled',$2)",
          [ep.merchant_id, JSON.stringify({ id: ep.id })]);
      }
    }
  });
}

/** Claim due deliveries with a 2-minute lease (a crashed worker's rows simply come back), then send them. */
export async function deliverDue(log?: Log): Promise<number> {
  const { rows } = await pool.query(`
    UPDATE webhook_deliveries SET next_attempt_at = now() + interval '2 minutes'
     WHERE id IN (SELECT id FROM webhook_deliveries
                   WHERE status='pending' AND next_attempt_at <= now()
                   ORDER BY next_attempt_at LIMIT 50 FOR UPDATE SKIP LOCKED)
    RETURNING *`);
  for (let i = 0; i < rows.length; i += 10)
    await Promise.all(rows.slice(i, i + 10).map((d) => attemptDelivery(d).catch((e) => log?.error({ err: e, delivery: d.id }, "webhook attempt crashed"))));
  return rows.length;
}

export function startWebhookWorker(log: Log) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try { await fanOutEvents(); await deliverDue(log); } catch (e) { log.error(e); } finally { running = false; }
  }, 2_000);
}
