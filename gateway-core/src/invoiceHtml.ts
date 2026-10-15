const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const inr = (p: number | string) => "₹" + (Number(p) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d: Date | string) => new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });

/** Printable GST tax invoice. Uses the snapshots stored on the invoice, never live profile data. */
export function renderInvoice(i: any, nonce: string): string {
  const s = i.supplier, c = i.customer;
  const tax = [["CGST 9%", i.cgst_paise], ["SGST 9%", i.sgst_paise], ["IGST 18%", i.igst_paise]].filter(([, v]) => Number(v) > 0);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Invoice ${esc(i.number)}</title>
<style nonce="${nonce}">body{font:14px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#111}table{width:100%;border-collapse:collapse;margin:16px 0}
th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}.r{text-align:right}.m{color:#555;font-size:12px}h1{margin:0}.tot td{font-weight:700;border-top:2px solid #111}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;border:1px solid #111;font-size:12px}@media print{.np{display:none}}</style></head><body>
<h1>Tax Invoice</h1><p><b>${esc(i.number)}</b> <span class="badge">${esc(i.status)}</span><br>Date: ${day(i.created_at)} · Due: ${day(i.due_at)}</p>
<table><tr><td><b>${esc(s.name)}</b><br>${esc(s.address)}<br>GSTIN: ${esc(s.gstin || "-")}<br>State code: ${esc(s.state_code)}</td>
<td><b>Billed to</b><br>${esc(c.name)}<br>${esc(c.address || "")}<br>GSTIN: ${esc(c.gstin || "unregistered")}<br>Place of supply: ${esc(c.state_code)}</td></tr></table>
<table><tr><th>Description</th><th>SAC</th><th class="r">Taxable value</th></tr><tr><td>${esc(i.description)}</td><td>${esc(s.sac)}</td><td class="r">${inr(i.subtotal_paise)}</td></tr>
${tax.map(([l, v]) => `<tr><td colspan=2>${esc(l)}</td><td class="r">${inr(v as number)}</td></tr>`).join("")}
<tr class="tot"><td colspan=2>Total</td><td class="r">${inr(i.total_paise)}</td></tr></table>
<p class="m">This is a computer-generated invoice. ${i.paid_at ? "Paid on " + day(i.paid_at) + "." : ""}</p><p class="np"><button onclick="print()">Print / Save as PDF</button></p></body></html>`
    .replace("<button onclick=\"print()\">", `<button id="pr">`) + `<script nonce="${nonce}">document.getElementById("pr")?.addEventListener("click",()=>print())</script>`;
}
