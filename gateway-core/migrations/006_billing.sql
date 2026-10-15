-- PLACEHOLDER PRICES (paise, excluding GST). Edit these rows to set your real plans.
CREATE TABLE plans (
  code                TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  price_paise         BIGINT NOT NULL CHECK (price_paise > 0),
  monthly_order_limit INT NOT NULL CHECK (monthly_order_limit > 0),
  active              BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO plans VALUES ('starter','Starter',49900,500,true),('growth','Growth',149900,5000,true),('scale','Scale',499900,50000,true);

CREATE TABLE subscriptions (
  merchant_id          TEXT PRIMARY KEY REFERENCES merchants(id),
  plan_code            TEXT NOT NULL DEFAULT 'starter' REFERENCES plans(code),
  pending_plan_code    TEXT REFERENCES plans(code),          -- applies at the next invoice
  status               TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','suspended','canceled')),
  trial_ends_at        TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  grace_ends_at        TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_status_idx ON subscriptions(status);
INSERT INTO subscriptions (merchant_id, status, trial_ends_at)
  SELECT id, 'trialing', now() + interval '14 days' FROM merchants ON CONFLICT DO NOTHING;

CREATE TABLE billing_profiles (
  merchant_id TEXT PRIMARY KEY REFERENCES merchants(id),
  legal_name  TEXT NOT NULL,
  gstin       TEXT,
  state_code  TEXT NOT NULL,       -- GST place of supply, 2 digits
  address     TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Gapless numbering per financial year (a number is only consumed if the invoice commits)
CREATE TABLE invoice_counters (fy TEXT PRIMARY KEY, last INT NOT NULL);

CREATE TABLE invoices (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  number         TEXT NOT NULL UNIQUE,
  plan_code      TEXT NOT NULL,
  description    TEXT NOT NULL,
  period_start   TIMESTAMPTZ NOT NULL,
  period_end     TIMESTAMPTZ NOT NULL,
  subtotal_paise BIGINT NOT NULL,
  cgst_paise     BIGINT NOT NULL DEFAULT 0,
  sgst_paise     BIGINT NOT NULL DEFAULT 0,
  igst_paise     BIGINT NOT NULL DEFAULT 0,
  total_paise    BIGINT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  due_at         TIMESTAMPTZ NOT NULL,
  paid_at        TIMESTAMPTZ,
  supplier       JSONB NOT NULL,   -- snapshots: a tax invoice must not change if profiles change later
  customer       JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, period_start)
);
CREATE INDEX invoices_merchant_idx ON invoices(merchant_id, created_at DESC);
CREATE INDEX invoices_open_idx ON invoices(status) WHERE status = 'open';

CREATE TABLE invoice_orders (invoice_id TEXT NOT NULL REFERENCES invoices(id), order_id TEXT NOT NULL REFERENCES orders(id), PRIMARY KEY (invoice_id, order_id));
