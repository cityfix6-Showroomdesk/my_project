export const GST_RATE_PCT = 18;
export const SAC_CODE = "998439"; // SaaS/online services. Confirm the right SAC for your service with your CA.

/** Paise in, paise out. Same state: 9%+9% (CGST+SGST). Different state: 18% IGST. Rounds once, then splits, so parts always sum. */
export function computeTax(subtotal: number, supplierState: string, customerState: string) {
  const tax = Math.round((subtotal * GST_RATE_PCT) / 100);
  if (supplierState === customerState) {
    const cgst = Math.floor(tax / 2);
    return { cgst, sgst: tax - cgst, igst: 0, total: subtotal + tax };
  }
  return { cgst: 0, sgst: 0, igst: tax, total: subtotal + tax };
}

/** Indian financial year (Apr-Mar, by IST date) as "2627" for 2026-27. */
export function financialYear(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${String(y % 100).padStart(2, "0")}${String((y + 1) % 100).padStart(2, "0")}`;
}

/** GST allows at most 16 characters: INV/2627/000001 is 15. */
export const formatInvoiceNumber = (fy: string, n: number) => `INV/${fy}/${String(n).padStart(6, "0")}`;

/** Calendar-month add that clamps (31 Jan + 1 month = 28/29 Feb), UTC. */
export function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + n);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

export const GSTIN_STATE_RE = /^(0[1-9]|[12][0-9]|3[0-8]|97|99)$/;
