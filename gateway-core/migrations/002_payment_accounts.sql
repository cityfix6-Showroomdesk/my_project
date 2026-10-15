CREATE TABLE merchant_accounts (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  type                TEXT NOT NULL DEFAULT 'upi_vpa' CHECK (type IN ('upi_vpa')),
  vpa                 TEXT NOT NULL,
  payee_name          TEXT NOT NULL,  -- name the customer's UPI app will show
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (verification_status IN ('unverified','verified','rejected')),
  verified_at         TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  is_default          BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one active default per merchant
CREATE UNIQUE INDEX merchant_accounts_default_uidx ON merchant_accounts(merchant_id) WHERE is_default AND status='active';
-- no duplicate VPA inside one merchant
CREATE UNIQUE INDEX merchant_accounts_vpa_uidx ON merchant_accounts(merchant_id, lower(vpa)) WHERE status='active';
-- a VPA can be VERIFIED for only one merchant (blocks someone claiming another's account)
CREATE UNIQUE INDEX merchant_accounts_verified_vpa_uidx ON merchant_accounts(lower(vpa))
  WHERE verification_status='verified' AND status='active';

-- Snapshot the payee on each order so later account edits never change an existing order
ALTER TABLE orders
  ADD COLUMN merchant_account_id TEXT REFERENCES merchant_accounts(id),
  ADD COLUMN payee_vpa  TEXT,
  ADD COLUMN payee_name TEXT;
