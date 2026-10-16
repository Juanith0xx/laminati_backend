BEGIN;

-- Revertir únicamente si todavía no existen productos PROJECT_ONLY reales.
DROP VIEW IF EXISTS vw_product_catalog;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_project_only_not_saleable;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_project_only_family_required;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_project_family_id_fkey;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_commercial_mode_valid;

DROP INDEX IF EXISTS idx_products_project_family_id;
DROP INDEX IF EXISTS idx_products_commercial_mode;

ALTER TABLE products DROP COLUMN IF EXISTS project_family_id;
ALTER TABLE products DROP COLUMN IF EXISTS commercial_mode;

DROP TABLE IF EXISTS project_family_documents;
DROP TABLE IF EXISTS project_family_thicknesses;
DROP TABLE IF EXISTS project_family_finishes;
DROP TABLE IF EXISTS project_family_formats;
DROP TABLE IF EXISTS project_product_families;

CREATE OR REPLACE VIEW vw_product_catalog AS
SELECT p.id,
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
WHEN promo.promotion_type::text = 'FIXED_PRICE'::text THEN promo.promotional_price
ELSE NULL::numeric
END::numeric(14,2) AS promotional_price,
promo.starts_at AS promotion_starts_at,
promo.ends_at AS promotion_ends_at,
CASE
WHEN promo.promotion_type::text = 'FIXED_PRICE'::text THEN COALESCE(promo.promotional_price, p.base_price)
ELSE p.base_price
END AS final_price,
promo.id IS NOT NULL AND promo.promotion_type::text = 'FIXED_PRICE'::text AS has_promotion,
COALESCE(inv.stock_quantity, 0::numeric) AS stock_quantity,
COALESCE(res.reserved_quantity, 0::numeric) AS reserved_quantity,
COALESCE(inv.safety_stock, 0::numeric) AS safety_stock,
GREATEST(COALESCE(inv.stock_quantity, 0::numeric) - COALESCE(res.reserved_quantity, 0::numeric) - COALESCE(inv.safety_stock, 0::numeric), 0::numeric) AS available_web,
inv.last_sync_at,
COALESCE(inv.warehouse_count, 0::bigint) AS warehouse_count,
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
promo.id IS NOT NULL AND promo.promotion_type::text = 'QUANTITY_TIER'::text AS has_quantity_promotion,
COALESCE(promo.quantity_tiers, '[]'::jsonb) AS quantity_tiers,
COALESCE(active_promos.active_promotions, '[]'::jsonb) AS active_promotions
FROM products p
LEFT JOIN categories cat ON cat.id = p.category_id
LEFT JOIN brands br ON br.id = p.brand_id
LEFT JOIN collections col ON col.id = p.collection_id
LEFT JOIN product_seo seo ON seo.product_id = p.id
LEFT JOIN LATERAL ( SELECT sum(i.stock_quantity) AS stock_quantity,
sum(i.safety_stock) AS safety_stock,
max(i.last_sync_at) AS last_sync_at,
count(*) AS warehouse_count
FROM inventory i
WHERE i.product_id = p.id) inv ON true
LEFT JOIN LATERAL ( SELECT sum(ir.quantity) AS reserved_quantity
FROM inventory_reservations ir
JOIN inventory i ON i.id = ir.inventory_id
WHERE i.product_id = p.id AND (ir.status::text = ANY (ARRAY['ACTIVE'::character varying, 'CONFIRMED'::character varying]::text[])) AND (ir.expires_at IS NULL OR ir.expires_at > now())) res ON true
LEFT JOIN LATERAL ( SELECT pr.id,
pr.name,
pr.promotion_type,
pr.promotional_price,
pr.starts_at,
pr.ends_at,
COALESCE(( SELECT jsonb_agg(jsonb_build_object('id', tier.id, 'min_quantity', tier.min_quantity, 'unit_price', tier.unit_price) ORDER BY tier.min_quantity) AS jsonb_agg
FROM promotion_price_tiers tier
WHERE tier.promotion_id = pr.id), '[]'::jsonb) AS quantity_tiers
FROM promotions pr
WHERE pr.product_id = p.id AND pr.is_active = true AND (pr.starts_at IS NULL OR pr.starts_at <= now()) AND (pr.ends_at IS NULL OR pr.ends_at > now())
ORDER BY pr.starts_at DESC NULLS LAST, pr.created_at DESC
LIMIT 1) promo ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', pr.id,
          'name', pr.name,
          'promotion_type', pr.promotion_type,
          'promotional_price', pr.promotional_price,
          'starts_at', pr.starts_at,
          'ends_at', pr.ends_at,
          'tiers',
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', tier.id,
                    'min_quantity', tier.min_quantity,
                    'unit_price', tier.unit_price
                  )
                  ORDER BY tier.min_quantity
                )
                FROM promotion_price_tiers tier
                WHERE tier.promotion_id = pr.id
              ),
              '[]'::jsonb
            )
        )
        ORDER BY
          pr.created_at DESC,
          pr.id DESC
      ),
      '[]'::jsonb
    ) AS active_promotions
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
) active_promos ON true
LEFT JOIN LATERAL ( SELECT pi.image_url,
pi.alt_text
FROM product_images pi
WHERE pi.product_id = p.id AND pi.is_primary = true
ORDER BY pi.sort_order, pi.created_at
LIMIT 1) img ON true;;

COMMIT;
