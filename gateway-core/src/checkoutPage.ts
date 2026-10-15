const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);
export const inr = (paise: number) =>
  "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface PageData {
  token: string;
  businessName: string;
  amountPaise: number;
  status: "pending" | "paid" | "expired" | "failed";
  secondsLeft: number;
  qrSvg: string;
  upiUri: string;
  apps: { label: string; href: string }[];
  autoConfirm: boolean; // false for raw-UPI orders: the merchant confirms, so we must not imply the page will update by itself
  testMode: boolean;
}

const CSS = `
:root{--bg:#f4f5f7;--card:#fff;--ink:#14171c;--mute:#667085;--line:#e4e7ec;--brand:#0f766e;--ok:#15803d;--bad:#b42318}
@media(prefers-color-scheme:dark){:root{--bg:#0c0f13;--card:#151a21;--ink:#eef1f5;--mute:#98a2b3;--line:#262d38;--brand:#2dd4bf;--ok:#4ade80;--bad:#f97066}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;display:grid;place-items:center;padding:16px}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;text-align:center}
.biz{color:var(--mute);font-size:14px}.amt{font-size:34px;font-weight:700;margin:4px 0 16px;letter-spacing:-.5px}
.qr{width:220px;height:220px;margin:0 auto 12px;background:#fff;border-radius:12px;padding:8px}.qr svg{width:100%;height:100%;display:block}
.hint{color:var(--mute);font-size:14px;margin:0 0 16px}
.btn{display:block;width:100%;padding:14px;border-radius:12px;border:0;background:var(--brand);color:#fff;font:600 16px inherit;text-decoration:none;cursor:pointer}
@media(prefers-color-scheme:dark){.btn{color:#042f2e}}
.btn.ghost{background:transparent;color:var(--mute);border:1px dashed var(--line);margin-top:10px;font-weight:500}
.intent{display:none;margin-bottom:12px}#app[data-mobile=true] .intent{display:block}#app[data-mobile=true] .qr{width:160px;height:160px}.apps{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}.app{padding:10px 4px;border:1px solid var(--line);border-radius:10px;color:var(--ink);text-decoration:none;font-size:13px;font-weight:600}.app:active{background:var(--line)}
.timer{margin-top:16px;font-size:14px;color:var(--mute)}.timer b{color:var(--ink);font-variant-numeric:tabular-nums}
.badge{display:inline-block;background:#fef0c7;color:#7a2e0e;border-radius:99px;padding:2px 10px;font-size:12px;margin-bottom:12px}
.panel{display:none}
#app[data-state=pending] .p-pay,#app[data-state=paid] .p-paid,#app[data-state=expired] .p-end,#app[data-state=failed] .p-end{display:block}
.icon{font-size:44px;line-height:1;margin-bottom:8px}.ok{color:var(--ok)}.bad{color:var(--bad)}
.foot{margin-top:20px;font-size:12px;color:var(--mute)}`;

const JS = `(function(){
var root=document.getElementById('app'),t=root.dataset.token,left=+root.dataset.left,st=root.dataset.state,cd=document.getElementById('cd');
if(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||matchMedia('(pointer:coarse)').matches)root.dataset.mobile='true';
function fmt(s){var m=Math.floor(s/60),x=s%60;return m+':'+(x<10?'0':'')+x}
function set(s){st=s;root.dataset.state=s}
function done(){return st!=='pending'}
function poll(){if(done())return;fetch('/pay/'+t+'/status',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){left=j.seconds_left;if(j.status!==st)set(j.status==='created'?'pending':j.status)}).catch(function(){})}
setInterval(function(){if(done())return;left=Math.max(0,left-1);cd.textContent=fmt(left);if(left===0)poll()},1000);
setInterval(function(){if(!document.hidden)poll()},3000);
document.addEventListener('visibilitychange',poll);
var sim=document.getElementById('sim');
if(sim)sim.addEventListener('click',function(){fetch('/pay/'+t+'/simulate',{method:'POST'}).then(poll)});
cd.textContent=fmt(left);
})();`;

export function renderCheckout(d: PageData, nonce: string): string {
  const test = d.testMode ? `<div class="badge">TEST MODE · no real money</div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Pay ${esc(inr(d.amountPaise))} · ${esc(d.businessName)}</title><style nonce="${nonce}">${CSS}</style></head>
<body><main class="card" id="app" data-token="${esc(d.token)}" data-left="${d.secondsLeft}" data-state="${d.status}">
${test}<div class="biz">${esc(d.businessName)}</div><div class="amt">${esc(inr(d.amountPaise))}</div>
<section class="panel p-pay">
  ${d.status === "pending" ? `<div class="intent"><a class="btn" href="${esc(d.upiUri)}">Pay with any UPI app</a>${d.apps.length ? `<div class="apps">${d.apps.map((a) => `<a class="app" href="${esc(a.href)}">${esc(a.label)}</a>`).join("")}</div>` : ""}</div><div class="qr" aria-label="UPI QR code">${d.qrSvg}</div>` : ""}
  <p class="hint">${d.autoConfirm ? "Scan with any UPI app, or tap a button on your phone. This page updates by itself once you have paid." : "Scan or tap to pay. The merchant confirms your payment, so it can take a little while to show here."}</p>
  ${d.testMode ? `<button class="btn ghost" id="sim" type="button">Simulate successful payment (test only)</button>` : ""}
  <div class="timer">Expires in <b id="cd">--:--</b></div>
</section>
<section class="panel p-paid"><div class="icon ok">✓</div><h2>Payment received</h2><p class="hint">You can close this page.</p></section>
<section class="panel p-end"><div class="icon bad">✕</div><h2>This payment link is no longer active</h2><p class="hint">Please go back to the store and start again.</p></section>
<div class="foot">Money goes directly to the merchant.</div>
</main><script nonce="${nonce}">${JS}</script></body></html>`;
}

export function renderMessage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head><body style="font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center;padding:16px"><h2>${esc(title)}</h2><p>${esc(body)}</p></div></body></html>`;
}
