BEGIN;

-- ============================================================
-- LAMINATIWORD · LABGRADE PLUS
--
-- Misma clasificación comercial que Labgrade:
-- Categoría: Labgrade
-- Marca: Abet Laminati
-- Colección: Cubiertas de Laboratorio
--
-- Diferencia técnica:
-- Familia: Labgrade Plus
-- Formato disponible: 3660 × 1590 mm
--                      366 × 159 cm
--
-- No se cargan acabados ni espesores específicos porque
-- todavía no fueron confirmados para Labgrade Plus.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM project_product_families
    WHERE code = 'LABGRADE'
      AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION
      'No existe la familia técnica LABGRADE activa.';
  END IF;
END $$;

INSERT INTO project_product_families (
  code,
  name,
  application,
  default_core,
  description,
  is_active,
  category_id,
  brand_id,
  collection_id
)
SELECT
  'LABGRADE_PLUS',
  'Labgrade Plus',
  'Cubiertas de Laboratorio',
  base.default_core,
  'Colección Labgrade Plus. Disponible únicamente en formato 3660 × 1590 mm.',
  TRUE,
  base.category_id,
  base.brand_id,
  base.collection_id
FROM project_product_families base
WHERE base.code = 'LABGRADE'
ON CONFLICT (code)
DO UPDATE SET
  name = EXCLUDED.name,
  application = EXCLUDED.application,
  default_core = EXCLUDED.default_core,
  description = EXCLUDED.description,
  is_active = TRUE,
  category_id = EXCLUDED.category_id,
  brand_id = EXCLUDED.brand_id,
  collection_id = EXCLUDED.collection_id;

INSERT INTO project_family_formats (
  family_id,
  label,
  length_cm,
  width_cm,
  sort_order,
  is_active
)
SELECT
  family.id,
  '366 × 159 cm · Labgrade Plus',
  366.00,
  159.00,
  10,
  TRUE
FROM project_product_families family
WHERE family.code = 'LABGRADE_PLUS'
ON CONFLICT (
  family_id,
  length_cm,
  width_cm
)
DO UPDATE SET
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE;

COMMIT;
