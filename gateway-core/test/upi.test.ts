import test from "node:test";
import assert from "node:assert/strict";
import { buildUpiUri, VPA_RE } from "../src/upi.js";

test("VPA validation", () => {
  for (const ok of ["shop@okicici", "a.b-c_1@ybl", "9876543210@paytm"]) assert.ok(VPA_RE.test(ok), ok);
  for (const bad of ["shop", "@ybl", "sh op@ybl", "shop@", "shop@1bank", "a@b@c"]) assert.ok(!VPA_RE.test(bad), bad);
});

test("UPI link carries amount in rupees, payee, and a clean reference", () => {
  const u = buildUpiUri({ vpa: "shop@okicici", payeeName: "My Shop & Co", amountPaise: 49950, orderId: "ord_Ab-12_x" });
  assert.match(u, /^upi:\/\/pay\?/);
  assert.ok(u.includes("pa=shop@okicici"));
  assert.ok(u.includes("am=499.50"));
  assert.ok(u.includes("pn=My%20Shop%20%26%20Co"));
  assert.ok(u.includes("tr=ordAb12x"));
  assert.ok(u.includes("cu=INR"));
});

import { upiAppLinks } from "../src/upi.js";
test("per-app UPI links keep every parameter; non-standard links get no app buttons", () => {
  const u = buildUpiUri({ vpa: "shop@okicici", payeeName: "My Shop", amountPaise: 49900, orderId: "ord_X" });
  const q = u.slice("upi://pay?".length);
  const links = upiAppLinks(u);
  assert.deepEqual(links.map((l) => l.label), ["Google Pay", "PhonePe", "Paytm"]);
  assert.equal(links[0].href, `gpay://upi/pay?${q}`);
  assert.equal(links[1].href, `phonepe://pay?${q}`);
  assert.equal(links[2].href, `paytmmp://pay?${q}`);
  assert.deepEqual(upiAppLinks("https://evil.example/pay?x=1"), []);
  assert.deepEqual(upiAppLinks("javascript:alert(1)"), []);
});
