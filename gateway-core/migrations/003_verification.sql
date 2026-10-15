-- Provider connections: merchant's own PG credentials, encrypted at rest (AES-256-GCM)
CREATE TABLE provider_connections (
  id                 TEXT PRIMARY KEY,
  merchant_id        TEXT NOT NULL REFERENCES merchants(id),
  provider           TEXT NOT NULL CHECK (provider IN ('razorpay')),
  mode               TEXT NOT NULL CHECK (mode IN ('test','live')),
  credentials_enc    TEXT NOT NULL,
  webhook_secret_enc TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid','disabled')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, provider, mode)
);

-- A merchant account can now be a provider-backed one (auto-confirmed) as well as a raw UPI ID
ALTER TABLE merchant_accounts DROP CONSTRAINT merchant_accounts_type_check;
ALTER TABLE merchant_accounts ADD CONSTRAINT merchant_accounts_type_check CHECK (type IN ('upi_vpa','razorpay'));
ALTER TABLE merchant_accounts ALTER COLUMN vpa DROP NOT NULL;
ALTER TABLE merchant_accounts ADD COLUMN connection_id TEXT REFERENCES provider_connections(id);

-- Orders remember how they will be confirmed
ALTER TABLE orders
  ADD COLUMN provider          TEXT NOT NULL DEFAULT 'direct' CHECK (provider IN ('direct','razorpay','sandbox')),
  ADD COLUMN provider_ref      TEXT,          -- e.g. Razorpay QR id
  ADD COLUMN provider_upi_uri  TEXT,          -- payable link issued by the provider
  ADD COLUMN connection_id     TEXT REFERENCES provider_connections(id),
  ADD COLUMN next_check_at     TIMESTAMPTZ,   -- NULL = not polled
  ADD COLUMN check_count       INT NOT NULL DEFAULT 0,
  ADD COLUMN provider_closed   BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX orders_due_check_idx ON orders(next_check_at) WHERE next_check_at IS NOT NULL;
CREATE UNIQUE INDEX orders_provider_ref_uidx ON orders(provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Every money movement we learn about. (provider, provider_payment_id) makes ingestion idempotent.
CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(id),
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  mode                TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  amount_paise        BIGINT NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL,   -- as reported: captured | failed | refunded | pending
  match_status        TEXT NOT NULL,   -- matched | amount_mismatch | late | duplicate_payment | not_captured
  payer_vpa           TEXT,
  rrn                 TEXT,
  paid_at             TIMESTAMPTZ,
  source              TEXT NOT NULL,   -- poll | webhook | simulate | merchant_manual
  raw                 JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX payments_merchant_idx ON payments(merchant_id, created_at DESC);
CREATE INDEX payments_order_idx ON payments(order_id);

-- Outbox: written in the SAME transaction as the state change. Module 4 (webhooks) drains it.
CREATE TABLE events (
  id            BIGSERIAL PRIMARY KEY,
  merchant_id   TEXT NOT NULL,
  mode          TEXT NOT NULL,
  type          TEXT NOT NULL,         -- order.paid | payment.flagged
  order_id      TEXT,
  data          JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ
);
CREATE INDEX events_undispatched_idx ON events(id) WHERE dispatched_at IS NULL;
