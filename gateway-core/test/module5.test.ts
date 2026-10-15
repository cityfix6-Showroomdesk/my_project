import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, checkPasswordPolicy } from "../src/password.js";
import { base32Encode, base32Decode, hotp, verifyTotp, stepAt } from "../src/totp.js";
import { parseCookies, serializeCookie } from "../src/cookies.js";
import { screenRisk, PAN_RE, GSTIN_RE } from "../src/kycPolicy.js";

test("password hashing: verifies, salts uniquely, rejects wrong/unknown, never stores plaintext", async () => {
  const h = await hashPassword("correct horse battery");
  assert.ok(h.startsWith("scrypt$32768$8$1$") && !h.includes("correct"));
  assert.ok(await verifyPassword("correct horse battery", h));
  assert.ok(!(await verifyPassword("correct horse batterY", h)));
  assert.notEqual(h, await hashPassword("correct horse battery"));
  assert.ok(!(await verifyPassword("anything", null)));            // unknown account: still does the work, returns false
  assert.ok(!(await verifyPassword("anything", "garbage$format")));
});

test("password policy", () => {
  assert.equal(checkPasswordPolicy("short1", "a@b.com"), "must be at least 10 characters");
  assert.equal(checkPasswordPolicy("aaaaaaaaaaaa", "a@b.com"), "is too repetitive");
  assert.equal(checkPasswordPolicy("password123", "a@b.com"), "is too common");
  assert.equal(checkPasswordPolicy("my-shopowner-pass", "shopowner@x.com"), "must not contain your email name");
  assert.equal(checkPasswordPolicy("x".repeat(129), "a@b.com"), "must be at most 128 characters");
  assert.equal(checkPasswordPolicy("tall giraffe river 42", "a@b.com"), null);
});

test("TOTP matches the RFC 4226 / 6238 test vectors", () => {
  const secret = Buffer.from("12345678901234567890");
  const rfc4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  rfc4226.forEach((want, i) => assert.equal(hotp(secret, i), want));
  assert.equal(hotp(secret, stepAt(59_000), 8), "94287082");           // RFC 6238, T=59
  assert.equal(hotp(secret, stepAt(1111111109_000), 8), "07081804");   // RFC 6238, T=1111111109
});

test("TOTP: drift window, single use, wrong code, format", () => {
  const secret = Buffer.from("12345678901234567890");
  const now = 1_700_000_000_000, cur = stepAt(now);
  assert.equal(verifyTotp(secret, hotp(secret, cur), now, null), cur);
  assert.equal(verifyTotp(secret, hotp(secret, cur - 1), now, null), cur - 1);     // 30s late
  assert.equal(verifyTotp(secret, hotp(secret, cur + 1), now, null), cur + 1);     // 30s early
  assert.equal(verifyTotp(secret, hotp(secret, cur - 2), now, null), null);        // too old
  assert.equal(verifyTotp(secret, hotp(secret, cur), now, cur), null);             // replay of a used step
  assert.equal(verifyTotp(secret, hotp(secret, cur + 1), now, cur), cur + 1);      // a newer step still works
  for (const bad of ["000000x", "12345", "abcdef", ""]) assert.equal(verifyTotp(secret, bad, now, null), null);
});

test("base32 round trip (what authenticator apps scan)", () => {
  assert.equal(base32Encode(Buffer.from("12345678901234567890")), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  const raw = Buffer.from(Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 255));
  assert.deepEqual(base32Decode(base32Encode(raw)), raw);
  assert.throws(() => base32Decode("not*base32"));
});

test("cookies: parsed safely, serialized with HttpOnly + SameSite=Strict (+Secure)", () => {
  assert.deepEqual(parseCookies("a=1; gw_session=abc%2Fdef; bad; =x"), { a: "1", gw_session: "abc/def" });
  assert.deepEqual(parseCookies(undefined), {});
  const c = serializeCookie("gw_session", "tok", { maxAgeSec: 60, secure: true });
  assert.ok(c.includes("HttpOnly") && c.includes("SameSite=Strict") && c.includes("Secure") && c.includes("Max-Age=60"));
  assert.ok(!serializeCookie("x", "y", { maxAgeSec: 1, secure: false }).includes("Secure"));
});

test("KYC formats and prohibited-business screening", () => {
  assert.ok(PAN_RE.test("ABCDE1234F") && !PAN_RE.test("abcde1234f") && !PAN_RE.test("ABCDE12345"));
  assert.ok(GSTIN_RE.test("27AAPFU0939F1ZV") && !GSTIN_RE.test("27AAPFU0939F1XV"));
  assert.deepEqual(screenRisk("Sunrise Stationery", "School supplies online"), []);
  assert.deepEqual(screenRisk("Lucky Casino", "teen patti and rummy"), ["casino", "rummy", "teen patti"]);
  assert.deepEqual(screenRisk(undefined, "Instant Loan App for you"), ["loan app", "instant loan"]);
});
