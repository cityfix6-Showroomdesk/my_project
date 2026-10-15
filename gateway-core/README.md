# gateway-core — Module 1: Foundation

> **Updated in Module 5a:** the open `/v1/merchants/signup` is removed. Accounts come from `/auth/signup`, and API keys are
> created in the dashboard. Writes that move money or change trust (payment accounts, provider connections, webhook endpoints,
> mark-paid, key management) are **dashboard-only** and need a recent step-up. Examples below that call those with an API key
> now return `403 dashboard_only`; see the Module 5a section for the session-based way.

## Run
    cp .env.example .env
    docker compose up -d
    npm install
    npm run migrate
    npm run dev

## Try it
    # 1. Create a merchant (returns a test API key once)
    curl -s localhost:3000/v1/merchants/signup -H 'content-type: application/json' \
      -d '{"email":"me@shop.com","business_name":"My Shop"}'

    # 2. Create an order (amount is in paise: 49900 = ₹499)
    curl -s localhost:3000/v1/orders -H "Authorization: Bearer sk_test_..." \
      -H 'content-type: application/json' -H 'Idempotency-Key: order-1001-attempt-1' \
      -d '{"amount":49900,"reference":"order-1001","customer":{"phone":"9876543210"}}'

    # 3. Repeat the same call: same order back, header Idempotent-Replayed: true
    # 4. Fetch / list
    curl -s localhost:3000/v1/orders/ord_... -H "Authorization: Bearer sk_test_..."
    curl -s "localhost:3000/v1/orders?status=created&limit=10" -H "Authorization: Bearer sk_test_..."

## Next modules
2. Merchant payment accounts (own VPA, verified) + hosted checkout page
3. Payment verification adapters + reconciliation job
4. HMAC-signed webhooks with retries
5. Merchant auth (password, 2FA) + dashboard
6. Subscription billing

---
# Module 2: Payment accounts + hosted checkout

Extra env: `ADMIN_TOKEN` (long random string). Then `npm install && npm run migrate`.

    # Add the merchant's own UPI ID (first one becomes the default)
    curl -s localhost:3000/v1/payment-accounts -H "Authorization: Bearer sk_test_..." \
      -H 'content-type: application/json' -d '{"vpa":"myshop@okicici","payee_name":"My Shop"}'

    # Interim verification by an operator (live orders require a verified account)
    curl -s -X POST localhost:3000/admin/payment-accounts/acc_.../verify \
      -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"result":"verified"}'

Create an order, open its `checkout_url` in a browser. In test mode the page has a
"Simulate successful payment" button, so you can walk created -> pending -> paid end to end.

---
# Module 3: Payment verification

New env: `MASTER_KEY` (required, encrypts provider credentials), `PUBLIC_BASE_URL`. Then `npm run migrate`.

    # Connect the merchant's OWN Razorpay account (validated against Razorpay, stored AES-256-GCM encrypted)
    curl -s localhost:3000/v1/provider-connections -H "Authorization: Bearer sk_test_..." \
      -H 'content-type: application/json' \
      -d '{"provider":"razorpay","key_id":"rzp_test_...","key_secret":"...","webhook_secret":"..."}'
    # -> returns webhook_url; add it in Razorpay's dashboard with the same secret

    # Orders now get a single-use fixed-amount Razorpay QR automatically; GET /v1/orders/:id shows "confirmation":"automatic"
    # Orders on a raw UPI ID: merchant confirms after seeing the bank credit
    curl -s -X POST localhost:3000/v1/orders/ord_.../mark-paid -H "Authorization: Bearer sk_test_..." \
      -H 'content-type: application/json' -d '{"utr":"412345678901"}'

    # Things needing merchant attention: wrong amount, late, paid twice
    curl -s "localhost:3000/v1/payments?match_status=late" -H "Authorization: Bearer sk_test_..."

## How the modules are wired
    POST /v1/orders (M1) -> resolvePayee (M2 accounts) -> verifier.prepare (M3, provider QR) -> order row
    customer opens /pay/:token (M2) -> shows provider QR / UPI link
    detection, three independent paths, all idempotent, all end in ONE function:
       checkout status poll  \
       provider webhook       >-> checkOrder -> verifier.fetchPayments -> recordProviderPayment (settlement.ts)
       background reconciler /
       merchant mark-paid / test-mode simulate -----------------------> recordProviderPayment
    recordProviderPayment, one DB transaction:
       lock order -> decideOutcome (matching.ts) -> payments row -> transitionOrder (M1) -> events outbox row
    events outbox ("order.paid", "payment.flagged") -> drained by Module 4 webhooks

## Rules the money logic enforces (see test/module3.test.ts)
- Only a CAPTURED payment for the EXACT amount on an OPEN order marks it paid.
- Wrong amount, late payment, or second payment on a paid order: recorded + flagged (`payment.flagged` event), never auto-completed.
- Webhook payloads are never trusted for money; they only trigger a re-fetch from the provider.
- Same provider payment arriving via poll, webhook and retry is counted once (unique provider payment id).

---
# Module 4: Webhooks to merchants

Run `npm run migrate`. For local development only, set `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` so you can point
an endpoint at `http://localhost:4000/hook`. In production leave it off (it is the SSRF guard).

    # Register an endpoint (secret shown ONCE). Omit "events" to receive everything.
    curl -s localhost:3000/v1/webhook-endpoints -H "Authorization: Bearer sk_test_..." \
      -H 'content-type: application/json' -d '{"url":"https://shop.example.com/hooks/pay","events":["order.paid","order.expired"]}'

    # Send a real signed test event and see what your server answered
    curl -s -X POST localhost:3000/v1/webhook-endpoints/whe_.../test -H "Authorization: Bearer sk_test_..."

    # Delivery log (every attempt: status, error, duration, response snippet) and manual replay
    curl -s "localhost:3000/v1/webhook-deliveries?status=failed" -H "Authorization: Bearer sk_test_..."
    curl -s localhost:3000/v1/webhook-deliveries/whd_... -H "Authorization: Bearer sk_test_..."
    curl -s -X POST localhost:3000/v1/webhook-deliveries/whd_.../replay -H "Authorization: Bearer sk_test_..."

    # Rotate the signing secret with a 24h overlap; catch up on missed events
    curl -s -X POST localhost:3000/v1/webhook-endpoints/whe_.../rotate-secret -H "Authorization: Bearer sk_test_..."
    curl -s "localhost:3000/v1/events?type=order.paid&limit=20" -H "Authorization: Bearer sk_test_..."

## What the merchant's server receives
    POST <their url>     Content-Type: application/json
    X-Gateway-Signature: t=1760000000,v1=<hex hmac>
    X-Gateway-Event-Id: evt_42    X-Gateway-Delivery-Id: whd_...    X-Gateway-Delivery-Attempt: 1
    { "id":"evt_42", "object":"event", "api_version":"2026-10-01", "type":"order.paid", "created":1760000000,
      "mode":"live", "data": { "order_id":"ord_...", "reference":"order-1001", "amount":49900, "currency":"INR", ... } }

Event types: `order.paid`, `order.expired`, `payment.flagged` (wrong amount / late / paid twice).

### Verify it (give merchants this snippet). Always verify against the RAW body.
    // Node
    import { createHmac, timingSafeEqual } from "node:crypto";
    export function verify(rawBody, header, secret, toleranceSec = 300) {
      const parts = header.split(",");
      const t = Number(parts.find(p => p.startsWith("t="))?.slice(2));
      if (!Number.isInteger(t) || Math.abs(Date.now()/1000 - t) > toleranceSec) return false;
      const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
      return parts.filter(p => p.startsWith("v1=")).some(p => {
        const got = Buffer.from(p.slice(3)); return got.length === want.length && timingSafeEqual(got, want); });
    }
    # Python
    import hmac, hashlib, time
    def verify(raw_body: bytes, header: str, secret: str, tolerance=300) -> bool:
        parts = header.split(",")
        t = next((p[2:] for p in parts if p.startswith("t=")), None)
        if not t or abs(time.time() - int(t)) > tolerance: return False
        want = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
        return any(hmac.compare_digest(p[3:], want) for p in parts if p.startswith("v1="))

Delivery is **at-least-once**: dedupe on `id` (`evt_...`), and make your handler idempotent. Respond 2xx fast; do the work after.

## Delivery guarantees
- Retries (9 attempts over ~44h): 10s, 1m, 5m, 30m, 2h, 6h, 12h, 24h, +/-10% jitter. Then the delivery is `failed` and replayable.
- 5 deliveries in a row that exhaust every retry auto-disables the endpoint (re-enable with PATCH `{"status":"active"}`).
- Anything older than our retries is still available via `GET /v1/events`.

## The whole system, wired (Modules 1-4)
    POST /v1/orders (M1) -> resolve payee (M2) -> provider QR (M3) -> order row
    /pay/:token (M2) shows QR; poll + webhook + reconciler (M3) detect money
        -> recordProviderPayment (M3): lock order, match, payments row, order -> paid (M1 state machine)
           ... and writes an `events` outbox row IN THE SAME TRANSACTION
    expiry (M1 sweep OR M2 page load OR M3) -> expireOrder (M1): order -> expired + `order.expired` event, same transaction
    webhook worker (M4): events -> deliveries (fan-out per subscribed endpoint of that merchant+mode)
        -> signed POST via SSRF-guarded client -> attempt log -> retry / fail / auto-disable

---
# Module 5a: Accounts, sessions, 2FA, KYC (security backend; dashboard UI is 5b)

`npm run migrate`. In dev, emails are printed in the server log: copy the verification / reset link from there.
Production needs a real mail provider in `src/mailer.ts` (one function) and `NODE_ENV=production` + `PUBLIC_BASE_URL=https://your.domain`.

    # 1. Sign up, then verify using the token printed in the server log
    curl -s localhost:3000/auth/signup -H 'content-type: application/json' \
      -d '{"email":"me@shop.com","password":"tall giraffe river 42","business_name":"My Shop"}'
    curl -s localhost:3000/auth/verify-email -H 'content-type: application/json' -d '{"token":"..."}'

    # 2. Log in (cookie jar). The response contains csrf_token; send it as x-csrf-token on every non-GET call.
    curl -s -c jar localhost:3000/auth/login -H 'content-type: application/json' -d '{"email":"me@shop.com","password":"tall giraffe river 42"}'
    #    With 2FA on, first answer is 401 totp_required: repeat with "code":"123456" (or a recovery code).

    # 3. Confirm identity (valid 10 minutes) before sensitive actions
    curl -s -b jar localhost:3000/auth/step-up -H 'x-csrf-token: <csrf>' -H 'content-type: application/json' -d '{"password":"tall giraffe river 42"}'

    # 4. Mint an API key (shown once), then use it exactly as before for orders etc.
    curl -s -b jar localhost:3000/dashboard/api-keys -H 'x-csrf-token: <csrf>' -H 'content-type: application/json' -d '{"mode":"test"}'

    # 2FA:  POST /auth/2fa/setup -> scan qr_svg / otpauth_uri;  POST /auth/2fa/enable {"code"} -> 10 recovery codes (once)
    # KYC:  POST /dashboard/kyc {...}  ->  operator: GET /admin/kyc/pending, POST /admin/merchants/:id/kyc {"result":"approved"}  (x-admin-token)
    #       approval unlocks live mode: POST /auth/mode {"mode":"live"} and live API keys.

## What each protection stops
| Control | Stops |
|---|---|
| scrypt hashes, identical work for unknown emails | database leak -> passwords; probing which emails are registered |
| 5 bad attempts -> 15 min lock; per-IP rate limits | password guessing |
| Session id = sha256(cookie); HttpOnly + SameSite=Strict (+Secure in prod) | session theft from a DB leak or XSS reading the cookie |
| CSRF token + Origin check on every session write | other websites making your logged-in merchant act |
| TOTP: each code once, +/-30s; hashed one-time recovery codes | shoulder-surfed or replayed codes; lockout recovery |
| Disabling 2FA needs password AND code | a stolen session stripping 2FA |
| Step-up (10 min) + dashboard-only for payout account, provider keys, webhook URL/secret, API keys, mark-paid | a leaked API key redirecting money, minting keys, or marking orders paid for free goods |
| Password reset/change revokes other sessions; reset links are single use | attacker staying logged in after the owner recovers the account |
| KYC gate on live mode + keyword risk flags for a human reviewer | prohibited businesses reaching live |

## Module wiring (1-5a)
    every protected route -> authenticateRequest():  API key (server)  OR  session cookie (person)  -> same AuthContext
    M1 orders / M2 accounts+checkout / M3 providers / M4 webhooks all use it; their sensitive writes call requireStepUp / dashboardOnly
    Login -> session (mode test|live) -> mode decides which data the dashboard sees; live needs kyc_status=approved
    KYC approval (admin) -> live API keys + live mode -> live orders (M1) -> verified accounts only (M2) -> events (M3/M4)

---
# Module 5b: Dashboard UI

`npm run dev`, then open **http://localhost:3000/dashboard/**. Sign up, copy the verification link from the server log, log in.
Pages: Overview, Orders (create a test order, mark raw-UPI payments paid), Payout (UPI IDs, Razorpay), Webhooks (endpoints, test, rotate, delivery log, replay),
API keys, Security (2FA), KYC. Test/live switch is in the top bar (live needs approved KYC).
Sensitive actions ask for your password or 2FA code once, then stay unlocked for 10 minutes.
It is one static file (`public/dashboard.html`) with no build step and no third-party scripts; it talks only to this server.

---
# Module 6: Subscription billing

`npm run migrate`. **Placeholder plan prices** are in the `plans` table (Starter ₹499, Growth ₹1,499, Scale ₹4,999 + 18% GST): edit them.

## One-time setup: you are your own first merchant
1. Sign up normally, get KYC approved (`/admin/merchants/:id/kyc`), connect YOUR Razorpay (or add your UPI ID) in the dashboard.
2. Put that merchant's id in `PLATFORM_MERCHANT_ID`, and set `PLATFORM_LEGAL_NAME / GSTIN / ADDRESS / STATE_CODE`. Dev: leave `BILLING_MODE=test` (sandbox QR + "simulate payment" button); production: `live`.

## Lifecycle
    signup -> trialing (14 days, TRIAL_DAYS) -> trial ends -> invoice issued (GST, gapless number), status past_due, due in 5 days
    paid (merchant pays the invoice's pay link) -> active, period +1 month -> next renewal invoice ...
    unpaid 5 days + 2 days grace -> suspended: NEW LIVE orders return 402 subscription_inactive.
    Existing orders, payment detection, webhooks, dashboard and test mode keep working. Paying the open invoice resumes service.
    Over the plan's monthly live-order limit -> 402 plan_limit_reached.  Cancel -> ends at period end.

## Endpoints (dashboard session)
    GET  /dashboard/billing                      plan, usage, plans, invoices, billing profile
    PUT  /dashboard/billing/profile              legal name, GSTIN, state (decides CGST+SGST vs IGST)
    POST /dashboard/billing/plan {plan_code}     step-up; trial: now, paid: next invoice
    POST /dashboard/billing/cancel | resume      step-up
    POST /dashboard/billing/invoices/:id/pay     -> {checkout_url}  (an order on YOUR merchant account)
    GET  /dashboard/billing/invoices/:id/html    printable GST tax invoice
    Operator: POST /admin/invoices/:id/mark-paid, POST /admin/merchants/:id/subscription {action: extend_trial|suspend|reinstate}

## How it is wired
    M5 signup starts the trial.   M1 POST /v1/orders asks checkOrderEntitlement() (live only; test + platform account exempt).
    Invoice pay link = createOrder() on the platform merchant (M1) -> M2 checkout page -> M3 detects payment -> order paid
    billing worker (every 60s) sees "invoice's order is paid" -> invoice paid -> subscription active. No coupling to M3 internals.
    M5 /dashboard/summary now includes billing state.

---
# Paytm adapter
Merchant's own Paytm Payments account: **MID** + **merchant key**; Dynamic QR must be enabled by Paytm. Connect it in the dashboard (Payout page).
Each order gets a Paytm Dynamic QR (10-minute life, so order expiry is capped at 10 minutes). Payment is found by polling Paytm's Transaction Status API
and settled by the same `recordProviderPayment` as every provider. Hosts are overridable: `PAYTM_TEST_BASE_URL`, `PAYTM_LIVE_BASE_URL` (confirm in your Paytm dashboard).
Run `npm install` (adds paytmchecksum) and `npm run migrate` (007).
