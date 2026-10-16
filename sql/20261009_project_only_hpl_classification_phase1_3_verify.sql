-- ============================================================
-- VERIFICACIÓN FASE 1.3
-- ============================================================

SELECT
  family.code,
  family.name AS familia,
  parent.name AS categoria_padre,
  category.name AS categoria,
  brand.name AS marca,
  collection.name AS coleccion
FROM project_product_families family
LEFT JOIN categories category
  ON category.id =
    family.category_id
LEFT JOIN categories parent
  ON parent.id =
    category.parent_id
LEFT JOIN brands brand
  ON brand.id =
    family.brand_id
LEFT JOIN collections collection
  ON collection.id =
    family.collection_id
WHERE family.code IN (
  'MEG',
  'STRATIFICATO',
  'LABGRADE'
)
ORDER BY
  CASE family.code
    WHEN 'MEG'
    THEN 1
    WHEN 'STRATIFICATO'
    THEN 2
    WHEN 'LABGRADE'
    THEN 3
    ELSE 99
  END;
