export const VPA_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

export interface UpiLinkInput {
  vpa: string;
  payeeName: string;
  amountPaise: number;
  orderId: string;
  note?: string;
}

/** Builds a standard UPI deep link (also the payload encoded in the QR). */
export function buildUpiUri(i: UpiLinkInput): string {
  const enc = encodeURIComponent;
  const rupees = (i.amountPaise / 100).toFixed(2);
  const tr = i.orderId.replace(/[^A-Za-z0-9]/g, "").slice(0, 35); // many apps reject symbols in tr
  const parts = [
    `pa=${enc(i.vpa).replace(/%40/g, "@")}`,
    `pn=${enc(i.payeeName.slice(0, 99))}`,
    `am=${rupees}`,
    "cu=INR",
    `tn=${enc((i.note ?? `Order ${tr}`).slice(0, 80))}`,
    `tr=${enc(tr)}`,
  ];
  return `upi://pay?${parts.join("&")}`;
}

/**
 * Buttons for opening a specific UPI app. Android resolves the generic upi:// link to a chooser, but iOS has no system chooser,
 * so each app needs its own scheme. Only built from a plain "upi://pay?..." link; anything else gets just the generic button.
 */
export function upiAppLinks(uri: string): { label: string; href: string }[] {
  const prefix = "upi://pay?";
  if (!uri.startsWith(prefix)) return [];
  const q = uri.slice(prefix.length);
  return [
    { label: "Google Pay", href: `gpay://upi/pay?${q}` },
    { label: "PhonePe", href: `phonepe://pay?${q}` },
    { label: "Paytm", href: `paytmmp://pay?${q}` },
  ];
}
