import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const html = readFileSync(join(process.cwd(), "public", "dashboard.html"), "utf8");

/** Serves the dashboard with a fresh CSP nonce per request: no inline script runs without it, and nothing loads from other sites. */
export async function dashboardUiRoutes(app: FastifyInstance) {
  const send = async (_req: unknown, reply: any) => {
    const n = randomBytes(16).toString("base64");
    return reply
      .header("content-security-policy", `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`)
      .header("cache-control", "no-store").header("x-frame-options", "DENY")
      .header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer")
      .type("text/html; charset=utf-8").send(html.replaceAll("__NONCE__", n));
  };
  app.get("/dashboard", send);
  app.get("/dashboard/", send);
}
