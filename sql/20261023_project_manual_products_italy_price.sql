\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE quotation_project_lines
  ADD COLUMN IF NOT EXISTS brand VARCHAR(160);

ALTER TABLE quotation_project_lines
  ADD COLUMN IF NOT EXISTS collection VARCHAR(160);

ALTER TABLE quotation_project_lines
  ADD COLUMN IF NOT EXISTS italy_price_usd NUMERIC(14,4);

ALTER TABLE quotation_project_lines
  ADD COLUMN IF NOT EXISTS italy_price_source VARCHAR(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'quotation_project_lines_italy_price_nonnegative'
  ) THEN
    ALTER TABLE quotation_project_lines
      ADD CONSTRAINT quotation_project_lines_italy_price_nonnegative
      CHECK (
        italy_price_usd IS NULL
        OR italy_price_usd >= 0
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'quotation_project_lines_italy_price_source_check'
  ) THEN
    ALTER TABLE quotation_project_lines
      ADD CONSTRAINT quotation_project_lines_italy_price_source_check
      CHECK (
        italy_price_source IS NULL
        OR italy_price_source IN (
          'MANUAL',
          'CATALOG'
        )
      );
  END IF;
END;
$$;

UPDATE quotation_project_lines qpl
SET
  brand = COALESCE(
    NULLIF(
      BTRIM(
        qpl.brand
      ),
      ''
    ),
    v.brand
  ),
  collection = COALESCE(
    NULLIF(
      BTRIM(
        qpl.collection
      ),
      ''
    ),
    v.collection
  )
FROM vw_product_catalog v
WHERE qpl.product_id = v.id
  AND qpl.line_type = 'PRODUCT'
  AND (
    qpl.brand IS NULL
    OR BTRIM(qpl.brand) = ''
    OR qpl.collection IS NULL
    OR BTRIM(qpl.collection) = ''
  );

UPDATE quotation_project_lines qpl
SET
  italy_price_usd =
    snapshot.price_usd,
  italy_price_source =
    COALESCE(
      qpl.italy_price_source,
      'CATALOG'
    )
FROM quotation_project_line_italy_price_snapshots snapshot
WHERE snapshot.project_line_id = qpl.id
  AND qpl.line_type = 'PRODUCT'
  AND qpl.italy_price_usd IS NULL;

CREATE INDEX IF NOT EXISTS idx_quotation_project_lines_brand_snapshot
  ON quotation_project_lines (
    UPPER(
      BTRIM(
        brand
      )
    )
  )
  WHERE line_type = 'PRODUCT';

COMMENT ON COLUMN quotation_project_lines.brand IS
  'Snapshot de marca de la línea. Permite productos manuales sin product_id.';

COMMENT ON COLUMN quotation_project_lines.collection IS
  'Snapshot de colección de la línea. Permite productos manuales sin product_id.';

COMMENT ON COLUMN quotation_project_lines.italy_price_usd IS
  'Precio Italia USD congelado en la línea de cotización. Puede provenir del catálogo o ingresarse manualmente. No es precio comercial Chile.';

COMMENT ON COLUMN quotation_project_lines.italy_price_source IS
  'Origen del Precio Italia de la línea: CATALOG o MANUAL.';

COMMIT;

-- Verificación sugerida:
-- SELECT
--   id,
--   line_type,
--   product_id,
--   code,
--   description,
--   brand,
--   collection,
--   italy_price_usd,
--   italy_price_source
-- FROM quotation_project_lines
-- ORDER BY created_at DESC
-- LIMIT 30;
