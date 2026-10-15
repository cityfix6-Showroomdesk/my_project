import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!config.adminToken) { reply.code(404).send(); return false; }
  const a = Buffer.from(String(req.headers["x-admin-token"] ?? "")), b = Buffer.from(config.adminToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) { reply.code(401).send({ error: { code: "unauthorized" } }); return false; }
  return true;
}
