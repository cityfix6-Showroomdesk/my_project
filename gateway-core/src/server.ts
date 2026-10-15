import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { pool } from "./db.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardApiRoutes } from "./routes/dashboardApi.js";
import { adminRoutes } from "./routes/admin.js";
import { dashboardUiRoutes } from "./routes/dashboardUi.js";
import { cleanupAuth } from "./sessions.js";
import { billingRoutes, adminBillingRoutes } from "./routes/billing.js";
import { startBillingWorker } from "./billing.js";
import { orderRoutes } from "./routes/orders.js";
import { paymentAccountRoutes } from "./routes/paymentAccounts.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { providerRoutes } from "./routes/providers.js";
import { startReconciler } from "./reconciler.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { startWebhookWorker } from "./webhookWorker.js";
import { expireStaleOrders } from "./orderService.js";

const app = Fastify({ logger: true, bodyLimit: 100_000, trustProxy: true });

await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});

app.setErrorHandler((err, _req, reply) => {
  app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: { code: "server_error" } });
});

await app.register(authRoutes);
await app.register(dashboardApiRoutes);
await app.register(adminRoutes);
await app.register(billingRoutes);
await app.register(adminBillingRoutes);
await app.register(dashboardUiRoutes);
await app.register(orderRoutes);
await app.register(paymentAccountRoutes);
await app.register(providerRoutes);
await app.register(webhookRoutes);
await app.register(checkoutRoutes);

startReconciler(app.log);
startWebhookWorker(app.log);
startBillingWorker(app.log);
setInterval(() => cleanupAuth().catch((e) => app.log.error(e)), 3_600_000);
setInterval(() => expireStaleOrders().catch((e) => app.log.error(e)), 30_000);

await app.listen({ port: config.port, host: "0.0.0.0" });
