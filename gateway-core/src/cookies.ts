export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    const name = i > 0 ? part.slice(0, i).trim() : "";
    if (!name) continue; // no name, no cookie
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore undecodable value */ }
  }
  return out;
}

export function serializeCookie(name: string, value: string, o: { maxAgeSec: number; secure: boolean }): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${o.maxAgeSec}${o.secure ? "; Secure" : ""}`;
}
