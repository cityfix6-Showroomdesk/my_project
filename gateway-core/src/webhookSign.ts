import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Header format:  t=<unix>,v1=<hmac>[,v1=<hmac>]
 * HMAC-SHA256 over "<t>.<raw body>". The timestamp is signed, so a captured request can't be replayed later.
 * Multiple v1 values appear only while a rotated secret's grace period is running.
 */
const mac = (secret: string, t: number, body: string) =>
  createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

export function signPayload(secrets: string[], body: string, t = Math.floor(Date.now() / 1000)): string {
  return [`t=${t}`, ...secrets.map((s) => `v1=${mac(s, t, body)}`)].join(",");
}

/** Reference verifier: this is what merchants run on their side (also shown in the README). */
export function verifySignature(
  header: string | undefined, body: string | Buffer, secret: string,
  toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!header) return false;
  const parts = header.split(",");
  const tStr = parts.find((p) => p.startsWith("t="))?.slice(2);
  const t = Number(tStr);
  if (!tStr || !Number.isInteger(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const want = Buffer.from(mac(secret, t, typeof body === "string" ? body : body.toString("utf8")));
  return parts.filter((p) => p.startsWith("v1=")).some((p) => {
    const got = Buffer.from(p.slice(3));
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
