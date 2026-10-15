import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { decideOutcome } from "../src/matching.js";
import { encrypt, decrypt } from "../src/crypto.js";
import { razorpay } from "../src/verifiers/razorpay.js";

const order = (status: string) => ({ status, amount_paise: 49900, currency: "INR" });
const pay = (o: Partial<{ status: string; amountPaise: number; currency: string }> = {}) =>
  ({ status: "captured", amountPaise: 49900, currency: "INR", ...o });

test("exact captured payment on an open order is matched", () => {
  assert.equal(decideOutcome(order("pending"), pay()), "matched");
  assert.equal(decideOutcome(order("created"), pay()), "matched");
});
test("wrong amount is never auto-accepted", () => {
  assert.equal(decideOutcome(order("pending"), pay({ amountPaise: 49800 })), "amount_mismatch");
  assert.equal(decideOutcome(order("pending"), pay({ amountPaise: 50000 })), "amount_mismatch");
  assert.equal(decideOutcome(order("pending"), pay({ currency: "USD" })), "amount_mismatch");
});
test("late and double payments are flagged, not completed", () => {
  assert.equal(decideOutcome(order("expired"), pay()), "late");
  assert.equal(decideOutcome(order("failed"), pay()), "late");
  assert.equal(decideOutcome(order("paid"), pay()), "duplicate_payment");
});
test("uncaptured/failed/refunded payments never mark an order paid", () => {
  for (const s of ["failed", "refunded", "pending"]) assert.equal(decideOutcome(order("pending"), pay({ status: s })), "not_captured");
});

test("credentials round-trip and tampering is detected", () => {
  process.env.MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  const blob = encrypt('{"keyId":"rzp_test_x","keySecret":"s3cret"}');
  assert.ok(!blob.includes("s3cret"));
  assert.equal(decrypt(blob), '{"keyId":"rzp_test_x","keySecret":"s3cret"}');
  assert.notEqual(encrypt("a"), encrypt("a")); // fresh IV each time
  const parts = blob.split(":"); parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decrypt(parts.join(":")));
});

test("razorpay webhook signature: valid accepted, forged/missing rejected", () => {
  const raw = Buffer.from('{"event":"qr_code.credited","payload":{"qr_code":{"entity":{"id":"qr_123"}}}}');
  const good = createHmac("sha256", "whsec_test").update(raw).digest("hex");
  assert.ok(razorpay.verifyWebhook!(raw, good, "whsec_test"));
  assert.ok(!razorpay.verifyWebhook!(raw, good, "other-secret"));
  assert.ok(!razorpay.verifyWebhook!(Buffer.from("{}"), good, "whsec_test"));
  assert.ok(!razorpay.verifyWebhook!(raw, undefined, "whsec_test"));
  assert.ok(!razorpay.verifyWebhook!(raw, "short", "whsec_test"));
  assert.equal(razorpay.extractProviderRef!(JSON.parse(raw.toString())), "qr_123");
});
