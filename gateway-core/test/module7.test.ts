import test from "node:test";
import assert from "node:assert/strict";
import { createPaytm } from "../src/verifiers/paytm.js";
import { ProviderAuthError, ProviderRequestError } from "../src/verifiers/types.js";

const creds = { keyId: "MID123", keySecret: "mkey", mode: "test" as const };
const signed: string[] = [];
const sign = async (b: string, k: string) => { signed.push(b); return `sig(${k})`; };
const paytm = createPaytm(sign);

let sent: { url: string; init: any }[] = [];
const reply = (body: any, status = 200) => { (globalThis as any).fetch = async (url: string, init: any) => { sent.push({ url, init }); return { status, json: async () => ({ body }) }; }; };
const statusOf = (o: any) => reply({ orderId: "ord_X", mid: "MID123", resultInfo: { resultStatus: "TXN_SUCCESS", resultCode: "01" }, txnId: "T1", txnAmount: "499.00", rrnCode: "R1", txnDate: "2026-10-12 14:00:28", ...o });

test("QR request: amount in rupees, signature covers the exact bytes sent, hits the staging host", async () => {
  sent = []; signed.length = 0;
  reply({ resultInfo: { resultStatus: "SUCCESS", resultCode: "QR_0001" }, qrCodeId: "Q1", qrData: "upi://pay?pa=paytmqr@paytm&am=499.00" });
  const p = await paytm.prepare(creds, { id: "ord_X", amountPaise: 49900, expiresAt: new Date(), reference: "r" });
  assert.deepEqual(p, { providerRef: "ord_X", upiUri: "upi://pay?pa=paytmqr@paytm&am=499.00" });
  assert.match(sent[0].url, /^https:\/\/securegw-stage\.paytmpayments\.in\/paymentservices\/qr\/create$/);
  const wire = JSON.parse(sent[0].init.body);
  assert.equal(wire.body.amount, "499.00"); assert.equal(wire.body.mid, "MID123"); assert.equal(wire.body.businessType, "UPI_QR_CODE");
  assert.equal(signed[0], JSON.stringify(wire.body));                       // signed string == sent string
  assert.ok(sent[0].init.body.includes(signed[0]));
  assert.equal(wire.head.signature, "sig(mkey)");
  assert.equal(paytm.maxExpirySeconds, 600);
});

test("QR failures: Paytm error codes surface; non-upi payloads are refused", async () => {
  reply({ resultInfo: { resultStatus: "FAILURE", resultCode: "DQR_0007", resultMsg: "UPI Paymode is not enabled on Merchant" } });
  await assert.rejects(paytm.prepare(creds, { id: "o", amountPaise: 100, expiresAt: new Date() }), /DQR_0007.*not enabled/);
  reply({ resultInfo: { resultStatus: "SUCCESS" }, qrData: "javascript:alert(1)" });
  await assert.rejects(paytm.prepare(creds, { id: "o", amountPaise: 100, expiresAt: new Date() }), (e: any) => e instanceof ProviderRequestError && /not a upi/.test(e.message));
});

test("status: success -> captured with IST date; pending / no record -> nothing", async () => {
  statusOf({});
  const [p] = await paytm.fetchPayments(creds, "ord_X");
  assert.equal(p.status, "captured"); assert.equal(p.amountPaise, 49900); assert.equal(p.providerPaymentId, "T1"); assert.equal(p.rrn, "R1");
  assert.equal(p.paidAt!.toISOString(), "2026-10-12T08:30:28.000Z");
  statusOf({ resultInfo: { resultStatus: "PENDING", resultCode: "402" } }); assert.deepEqual(await paytm.fetchPayments(creds, "ord_X"), []);
  statusOf({ resultInfo: { resultStatus: "NO_RECORD_FOUND", resultCode: "331" }, txnId: undefined }); assert.deepEqual(await paytm.fetchPayments(creds, "ord_X"), []);
});

test("status: failure, refund, paise rounding, and answers about the wrong order/merchant are ignored", async () => {
  statusOf({ resultInfo: { resultStatus: "TXN_FAILURE", resultCode: "227" } });
  assert.equal((await paytm.fetchPayments(creds, "ord_X"))[0].status, "failed");
  statusOf({ refundAmt: "499.00" }); assert.equal((await paytm.fetchPayments(creds, "ord_X"))[0].status, "refunded");
  statusOf({ refundAmt: "100.00" }); assert.equal((await paytm.fetchPayments(creds, "ord_X"))[0].status, "captured"); // partial refund keeps the sale
  statusOf({ txnAmount: "0.29" }); assert.equal((await paytm.fetchPayments(creds, "ord_X"))[0].amountPaise, 29);      // 0.29*100 float trap
  statusOf({ orderId: "ord_OTHER" }); assert.deepEqual(await paytm.fetchPayments(creds, "ord_X"), []);
  statusOf({ mid: "SOMEONE_ELSE" }); assert.deepEqual(await paytm.fetchPayments(creds, "ord_X"), []);
});

test("credential check: 'no record' means the keys work; bad MID/checksum is an auth error", async () => {
  reply({ resultInfo: { resultStatus: "NO_RECORD_FOUND", resultCode: "331" } });
  await paytm.validateCredentials(creds);
  reply({ resultInfo: { resultStatus: "TXN_FAILURE", resultCode: "335", resultMsg: "Mid is invalid" } });
  await assert.rejects(paytm.validateCredentials(creds), ProviderAuthError);
  reply({ resultInfo: { resultStatus: "F", resultCode: "2005", resultMsg: "Checksum provided is invalid" } });
  await assert.rejects(paytm.validateCredentials(creds), ProviderAuthError);
  reply({}, 403);
  await assert.rejects(paytm.validateCredentials(creds), ProviderAuthError);
});
