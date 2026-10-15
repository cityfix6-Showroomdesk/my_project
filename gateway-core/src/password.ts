import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt: memory-hard, built into Node (no native dependency). Parameters are stored with each hash, so they can be raised later.
const N = 1 << 15, R = 8, P = 1, KEYLEN = 64;

const derive = (pw: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((res, rej) =>
    scrypt(pw.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pw, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Always does the full work, even for unknown accounts (stored = null), so response time doesn't reveal which emails exist. */
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  const parts = stored?.split("$");
  if (!parts || parts.length !== 6 || parts[0] !== "scrypt") {
    await derive(pw, Buffer.alloc(16), N, R, P);
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, "base64");
  const got = await derive(pw, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return got.length === want.length && timingSafeEqual(got, want);
}

const COMMON = new Set(["password", "password1", "password123", "123456789", "1234567890", "qwertyuiop", "iloveyou12",
  "letmein123", "welcome123", "admin12345", "abc123456789", "11111111111", "00000000000"]);

/** Returns a reason string if the password is unacceptable, else null. Length beats complexity rules. */
export function checkPasswordPolicy(pw: string, email: string): string | null {
  if (pw.length < 10) return "must be at least 10 characters";
  if (pw.length > 128) return "must be at most 128 characters";
  if (new Set(pw).size < 5) return "is too repetitive";
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return "is too common";
  const local = email.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return "must not contain your email name";
  return null;
}
