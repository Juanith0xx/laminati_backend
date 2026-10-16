BEGIN;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS checkout_idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_checkout_idempotency_key
  ON orders (checkout_idempotency_key)
  WHERE checkout_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_user_created_at
  ON orders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_reservations_active_expiry
  ON inventory_reservations (inventory_id, expires_at)
  WHERE status = 'ACTIVE';

COMMIT;
