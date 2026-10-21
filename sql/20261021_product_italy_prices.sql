BEGIN;

CREATE TABLE IF NOT EXISTS product_italy_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  product_id UUID NOT NULL
    REFERENCES products(id)
    ON DELETE CASCADE,

  price_usd NUMERIC(14,4) NOT NULL,

  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,

  created_by UUID
    REFERENCES users(id)
    ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT product_italy_prices_price_check
    CHECK (price_usd >= 0),

  CONSTRAINT product_italy_prices_validity_check
    CHECK (
      valid_until IS NULL
      OR valid_until >= valid_from
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_italy_prices_active
  ON product_italy_prices(product_id)
  WHERE valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_italy_prices_product_history
  ON product_italy_prices(product_id, valid_from DESC);

COMMIT;
