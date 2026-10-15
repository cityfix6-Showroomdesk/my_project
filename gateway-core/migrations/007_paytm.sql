-- Allow Paytm-backed accounts, connections and orders (same shape as Razorpay)
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_provider_check;
ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_provider_check CHECK (provider IN ('razorpay','paytm'));
ALTER TABLE orders DROP CONSTRAINT orders_provider_check;
ALTER TABLE orders ADD CONSTRAINT orders_provider_check CHECK (provider IN ('direct','razorpay','paytm','sandbox'));
ALTER TABLE merchant_accounts DROP CONSTRAINT merchant_accounts_type_check;
ALTER TABLE merchant_accounts ADD CONSTRAINT merchant_accounts_type_check CHECK (type IN ('upi_vpa','razorpay','paytm'));
