BEGIN;

DROP TRIGGER IF EXISTS
  trg_promotion_price_tiers_updated_at
ON promotion_price_tiers;

DROP TABLE IF EXISTS
  promotion_price_tiers;

ALTER TABLE promotions
  DROP CONSTRAINT IF EXISTS promotions_price_by_type_valid;

ALTER TABLE promotions
  DROP CONSTRAINT IF EXISTS promotions_type_valid;

ALTER TABLE promotions
  ALTER COLUMN promotional_price SET NOT NULL;

ALTER TABLE promotions
  DROP COLUMN IF EXISTS promotion_type;

COMMIT;

-- IMPORTANTE:
-- Este rollback NO restaura automáticamente la versión anterior
-- de vw_product_catalog. Restaura la definición anterior desde tu
-- backup antes de usar este rollback en producción.
