import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  databaseUrl: req("DATABASE_URL"),
  port: Number(process.env.PORT ?? 3000),
  masterKey: req("MASTER_KEY"), // 32 bytes base64; encrypts provider credentials
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
  // DEV ONLY: lets webhooks target http:// and localhost. Never enable in production (SSRF).
  allowPrivateWebhookTargets: process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === "true",
  appName: process.env.APP_NAME ?? "Gateway", // shown in authenticator apps
  isProduction: process.env.NODE_ENV === "production",
  cookieSecure: process.env.NODE_ENV === "production", // Secure cookies need https
  // Billing: YOU bill merchants through your own gateway. Create a normal merchant for yourself, get KYC approved,
  // connect your payout account, then put its id here. Use "test" while developing (sandbox QR + simulate button).
  platformMerchantId: process.env.PLATFORM_MERCHANT_ID as string,
  billingMode: (process.env.BILLING_MODE === "live" ? "live" : "test") as "live" | "test",
  platformLegalName: process.env.PLATFORM_LEGAL_NAME ?? "Your Company Pvt Ltd",
  platformGstin: process.env.PLATFORM_GSTIN ?? "",
  platformAddress: process.env.PLATFORM_ADDRESS ?? "",
  platformStateCode: process.env.PLATFORM_STATE_CODE ?? "10", // 10 = Bihar; use your registered state
  trialDays: Number(process.env.TRIAL_DAYS ?? 14),
  adminToken: process.env.ADMIN_TOKEN, // unset = admin routes disabled
  checkoutBaseUrl: process.env.CHECKOUT_BASE_URL ?? "http://localhost:3000/pay",
};
