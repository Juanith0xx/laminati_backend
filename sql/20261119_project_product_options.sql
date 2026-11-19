BEGIN;

ALTER TABLE product_abet_collections
ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_abet_collections_primary
ON product_abet_collections(product_id)
WHERE is_primary = TRUE;

CREATE TABLE IF NOT EXISTS product_project_finishes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL
    REFERENCES products(id)
    ON DELETE CASCADE,
  finish_id UUID NOT NULL
    REFERENCES project_family_finishes(id)
    ON DELETE RESTRICT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  source_name VARCHAR(100),
  source_url TEXT,
  source_version VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, finish_id)
);

CREATE INDEX IF NOT EXISTS idx_product_project_finishes_product
ON product_project_finishes(product_id);

CREATE INDEX IF NOT EXISTS idx_product_project_finishes_finish
ON product_project_finishes(finish_id);

COMMIT;
