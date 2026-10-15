ALTER TABLE merchants
  ADD COLUMN password_hash     TEXT,                       -- NULL for pre-auth accounts: they must use password reset
  ADD COLUMN email_verified_at TIMESTAMPTZ,
  ADD COLUMN totp_secret_enc   TEXT,
  ADD COLUMN totp_enabled      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN totp_last_step    BIGINT,                     -- blocks re-using a 2FA code
  ADD COLUMN failed_logins     INT NOT NULL DEFAULT 0,
  ADD COLUMN locked_until      TIMESTAMPTZ;
ALTER TABLE merchants DROP CONSTRAINT merchants_kyc_status_check;
ALTER TABLE merchants ADD CONSTRAINT merchants_kyc_status_check CHECK (kyc_status IN ('pending','submitted','approved','rejected'));

-- id = sha256(cookie token): a database leak does not hand out live sessions
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  csrf_token    TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  stepped_up_at TIMESTAMPTZ,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX sessions_merchant_idx ON sessions(merchant_id);

CREATE TABLE email_tokens (
  token_hash  TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE recovery_codes (
  id          BIGSERIAL PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX recovery_codes_idx ON recovery_codes(merchant_id, code_hash);

CREATE TABLE kyc_submissions (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  status        TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  data_enc      TEXT NOT NULL,               -- PAN/GSTIN etc, encrypted at rest
  risk_flags    TEXT[] NOT NULL DEFAULT '{}',
  reviewer_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ
);
CREATE INDEX kyc_pending_idx ON kyc_submissions(created_at) WHERE status = 'submitted';
