BEGIN;

CREATE TABLE IF NOT EXISTS quotation_project_line_italy_price_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  quotation_id UUID NOT NULL
    REFERENCES quotations(id)
    ON DELETE CASCADE,

  project_line_id UUID NOT NULL
    REFERENCES quotation_project_lines(id)
    ON DELETE CASCADE,

  product_id UUID NOT NULL
    REFERENCES products(id)
    ON DELETE RESTRICT,

  source_italy_price_id UUID
    REFERENCES product_italy_prices(id)
    ON DELETE SET NULL,

  price_usd NUMERIC(14,4) NOT NULL,

  currency VARCHAR(3) NOT NULL DEFAULT 'USD',

  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT quotation_project_line_italy_price_snapshots_price_check
    CHECK (price_usd >= 0),

  CONSTRAINT quotation_project_line_italy_price_snapshots_currency_check
    CHECK (currency = 'USD')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_quotation_project_line_italy_snapshot
  ON quotation_project_line_italy_price_snapshots(project_line_id);

CREATE INDEX IF NOT EXISTS idx_quotation_project_line_italy_snapshot_quotation
  ON quotation_project_line_italy_price_snapshots(quotation_id);

CREATE INDEX IF NOT EXISTS idx_quotation_project_line_italy_snapshot_product
  ON quotation_project_line_italy_price_snapshots(product_id);

CREATE OR REPLACE FUNCTION capture_quotation_project_line_italy_price()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_brand TEXT;
  resolved_price_id UUID;
  resolved_price_usd NUMERIC(14,4);
  resolved_quotation_type TEXT;
BEGIN
  /*
   * Sólo aplica a líneas PRODUCT de cotizaciones PROJECT.
   * SERVICE / OTHER nunca se valorizan para Gerencia Italia.
   */
  IF NEW.line_type <> 'PRODUCT' OR NEW.product_id IS NULL THEN
    DELETE FROM quotation_project_line_italy_price_snapshots
    WHERE project_line_id = NEW.id;

    RETURN NEW;
  END IF;

  SELECT
    q.quotation_type
  INTO
    resolved_quotation_type
  FROM quotations q
  WHERE q.id = NEW.quotation_id;

  IF UPPER(COALESCE(resolved_quotation_type, '')) <> 'PROJECT' THEN
    DELETE FROM quotation_project_line_italy_price_snapshots
    WHERE project_line_id = NEW.id;

    RETURN NEW;
  END IF;

  SELECT
    UPPER(BTRIM(COALESCE(v.brand, '')))
  INTO
    resolved_brand
  FROM vw_product_catalog v
  WHERE v.id = NEW.product_id
  LIMIT 1;

  IF COALESCE(resolved_brand, '') <> 'ABET LAMINATI' THEN
    DELETE FROM quotation_project_line_italy_price_snapshots
    WHERE project_line_id = NEW.id;

    RETURN NEW;
  END IF;

  SELECT
    pip.id,
    pip.price_usd
  INTO
    resolved_price_id,
    resolved_price_usd
  FROM product_italy_prices pip
  WHERE pip.product_id = NEW.product_id
    AND pip.valid_until IS NULL
  ORDER BY pip.valid_from DESC
  LIMIT 1;

  /*
   * Si todavía no existe Precio Italia, dejamos la línea sin snapshot.
   * El endpoint la mostrará como "Sin precio Italia".
   */
  IF resolved_price_usd IS NULL THEN
    DELETE FROM quotation_project_line_italy_price_snapshots
    WHERE project_line_id = NEW.id;

    RETURN NEW;
  END IF;

  INSERT INTO quotation_project_line_italy_price_snapshots (
    quotation_id,
    project_line_id,
    product_id,
    source_italy_price_id,
    price_usd,
    currency,
    captured_at
  )
  VALUES (
    NEW.quotation_id,
    NEW.id,
    NEW.product_id,
    resolved_price_id,
    resolved_price_usd,
    'USD',
    NOW()
  )
  ON CONFLICT (project_line_id)
  DO UPDATE SET
    quotation_id = EXCLUDED.quotation_id,
    product_id = EXCLUDED.product_id,
    source_italy_price_id = EXCLUDED.source_italy_price_id,
    price_usd = EXCLUDED.price_usd,
    currency = 'USD',
    captured_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_capture_quotation_project_line_italy_price
ON quotation_project_lines;

CREATE TRIGGER trg_capture_quotation_project_line_italy_price
AFTER INSERT OR UPDATE OF product_id, line_type
ON quotation_project_lines
FOR EACH ROW
EXECUTE FUNCTION capture_quotation_project_line_italy_price();

COMMIT;
