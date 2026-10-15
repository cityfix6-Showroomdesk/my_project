import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * SSRF defence. Merchants choose the webhook URL, so without this they could make OUR servers call
 * our own database host, cloud metadata (169.254.169.254) or internal admin tools.
 * Two layers: validate when the URL is saved, and validate again at connect time (defeats DNS rebinding).
 */

export class WebhookUrlError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const V4_BLOCKED: Array<[number, number, number]> = [ // [base as int, prefix length]
  [0x00000000, 8, 0], [0x0a000000, 8, 0], [0x64400000, 10, 0], [0x7f000000, 8, 0], [0xa9fe0000, 16, 0],
  [0xac100000, 12, 0], [0xc0000000, 24, 0], [0xc0000200, 24, 0], [0xc0586300, 24, 0], [0xc0a80000, 16, 0],
  [0xc6120000, 15, 0], [0xc6336400, 24, 0], [0xcb007100, 24, 0], [0xe0000000, 3, 0], // 224/3: multicast + reserved + broadcast
];

function isPublicV4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const n = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  return !V4_BLOCKED.some(([base, bits]) => ((n ^ base) >>> (32 - bits)) === 0);
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/); // embedded IPv4 tail
  if (m) {
    const v = m[2].split(".").map(Number);
    if (v.some((n) => n > 255)) return null;
    s = `${m[1]}${((v[0] << 8) | v[1]).toString(16)}:${((v[2] << 8) | v[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}

function isPublicV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return false;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  if (g.slice(0, 6).every((x) => x === 0)) return false;                 // ::, ::1, v4-compatible
  if ((g[0] & 0xfe00) === 0xfc00) return false;                          // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false;                          // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return false;                          // multicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return false; // documentation, Teredo
  if (g[0] === 0x2002) return false;                                     // 6to4 can embed private v4
  if (g[0] === 0x0064 && g[1] === 0xff9b) return false;                  // NAT64
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false;
  return true;
}

export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? isPublicV4(ip) : v === 6 ? isPublicV6(ip) : false;
}

/** Hook for http(s).request: runs at CONNECT time, so a DNS answer that changes between check and use is still caught. */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: any, cb: any) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = (addrs as dns.LookupAddress[]).filter((a) => allowPrivate || isPublicAddress(a.address));
      if (!ok.length) return cb(new WebhookUrlError("blocked_address", "target resolves to a non-public address"));
      if (options?.all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    });
  };
}

export async function assertUrlAllowed(raw: string, allowPrivate: boolean): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new WebhookUrlError("invalid_url", "not a valid URL"); }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:"))
    throw new WebhookUrlError("scheme_not_allowed", "webhook URLs must use https");
  if (u.username || u.password) throw new WebhookUrlError("credentials_in_url", "do not put credentials in the URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new WebhookUrlError("invalid_url", "missing host");
  if (allowPrivate) return u;
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new WebhookUrlError("blocked_address", "address is not publicly routable");
    return u;
  }
  let addrs: dns.LookupAddress[];
  try { addrs = await dns.promises.lookup(host, { all: true }); }
  catch { throw new WebhookUrlError("unresolvable_host", "hostname does not resolve"); }
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address)))
    throw new WebhookUrlError("blocked_address", "hostname resolves to a non-public address");
  return u;
}

export interface PostResult { status: number; snippet: string }

/** POST JSON. Never follows redirects, caps total time, and keeps only the first 1 KB of the response. */
export async function postJson(
  url: string, body: string, headers: Record<string, string>, opts: { allowPrivate: boolean; timeoutMs: number }
): Promise<PostResult> {
  const u = await assertUrlAllowed(url, opts.allowPrivate);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise<PostResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const req = mod.request({
      hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || undefined, path: u.pathname + u.search,
      method: "POST", agent: false, lookup: guardedLookup(opts.allowPrivate) as any,
      headers: { ...headers, "content-length": Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      const done = () => finish(() => resolve({
        status: res.statusCode ?? 0,
        snippet: Buffer.concat(chunks).toString("utf8").slice(0, 1000).replace(/\u0000/g, ""),
      }));
      res.on("data", (d: Buffer) => { chunks.push(d); size += d.length; if (size >= 1000) { done(); res.destroy(); } });
      res.on("end", done);
      res.on("error", () => done());
    });
    const timer = setTimeout(() => { req.destroy(); finish(() => reject(new Error("timeout"))); }, opts.timeoutMs);
    req.on("error", (e) => finish(() => reject(e)));
    req.end(body);
  });
}
