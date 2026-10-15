CREATE TABLE merchants (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  kyc_status    TEXT NOT NULL DEFAULT 'pending'
                CHECK (kyc_status IN ('pending','approved','rejected')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  mode        TEXT NOT NULL CHECK (mode IN ('test','live')),
  prefix      TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_merchant_idx ON api_keys(merchant_id);

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  mode            TEXT NOT NULL CHECK (mode IN ('test','live')),
  amount_paise    BIGINT NOT NULL CHECK (amount_paise > 0),
  currency        TEXT NOT NULL DEFAULT 'INR',
  reference       TEXT,
  customer_name   TEXT,
  customer_email  TEXT,
  customer_phone  TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'created'
                  CHECK (status IN ('created','pending','paid','expired','failed')),
  checkout_token  TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  paid_at         TIMESTAMPTZ,
  idempotency_key TEXT,
  request_hash    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key)
);
CREATE INDEX orders_merchant_created_idx ON orders(merchant_id, created_at DESC, id);
CREATE INDEX orders_open_expiry_idx ON orders(expires_at) WHERE status IN ('created','pending');

CREATE TABLE order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events(order_id);

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  merchant_id TEXT,
  action      TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
