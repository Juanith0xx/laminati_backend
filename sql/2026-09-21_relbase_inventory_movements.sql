-- Ejecutar tras respaldo. NO realiza movimientos, NO modifica existencias.
BEGIN;

CREATE TABLE IF NOT EXISTS public.relbase_inventory_movements (
  request_id UUID PRIMARY KEY,
  product_id TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  relbase_product_id BIGINT NOT NULL,
  relbase_warehouse_id BIGINT NOT NULL,
  actor_user_id TEXT NOT NULL,
  operation VARCHAR(20) NOT NULL CHECK (operation IN ('RECEIPT','CONSUMPTION','COUNT')),
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity >= 0),
  unit_cost NUMERIC(18,4),
  document_reference TEXT NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL CHECK (status IN ('PROCESSING','REJECTED','REVIEW_REQUIRED','RELBASE_APPLIED','SYNC_PENDING','SUCCEEDED')),
  before_stock NUMERIC(14,3),
  after_stock NUMERIC(14,3),
  relbase_adjustment_id TEXT,
  relbase_response JSONB,
  sync_response JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_relbase_inventory_movements_product
  ON public.relbase_inventory_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_relbase_inventory_movements_review
  ON public.relbase_inventory_movements(status, created_at DESC);
COMMIT;
