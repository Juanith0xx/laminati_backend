BEGIN;

ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS promotion_type VARCHAR(30);

UPDATE promotions
SET promotion_type = 'FIXED_PRICE'
WHERE promotion_type IS NULL;

ALTER TABLE promotions
  ALTER COLUMN promotion_type SET DEFAULT 'FIXED_PRICE';

ALTER TABLE promotions
  ALTER COLUMN promotion_type SET NOT NULL;

ALTER TABLE promotions
  DROP CONSTRAINT IF EXISTS promotions_type_valid;

ALTER TABLE promotions
  ADD CONSTRAINT promotions_type_valid
  CHECK (
    promotion_type IN (
      'FIXED_PRICE',
      'QUANTITY_TIER'
    )
  );

ALTER TABLE promotions
  ALTER COLUMN promotional_price DROP NOT NULL;

ALTER TABLE promotions
  DROP CONSTRAINT IF EXISTS promotions_price_by_type_valid;

ALTER TABLE promotions
  ADD CONSTRAINT promotions_price_by_type_valid
  CHECK (
    (
      promotion_type = 'FIXED_PRICE'
      AND promotional_price IS NOT NULL
    )
    OR
    (
      promotion_type = 'QUANTITY_TIER'
      AND promotional_price IS NULL
    )
  );

CREATE TABLE IF NOT EXISTS promotion_price_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  promotion_id UUID NOT NULL
    REFERENCES promotions(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  min_quantity NUMERIC(14,3) NOT NULL,
  unit_price NUMERIC(14,2) NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT promotion_price_tiers_qty_positive
    CHECK (min_quantity > 0),

  CONSTRAINT promotion_price_tiers_price_positive
    CHECK (unit_price >= 0),

  CONSTRAINT promotion_price_tiers_unique_qty
    UNIQUE (
      promotion_id,
      min_quantity
    )
);

CREATE INDEX IF NOT EXISTS
  idx_promotion_price_tiers_promotion_id
ON promotion_price_tiers (
  promotion_id
);

DROP TRIGGER IF EXISTS
  trg_promotion_price_tiers_updated_at
ON promotion_price_tiers;

CREATE TRIGGER
  trg_promotion_price_tiers_updated_at
BEFORE UPDATE
ON promotion_price_tiers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE VIEW vw_product_catalog AS
SELECT
  p.id,
  p.sku,
  p.internal_code,
  p.relbase_product_id,
  p.name,
  p.slug,
  p.short_description,
  p.description,
  p.category_id,
  cat.name AS category,
  cat.slug AS category_slug,
  p.brand_id,
  br.name AS brand,
  br.slug AS brand_slug,
  p.collection_id,
  col.name AS collection,
  col.slug AS collection_slug,
  p.color,
  p.finish,
  p.texture,
  p.width_mm,
  p.height_mm,
  p.thickness_mm,
  p.weight_kg,
  p.base_price,
  p.tax_rate,
  promo.id AS promotion_id,
  promo.name AS promotion_name,

  CASE
    WHEN promo.promotion_type = 'FIXED_PRICE'
      THEN promo.promotional_price
    ELSE NULL
  END AS promotional_price,

  promo.starts_at AS promotion_starts_at,
  promo.ends_at AS promotion_ends_at,

  CASE
    WHEN promo.promotion_type = 'FIXED_PRICE'
      THEN COALESCE(
        promo.promotional_price,
        p.base_price
      )
    ELSE p.base_price
  END AS final_price,

  (
    promo.id IS NOT NULL
    AND promo.promotion_type = 'FIXED_PRICE'
  ) AS has_promotion,

  COALESCE(
    inv.stock_quantity,
    0::numeric
  ) AS stock_quantity,

  COALESCE(
    res.reserved_quantity,
    0::numeric
  ) AS reserved_quantity,

  COALESCE(
    inv.safety_stock,
    0::numeric
  ) AS safety_stock,

  GREATEST(
    COALESCE(
      inv.stock_quantity,
      0::numeric
    )
    -
    COALESCE(
      res.reserved_quantity,
      0::numeric
    )
    -
    COALESCE(
      inv.safety_stock,
      0::numeric
    ),
    0::numeric
  ) AS available_web,

  inv.last_sync_at,

  COALESCE(
    inv.warehouse_count,
    0::bigint
  ) AS warehouse_count,

  img.image_url AS primary_image_url,
  img.alt_text AS primary_image_alt,

  seo.meta_title,
  seo.meta_description,
  seo.canonical_url,
  seo.og_title,
  seo.og_description,
  seo.og_image_url,
  seo.robots_index,
  seo.robots_follow,

  p.is_active,
  p.is_published,
  p.is_featured,
  p.allow_sale,
  p.sort_order,
  p.created_at,
  p.updated_at,

  promo.promotion_type,

  (
    promo.id IS NOT NULL
    AND promo.promotion_type = 'QUANTITY_TIER'
  ) AS has_quantity_promotion,

  COALESCE(
    promo.quantity_tiers,
    '[]'::jsonb
  ) AS quantity_tiers

FROM products p

LEFT JOIN categories cat
  ON cat.id = p.category_id

LEFT JOIN brands br
  ON br.id = p.brand_id

LEFT JOIN collections col
  ON col.id = p.collection_id

LEFT JOIN product_seo seo
  ON seo.product_id = p.id

LEFT JOIN LATERAL (
  SELECT
    SUM(i.stock_quantity) AS stock_quantity,
    SUM(i.safety_stock) AS safety_stock,
    MAX(i.last_sync_at) AS last_sync_at,
    COUNT(*) AS warehouse_count
  FROM inventory i
  WHERE i.product_id = p.id
) inv
  ON TRUE

LEFT JOIN LATERAL (
  SELECT
    SUM(ir.quantity) AS reserved_quantity
  FROM inventory_reservations ir

  INNER JOIN inventory i
    ON i.id = ir.inventory_id

  WHERE i.product_id = p.id
    AND ir.status IN (
      'ACTIVE',
      'CONFIRMED'
    )
    AND (
      ir.expires_at IS NULL
      OR ir.expires_at > NOW()
    )
) res
  ON TRUE

LEFT JOIN LATERAL (
  SELECT
    pr.id,
    pr.name,
    pr.promotion_type,
    pr.promotional_price,
    pr.starts_at,
    pr.ends_at,

    COALESCE(
      (
        SELECT
          jsonb_agg(
            jsonb_build_object(
              'id',
              tier.id,
              'min_quantity',
              tier.min_quantity,
              'unit_price',
              tier.unit_price
            )
            ORDER BY
              tier.min_quantity ASC
          )
        FROM promotion_price_tiers tier
        WHERE tier.promotion_id = pr.id
      ),
      '[]'::jsonb
    ) AS quantity_tiers

  FROM promotions pr

  WHERE pr.product_id = p.id
    AND pr.is_active = TRUE
    AND (
      pr.starts_at IS NULL
      OR pr.starts_at <= NOW()
    )
    AND (
      pr.ends_at IS NULL
      OR pr.ends_at > NOW()
    )

  ORDER BY
    pr.starts_at DESC NULLS LAST,
    pr.created_at DESC

  LIMIT 1
) promo
  ON TRUE

LEFT JOIN LATERAL (
  SELECT
    pi.image_url,
    pi.alt_text

  FROM product_images pi

  WHERE pi.product_id = p.id
    AND pi.is_primary = TRUE

  ORDER BY
    pi.sort_order,
    pi.created_at

  LIMIT 1
) img
  ON TRUE;

COMMIT;
