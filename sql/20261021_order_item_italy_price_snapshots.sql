BEGIN;

CREATE TABLE IF NOT EXISTS order_item_italy_price_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  order_id UUID NOT NULL
    REFERENCES orders(id)
    ON DELETE CASCADE,

  order_item_id UUID NOT NULL
    REFERENCES order_items(id)
    ON DELETE CASCADE,

  product_id UUID NOT NULL
    REFERENCES products(id)
    ON DELETE RESTRICT,

  source_italy_price_id UUID
    REFERENCES product_italy_prices(id)
    ON DELETE SET NULL,

  price_usd NUMERIC(14,4) NOT NULL,

  quantity NUMERIC(14,3) NOT NULL,

  total_usd NUMERIC(18,4) NOT NULL,

  currency VARCHAR(3) NOT NULL DEFAULT 'USD',

  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT order_item_italy_price_snapshots_price_check
    CHECK (price_usd >= 0),

  CONSTRAINT order_item_italy_price_snapshots_quantity_check
    CHECK (quantity > 0),

  CONSTRAINT order_item_italy_price_snapshots_total_check
    CHECK (total_usd >= 0),

  CONSTRAINT order_item_italy_price_snapshots_currency_check
    CHECK (currency = 'USD')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_item_italy_price_snapshot
  ON order_item_italy_price_snapshots(order_item_id);

CREATE INDEX IF NOT EXISTS idx_order_item_italy_price_snapshots_order
  ON order_item_italy_price_snapshots(order_id);

CREATE INDEX IF NOT EXISTS idx_order_item_italy_price_snapshots_product
  ON order_item_italy_price_snapshots(product_id);

COMMIT;
