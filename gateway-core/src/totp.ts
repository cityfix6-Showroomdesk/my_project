import { createHmac, timingSafeEqual } from "node:crypto";

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 4226 */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(buf).digest();
  const o = h[19] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (ms: number, period = 30) => Math.floor(ms / 1000 / period);

/**
 * RFC 6238, 6 digits, 30s, +/-1 step of clock drift.
 * Returns the matched time step, or null. Steps at or before `lastStep` are rejected, so a code works once.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastStep: number | null, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = stepAt(nowMs);
  let hit: number | null = null;
  for (let d = -window; d <= window; d++) {   // no early exit: constant work
    const step = cur + d;
    if (lastStep !== null && step <= lastStep) continue;
    const want = Buffer.from(hotp(secret, step)), got = Buffer.from(code);
    if (timingSafeEqual(want, got) && hit === null) hit = step;
  }
  return hit;
}
