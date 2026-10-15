# gateway-core: start here

A SaaS payment-gateway layer: merchants' customers pay the MERCHANT directly; this software creates orders, shows the
pay page, detects payment, sends signed webhooks, and bills merchants a monthly subscription. It never holds funds.

## Run it (first time)
    cp .env.example .env          # then fill in MASTER_KEY and ADMIN_TOKEN (commands are in the file)
                                  # for local testing also set ALLOW_PRIVATE_WEBHOOK_TARGETS=true
    docker compose up -d          # Postgres
    npm install
    npm run migrate
    npm test                      # 34 logic tests
    npm run dev                   # http://localhost:3000/dashboard/

Sign up -> copy the verification link printed in the terminal -> log in -> create a test API key -> create a test order
-> open its pay page -> "Simulate successful payment".

## Modules and where they live
| # | Module | Files |
|---|--------|-------|
| 1 | Orders, API keys, idempotency, state machine | orderService.ts, orderStateMachine.ts, routes/orders.ts, apiKeys.ts |
| 2 | Payout accounts + hosted checkout | routes/paymentAccounts.ts, routes/checkout.ts, checkoutPage.ts, upi.ts |
| 3 | Payment verification (Razorpay), reconciler, settlement | verifiers/, settlement.ts, matching.ts, reconciler.ts, routes/providers.ts |
| 4 | Signed webhooks, retries, delivery log | webhookWorker.ts, webhookSign.ts, safeHttp.ts, routes/webhooks.ts, events.ts |
| 5a | Accounts, sessions, 2FA, KYC, admin | routes/auth.ts, authContext.ts, sessions.ts, password.ts, totp.ts, routes/dashboardApi.ts |
| 5b | Dashboard UI | public/dashboard.html, routes/dashboardUi.ts |
| 6 | Subscription billing + GST invoices | billing.ts, billingPolicy.ts, gst.ts, routes/billing.ts |
| 7 | Paytm provider (Dynamic QR + status polling) | verifiers/paytm.ts, migration 007 |

Each module's README section explains its endpoints and how it connects to the others.

## Known state (be honest with yourself)
- Logic is unit-tested; the full app has NOT been run against Postgres or Razorpay yet. Expect first-run fixes.
- Dashboard now has a Billing tab and a Paytm connect form. No refunds / exports. Email only prints to the log.
- Paytm and Razorpay adapters are built from their docs and unit-tested with fakes; neither has been run against the real provider.
- After pulling an update: `npm install` then `npm run migrate`.
- Before real money: lawyer (funds structure), accountant (GST, SAC code), security review, backups + monitoring.
