import test from "node:test";
import assert from "node:assert/strict";
import { computeTax, financialYear, formatInvoiceNumber, addMonths, GSTIN_STATE_RE } from "../src/gst.js";
import { planTransition, entitlement, DUE_DAYS, GRACE_DAYS } from "../src/billingPolicy.js";

test("GST: same state splits 9%+9%, other state is 18% IGST, parts always sum", () => {
  assert.deepEqual(computeTax(49900, "10", "10"), { cgst: 4491, sgst: 4491, igst: 0, total: 58882 });
  assert.deepEqual(computeTax(49900, "10", "27"), { cgst: 0, sgst: 0, igst: 8982, total: 58882 });
  const odd = computeTax(10050, "10", "10");               // tax 1809 is odd: split must not lose a paisa
  assert.equal(odd.cgst + odd.sgst, 1809); assert.equal(odd.total, 10050 + 1809);
  for (const p of [1, 99, 49900, 149900, 499900]) { const t = computeTax(p, "10", "10"); assert.equal(t.cgst + t.sgst + p, t.total); }
});

test("financial year follows the Indian Apr-Mar year in IST, and invoice numbers fit GST's 16-char limit", () => {
  assert.equal(financialYear(new Date("2026-10-11T00:00:00Z")), "2627");
  assert.equal(financialYear(new Date("2027-03-31T10:00:00Z")), "2627");
  assert.equal(financialYear(new Date("2027-03-31T19:00:00Z")), "2728"); // already 1 Apr in IST
  assert.equal(financialYear(new Date("2027-04-01T00:00:00Z")), "2728");
  assert.equal(formatInvoiceNumber("2627", 1), "INV/2627/000001");
  assert.ok(formatInvoiceNumber("2627", 999999).length <= 16);
});

test("addMonths clamps month ends and crosses years", () => {
  assert.equal(addMonths(new Date("2027-01-31T00:00:00Z"), 1).toISOString().slice(0, 10), "2027-02-28");
  assert.equal(addMonths(new Date("2028-01-31T00:00:00Z"), 1).toISOString().slice(0, 10), "2028-02-29");
  assert.equal(addMonths(new Date("2026-12-15T00:00:00Z"), 1).toISOString().slice(0, 10), "2027-01-15");
  assert.ok(GSTIN_STATE_RE.test("10") && GSTIN_STATE_RE.test("38") && !GSTIN_STATE_RE.test("00") && !GSTIN_STATE_RE.test("40"));
});

test("subscription lifecycle decisions", () => {
  const now = new Date("2026-11-01T00:00:00Z"), past = new Date("2026-10-31T00:00:00Z"), future = new Date("2026-11-10T00:00:00Z");
  const s = (o: any) => ({ status: "active", trial_ends_at: null, current_period_end: null, grace_ends_at: null, cancel_at_period_end: false, ...o });
  assert.equal(planTransition(s({ status: "trialing", trial_ends_at: future }), now, false), "none");
  assert.equal(planTransition(s({ status: "trialing", trial_ends_at: past }), now, false), "generate_invoice");
  assert.equal(planTransition(s({ status: "trialing", trial_ends_at: past }), now, true), "none");           // never a second invoice
  assert.equal(planTransition(s({ status: "active", current_period_end: past }), now, false), "generate_invoice");
  assert.equal(planTransition(s({ status: "active", current_period_end: future }), now, false), "none");
  assert.equal(planTransition(s({ status: "active", current_period_end: past, cancel_at_period_end: true }), now, false), "cancel");
  assert.equal(planTransition(s({ status: "past_due", grace_ends_at: future }), now, true), "none");        // still in grace: service continues
  assert.equal(planTransition(s({ status: "past_due", grace_ends_at: past }), now, true), "suspend");
  assert.equal(planTransition(s({ status: "suspended", grace_ends_at: past }), now, true), "none");
  assert.equal(planTransition(s({ status: "canceled" }), now, false), "none");
  assert.ok(DUE_DAYS > 0 && GRACE_DAYS > 0);
});

test("entitlement: suspended/canceled and over-limit are blocked; everything else allowed", () => {
  assert.equal(entitlement("active", 10, 500), null);
  assert.equal(entitlement("trialing", 0, 500), null);
  assert.equal(entitlement("past_due", 499, 500), null);                       // grace period keeps working
  assert.equal(entitlement("past_due", 500, 500)?.code, "plan_limit_reached");
  assert.equal(entitlement("suspended", 0, 500)?.code, "subscription_inactive");
  assert.equal(entitlement("canceled", 0, 500)?.code, "subscription_inactive");
});
