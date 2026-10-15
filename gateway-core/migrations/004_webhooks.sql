CREATE TABLE webhook_endpoints (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  mode            TEXT NOT NULL CHECK (mode IN ('test','live')),
  url             TEXT NOT NULL,
  description     TEXT,
  events          TEXT[],                 -- NULL = subscribe to all event types
  secret_enc      TEXT NOT NULL,          -- signing secret, AES-GCM encrypted (we must be able to sign)
  prev_secret_enc TEXT,                   -- old secret stays valid briefly after rotation
  prev_expires_at TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  disabled_reason TEXT,
  failure_streak  INT NOT NULL DEFAULT 0, -- consecutive deliveries that exhausted every retry
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_lookup_idx ON webhook_endpoints(merchant_id, mode) WHERE status = 'active';

CREATE TABLE webhook_deliveries (
  id               TEXT PRIMARY KEY,
  event_id         BIGINT NOT NULL REFERENCES events(id),
  endpoint_id      TEXT NOT NULL REFERENCES webhook_endpoints(id),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  attempt_count    INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  last_status_code INT,
  last_error       TEXT,
  succeeded_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, endpoint_id)          -- fan-out can never double-enqueue
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries(endpoint_id, created_at DESC);

-- One row per HTTP attempt: the merchant-visible delivery log
CREATE TABLE webhook_attempts (
  id               BIGSERIAL PRIMARY KEY,
  delivery_id      TEXT NOT NULL REFERENCES webhook_deliveries(id),
  attempt_no       INT NOT NULL,
  status_code      INT,
  error            TEXT,
  duration_ms      INT,
  response_snippet TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_attempts_delivery_idx ON webhook_attempts(delivery_id, attempt_no);

CREATE INDEX events_merchant_idx ON events(merchant_id, mode, id DESC);
