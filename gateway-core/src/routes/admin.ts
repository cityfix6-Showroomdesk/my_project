import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTx } from "../db.js";
import { decrypt } from "../crypto.js";
import { requireAdmin } from "../admin.js";

/** Operator-only (x-admin-token). KYC review is a human decision; risk flags are hints for the reviewer. */
export async function adminRoutes(app: FastifyInstance) {
  app.get("/admin/kyc/pending", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { rows } = await pool.query(
      `SELECT k.id, k.merchant_id, m.email, m.business_name, k.risk_flags, k.data_enc, k.created_at
         FROM kyc_submissions k JOIN merchants m ON m.id=k.merchant_id WHERE k.status='submitted' ORDER BY k.created_at LIMIT 100`);
    return { data: rows.map(({ data_enc, ...r }) => ({ ...r, details: JSON.parse(decrypt(data_enc)) })) };
  });

  app.post("/admin/merchants/:id/kyc", async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const body = z.object({ result: z.enum(["approved", "rejected"]), note: z.string().max(500).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "invalid_request" } });
    const ok = await withTx(async (c) => {
      const sub = await c.query(
        "UPDATE kyc_submissions SET status=$2, reviewer_note=$3, reviewed_at=now() WHERE id=(SELECT id FROM kyc_submissions WHERE merchant_id=$1 AND status='submitted' ORDER BY created_at DESC LIMIT 1) RETURNING id",
        [id, body.data.result, body.data.note ?? null]);
      if (!sub.rowCount) return false;
      await c.query("UPDATE merchants SET kyc_status=$2 WHERE id=$1", [id, body.data.result]);
      await c.query("INSERT INTO audit_logs (merchant_id, action, detail, ip) VALUES ($1,$2,$3,$4)", [id, `kyc.${body.data.result}`, JSON.stringify({ note: body.data.note ?? null }), req.ip]);
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: { code: "no_submission_pending" } });
  });
}
