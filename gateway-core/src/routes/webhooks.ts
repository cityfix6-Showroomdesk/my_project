import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { pool } from "../db.js";
import { newId } from "../ids.js";
import { authenticateRequest, requireStepUp } from "../authContext.js";
import { encrypt } from "../crypto.js";
import { config } from "../config.js";
import { EVENT_TYPES, buildPayload } from "../events.js";
import { assertUrlAllowed, WebhookUrlError } from "../safeHttp.js";
import { attemptDelivery } from "../webhookWorker.js";

const MAX_ENDPOINTS = 5;
const newSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

const serializeEndpoint = (r: any) => ({
  id: r.id, object: "webhook_endpoint", url: r.url, description: r.description, mode: r.mode,
  events: r.events ?? "all", status: r.status, disabled_reason: r.disabled_reason,
  failure_streak: r.failure_streak, created_at: r.created_at,
});
const serializeDelivery = (r: any) => ({
  id: r.id, object: "webhook_delivery", event_id: `evt_${r.event_id}`, event_type: r.event_type, endpoint_id: r.endpoint_id,
  status: r.status, attempt_count: r.attempt_count, next_attempt_at: r.next_attempt_at,
  last_status_code: r.last_status_code, last_error: r.last_error, succeeded_at: r.succeeded_at, created_at: r.created_at,
});

const eventsField = z.array(z.enum(EVENT_TYPES)).min(1);
const createSchema = z.object({ url: z.string().max(2000), events: eventsField.optional(), description: z.string().max(200).optional() });
const patchSchema = z.object({
  url: z.string().max(2000).optional(), events: eventsField.nullable().optional(),
  description: z.string().max(200).nullable().optional(), status: z.enum(["active", "disabled"]).optional(),
});

export async function webhookRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    const auth = await authenticateRequest(req);
    if (!auth) return reply.code(401).send({ error: { code: "unauthorized" } });
    req.auth = auth;
  });

  const findEndpoint = async (id: string, mid: string, mode: string) =>
    (await pool.query("SELECT * FROM webhook_endpoints WHERE id=$1 AND merchant_id=$2 AND mode=$3 AND status<>'deleted'", [id, mid, mode])).rows[0];

  const urlProblem = async (url: string) => {
    try { await assertUrlAllowed(url, config.allowPrivateWebhookTargets); return null; }
    catch (e) { if (e instanceof WebhookUrlError) return { error: { code: e.code, message: e.message } }; throw e; }
  };

  // ---------- endpoints ----------
  app.post("/v1/webhook-endpoints", async (req, reply) => {
    if (!requireStepUp(req, reply)) return reply;
    const body = createSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request", details: body.error.flatten() } });
    const { merchantId, mode } = req.auth;
    const n = (await pool.query("SELECT count(*)::int n FROM webhook_endpoints WHERE merchant_id=$1 AND mode=$2 AND status<>'deleted'", [merchantId, mode])).rows[0].n;
    if (n >= MAX_ENDPOINTS) return reply.code(422).send({ error: { code: "endpoint_limit_reached" } });
    const bad = await urlProblem(body.data.url);
    if (bad) return reply.code(422).send(bad);

    const secret = newSecret();
    const { rows } = await pool.query(
      `INSERT INTO webhook_endpoints (id, merchant_id, mode, url, description, events, secret_enc)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [newId("whe"), merchantId, mode, body.data.url, body.data.description ?? null, body.data.events ?? null, encrypt(secret)]);
    return reply.code(201).send({ ...serializeEndpoint(rows[0]), secret, note: "Store this signing secret now. It is shown only once." });
  });

  app.get("/v1/webhook-endpoints", async (req) => {
    const { rows } = await pool.query(
      "SELECT * FROM webhook_endpoints WHERE merchant_id=$1 AND mode=$2 AND status<>'deleted' ORDER BY created_at", [req.auth.merchantId, req.auth.mode]);
    return { data: rows.map(serializeEndpoint) };
  });

  app.patch("/v1/webhook-endpoints/:id", async (req, reply) => {
    if (!requireStepUp(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request", details: body.error.flatten() } });
    const ep = await findEndpoint(id, req.auth.merchantId, req.auth.mode);
    if (!ep) return reply.code(404).send({ error: { code: "not_found" } });
    if (body.data.url !== undefined) { const bad = await urlProblem(body.data.url); if (bad) return reply.code(422).send(bad); }

    const sets: string[] = [], vals: unknown[] = [id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (body.data.url !== undefined) set("url", body.data.url);
    if (body.data.events !== undefined) set("events", body.data.events);       // null = all events
    if (body.data.description !== undefined) set("description", body.data.description);
    if (body.data.status !== undefined) {
      set("status", body.data.status);
      if (body.data.status === "active") { sets.push("failure_streak=0", "disabled_reason=NULL"); }
      else set("disabled_reason", "disabled_by_merchant");
    }
    if (!sets.length) return serializeEndpoint(ep);
    const { rows } = await pool.query(`UPDATE webhook_endpoints SET ${sets.join(", ")} WHERE id=$1 RETURNING *`, vals);
    return serializeEndpoint(rows[0]);
  });

  app.delete("/v1/webhook-endpoints/:id", async (req, reply) => {
    if (!requireStepUp(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const r = await pool.query("UPDATE webhook_endpoints SET status='deleted' WHERE id=$1 AND merchant_id=$2 AND mode=$3 AND status<>'deleted'",
      [id, req.auth.merchantId, req.auth.mode]);
    return r.rowCount ? reply.code(204).send() : reply.code(404).send({ error: { code: "not_found" } });
  });

  // New secret now; the old one keeps signing alongside it for 24h so the merchant can deploy without downtime.
  app.post("/v1/webhook-endpoints/:id/rotate-secret", async (req, reply) => {
    if (!requireStepUp(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const ep = await findEndpoint(id, req.auth.merchantId, req.auth.mode);
    if (!ep) return reply.code(404).send({ error: { code: "not_found" } });
    const secret = newSecret();
    await pool.query("UPDATE webhook_endpoints SET prev_secret_enc=secret_enc, prev_expires_at=now() + interval '24 hours', secret_enc=$2 WHERE id=$1", [id, encrypt(secret)]);
    await pool.query("INSERT INTO audit_logs (merchant_id, action, detail, ip) VALUES ($1,'webhook_endpoint.secret_rotated',$2,$3)",
      [req.auth.merchantId, JSON.stringify({ id }), req.ip]);
    return { secret, old_secret_valid_for: "24h", note: "Both secrets sign deliveries during the overlap. Update your server, then you're done." };
  });

  // Sends one real, signed "ping" and reports what the merchant's server answered.
  app.post("/v1/webhook-endpoints/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ep = await findEndpoint(id, req.auth.merchantId, req.auth.mode);
    if (!ep) return reply.code(404).send({ error: { code: "not_found" } });
    if (ep.status !== "active") return reply.code(409).send({ error: { code: "endpoint_not_active" } });
    const evId = (await pool.query(
      "INSERT INTO events (merchant_id, mode, type, data, dispatched_at) VALUES ($1,$2,'ping',$3, now()) RETURNING id",
      [ep.merchant_id, ep.mode, JSON.stringify({ message: "This is a test event." })])).rows[0].id;
    const d = (await pool.query(
      "INSERT INTO webhook_deliveries (id, event_id, endpoint_id, next_attempt_at) VALUES ($1,$2,$3, now() + interval '5 minutes') RETURNING *",
      [newId("whd"), evId, ep.id])).rows[0];
    await attemptDelivery(d);
    const out = (await pool.query("SELECT d.*, 'ping' AS event_type FROM webhook_deliveries d WHERE d.id=$1", [d.id])).rows[0];
    return { ...serializeDelivery(out), ok: out.status === "succeeded" };
  });

  // ---------- delivery log ----------
  app.get("/v1/webhook-deliveries", async (req) => {
    const q = z.object({
      endpoint_id: z.string().optional(), status: z.enum(["pending", "succeeded", "failed"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    const params: unknown[] = [req.auth.merchantId, req.auth.mode];
    let where = "w.merchant_id=$1 AND w.mode=$2";
    if (q.endpoint_id) { params.push(q.endpoint_id); where += ` AND d.endpoint_id=$${params.length}`; }
    if (q.status) { params.push(q.status); where += ` AND d.status=$${params.length}`; }
    params.push(q.limit);
    const { rows } = await pool.query(
      `SELECT d.*, e.type AS event_type FROM webhook_deliveries d
         JOIN webhook_endpoints w ON w.id=d.endpoint_id JOIN events e ON e.id=d.event_id
        WHERE ${where} ORDER BY d.created_at DESC LIMIT $${params.length}`, params);
    return { data: rows.map(serializeDelivery) };
  });

  const loadDelivery = async (id: string, mid: string, mode: string) =>
    (await pool.query(
      `SELECT d.*, e.type AS event_type FROM webhook_deliveries d
         JOIN webhook_endpoints w ON w.id=d.endpoint_id JOIN events e ON e.id=d.event_id
        WHERE d.id=$1 AND w.merchant_id=$2 AND w.mode=$3`, [id, mid, mode])).rows[0];

  app.get("/v1/webhook-deliveries/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = await loadDelivery(id, req.auth.merchantId, req.auth.mode);
    if (!d) return reply.code(404).send({ error: { code: "not_found" } });
    const attempts = (await pool.query(
      "SELECT attempt_no, status_code, error, duration_ms, response_snippet, created_at FROM webhook_attempts WHERE delivery_id=$1 ORDER BY attempt_no", [id])).rows;
    return { ...serializeDelivery(d), attempts };
  });

  app.post("/v1/webhook-deliveries/:id/replay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = await loadDelivery(id, req.auth.merchantId, req.auth.mode);
    if (!d) return reply.code(404).send({ error: { code: "not_found" } });
    const r = await pool.query(
      "UPDATE webhook_deliveries SET status='pending', attempt_count=0, next_attempt_at=now(), last_error=NULL WHERE id=$1 AND status<>'pending'", [id]);
    return r.rowCount ? reply.code(202).send({ ok: true }) : reply.code(409).send({ error: { code: "already_pending" } });
  });

  // ---------- event feed: lets a merchant catch up if their server was down longer than our retries ----------
  app.get("/v1/events", async (req) => {
    const q = z.object({
      type: z.enum(EVENT_TYPES).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    const params: unknown[] = [req.auth.merchantId, req.auth.mode];
    let where = "merchant_id=$1 AND mode=$2 AND type <> 'ping'";
    if (q.type) { params.push(q.type); where += ` AND type=$${params.length}`; }
    const cur = q.cursor?.replace(/^evt_/, "");
    if (cur && /^\d+$/.test(cur)) { params.push(cur); where += ` AND id < $${params.length}`; }
    params.push(q.limit + 1);
    const { rows } = await pool.query(`SELECT * FROM events WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
    const page = rows.slice(0, q.limit);
    return { data: page.map(buildPayload), next_cursor: rows.length > q.limit ? `evt_${page[page.length - 1].id}` : null };
  });

  app.get("/v1/events/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const n = id.replace(/^evt_/, "");
    if (!/^\d+$/.test(n)) return reply.code(404).send({ error: { code: "not_found" } });
    const ev = (await pool.query("SELECT * FROM events WHERE id=$1 AND merchant_id=$2 AND mode=$3 AND type<>'ping'", [n, req.auth.merchantId, req.auth.mode])).rows[0];
    return ev ? buildPayload(ev) : reply.code(404).send({ error: { code: "not_found" } });
  });
}
