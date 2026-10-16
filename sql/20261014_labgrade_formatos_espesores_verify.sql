-- ============================================================
-- VERIFICACIÓN LABGRADE
-- ============================================================

SELECT
  family.code,
  format.label,
  format.length_cm,
  format.width_cm,
  format.is_active
FROM project_product_families family
JOIN project_family_formats format
  ON format.family_id = family.id
WHERE family.code = 'LABGRADE'
ORDER BY format.sort_order;

SELECT
  family.code,
  thickness.thickness_mm,
  thickness.is_active
FROM project_product_families family
JOIN project_family_thicknesses thickness
  ON thickness.family_id = family.id
WHERE family.code = 'LABGRADE'
ORDER BY thickness.sort_order;

SELECT
  family.code,
  family.name,
  family.application,
  family.default_core,
  family.category_id,
  family.brand_id,
  family.collection_id
FROM project_product_families family
WHERE family.code = 'LABGRADE';
