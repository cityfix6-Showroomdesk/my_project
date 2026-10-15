import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { newId, sha256 } from "./ids.js";

export type Mode = "test" | "live";

/** Full key is returned once at creation; only its hash is stored. */
export function generateKey(mode: Mode) {
  const key = `sk_${mode}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

export async function createApiKey(db: { query: (text: string, params?: any[]) => Promise<any> }, merchantId: string, mode: Mode) {
  const { key, prefix, hash } = generateKey(mode);
  const id = newId("key");
  await db.query(
    "INSERT INTO api_keys (id, merchant_id, mode, prefix, key_hash) VALUES ($1,$2,$3,$4,$5)",
    [id, merchantId, mode, prefix, hash]
  );
  return { id, key, prefix };
}

export interface AuthContext {
  merchantId: string;
  mode: Mode;
  kycStatus: string;
  via?: "api_key" | "session"; // who is calling: a server holding a key, or a person in the dashboard
  sessionId?: string;
  steppedUp?: boolean;        // session only: confirmed password/2FA in the last 10 minutes
}

/** Returns null for unknown/revoked keys or suspended merchants. */
export async function authenticate(bearer: string | undefined): Promise<AuthContext | null> {
  const m = bearer?.match(/^Bearer (sk_(?:test|live)_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const { rows } = await pool.query(
    `SELECT k.id, k.mode, k.merchant_id, m.kyc_status
       FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND m.status = 'active'`,
    [sha256(m[1])]
  );
  if (!rows[0]) return null;
  pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [rows[0].id]).catch(() => {});
  return { merchantId: rows[0].merchant_id, mode: rows[0].mode, kycStatus: rows[0].kyc_status, via: "api_key" };
}
