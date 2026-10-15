import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isPublicAddress, assertUrlAllowed, guardedLookup, postJson, WebhookUrlError } from "../src/safeHttp.js";
import { signPayload, verifySignature } from "../src/webhookSign.js";
import { nextAttemptDelay, MAX_ATTEMPTS } from "../src/webhookPolicy.js";
import { buildPayload } from "../src/events.js";

test("SSRF guard: private, loopback, link-local, metadata and mapped addresses are blocked", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
                    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
                    "::ffff:127.0.0.1", "::ffff:10.1.2.3", "2002:7f00:1::1", "64:ff9b::7f00:1", "not-an-ip"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "203.0.114.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
    assert.equal(isPublicAddress(ip), true, ip);
});

test("URL validation rejects dangerous shapes before any request", async () => {
  const code = async (u: string) => { try { await assertUrlAllowed(u, false); return "ok"; } catch (e) { return (e as WebhookUrlError).code; } };
  assert.equal(await code("not a url"), "invalid_url");
  assert.equal(await code("http://8.8.8.8/hook"), "scheme_not_allowed");
  assert.equal(await code("ftp://8.8.8.8/hook"), "scheme_not_allowed");
  assert.equal(await code("https://user:pw@8.8.8.8/hook"), "credentials_in_url");
  assert.equal(await code("https://127.0.0.1/hook"), "blocked_address");
  assert.equal(await code("https://[::1]/hook"), "blocked_address");
  assert.equal(await code("https://169.254.169.254/latest/meta-data"), "blocked_address");
  assert.equal(await code("https://localhost/hook"), "blocked_address");
  assert.equal(await code("https://8.8.8.8/hook"), "ok");
});

test("connect-time lookup refuses names that resolve privately (DNS-rebinding defence)", async () => {
  const r = await new Promise<any>((res) => guardedLookup(false)("localhost", { all: true }, (err: any) => res(err)));
  assert.equal(r?.code, "blocked_address");
});

test("signature: round trip, tamper, wrong secret, stale timestamp, rotation overlap", () => {
  const body = '{"id":"evt_1","type":"order.paid"}';
  const h = signPayload(["whsec_a"], body);
  assert.ok(verifySignature(h, body, "whsec_a"));
  assert.ok(!verifySignature(h, body + " ", "whsec_a"));
  assert.ok(!verifySignature(h, body, "whsec_b"));
  assert.ok(!verifySignature(undefined, body, "whsec_a"));
  assert.ok(!verifySignature("t=abc,v1=00", body, "whsec_a"));
  const old = signPayload(["whsec_a"], body, 1_000_000);
  assert.ok(!verifySignature(old, body, "whsec_a", 300, 1_000_000 + 301));
  assert.ok(verifySignature(old, body, "whsec_a", 300, 1_000_000 + 299));
  const both = signPayload(["whsec_new", "whsec_old"], body);          // during a rotation
  assert.ok(verifySignature(both, body, "whsec_new") && verifySignature(both, body, "whsec_old"));
  assert.ok(verifySignature(h, Buffer.from(body), "whsec_a"));          // raw Buffer works too
});

test("retry policy: growing delays with jitter, then exhausted", () => {
  assert.equal(nextAttemptDelay(1, () => 0.5), 10);
  assert.equal(nextAttemptDelay(2, () => 0.5), 60);
  assert.equal(nextAttemptDelay(8, () => 0.5), 86400);
  assert.equal(nextAttemptDelay(MAX_ATTEMPTS), null);
  const lo = nextAttemptDelay(3, () => 0)!, hi = nextAttemptDelay(3, () => 0.999)!;
  assert.ok(lo >= 270 && hi <= 330 && lo < hi);
  assert.equal(MAX_ATTEMPTS, 9);
});

test("event payload shape", () => {
  const p = buildPayload({ id: "42", type: "order.paid", mode: "live", created_at: new Date(1_700_000_000_000), data: { order_id: "ord_1" } });
  assert.deepEqual(p, { id: "evt_42", object: "event", api_version: "2026-10-01", type: "order.paid", created: 1_700_000_000, mode: "live", data: { order_id: "ord_1" } });
});

test("postJson over real HTTP: delivers body+headers, no redirects, caps response, enforces timeout", async () => {
  const seen: any[] = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      seen.push({ url: req.url, body: b, sig: req.headers["x-gateway-signature"] });
      if (req.url === "/redir") { res.writeHead(302, { location: "http://127.0.0.1:1/" }); return res.end(); }
      if (req.url === "/big") { res.writeHead(200); return res.end("x".repeat(50_000)); }
      if (req.url === "/slow") return; // never answer
      res.writeHead(200); res.end("ok");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const opts = { allowPrivate: true, timeoutMs: 400 };
  try {
    const ok = await postJson(`${base}/hook`, '{"a":1}', { "x-gateway-signature": "t=1,v1=zz" }, opts);
    assert.equal(ok.status, 200); assert.equal(ok.snippet, "ok");
    assert.deepEqual([seen[0].body, seen[0].sig], ['{"a":1}', "t=1,v1=zz"]);
    assert.equal((await postJson(`${base}/redir`, "{}", {}, opts)).status, 302);      // reported, never followed
    assert.ok((await postJson(`${base}/big`, "{}", {}, opts)).snippet.length <= 1000);
    await assert.rejects(postJson(`${base}/slow`, "{}", {}, opts), /timeout/);
    await assert.rejects(postJson(`${base}/hook`, "{}", {}, { allowPrivate: false, timeoutMs: 400 }), (e: any) => e.code === "scheme_not_allowed");
  } finally { srv.closeAllConnections(); srv.close(); }
});
