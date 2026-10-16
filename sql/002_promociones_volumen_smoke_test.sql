-- 1) Estructura
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'promotions'
ORDER BY ordinal_position;

SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'promotion_price_tiers'
ORDER BY ordinal_position;

-- 2) Verificar vista
SELECT
  id,
  sku,
  base_price,
  promotion_type,
  promotional_price,
  final_price,
  has_promotion,
  has_quantity_promotion,
  quantity_tiers
FROM vw_product_catalog
ORDER BY updated_at DESC
LIMIT 10;

-- 3) Promociones actuales deben permanecer FIXED_PRICE
SELECT
  id,
  product_id,
  name,
  promotion_type,
  promotional_price,
  is_active
FROM promotions
ORDER BY created_at DESC
LIMIT 20;
