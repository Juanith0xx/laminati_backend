BEGIN;

-- ============================================================
-- LAMINATIWORD · LABGRADE
-- CARGA DE FORMATOS Y ESPESORES
--
-- Fuente entregada por el usuario:
-- Formatos de panel (mm):
--   3050 x 1300
--   3660 x 1590 - Labgrade Plus
--   3660 x 1610
--   4200 x 1610
--   4200 x 1860
--
-- Espesores (mm):
--   6, 8, 10, 12, 13, 16
--
-- Nota:
-- El esquema project_family_formats guarda dimensiones en cm,
-- por eso se convierten mm -> cm.
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

-- ------------------------------------------------------------
-- FORMATOS
-- ------------------------------------------------------------

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
  data.label,
  data.length_cm,
  data.width_cm,
  data.sort_order,
  TRUE
FROM project_product_families family
CROSS JOIN (
  VALUES
    (
      '305 × 130 cm',
      305.00::numeric,
      130.00::numeric,
      10
    ),
    (
      '366 × 159 cm · Labgrade Plus',
      366.00::numeric,
      159.00::numeric,
      20
    ),
    (
      '366 × 161 cm',
      366.00::numeric,
      161.00::numeric,
      30
    ),
    (
      '420 × 161 cm',
      420.00::numeric,
      161.00::numeric,
      40
    ),
    (
      '420 × 186 cm',
      420.00::numeric,
      186.00::numeric,
      50
    )
) AS data(
  label,
  length_cm,
  width_cm,
  sort_order
)
WHERE family.code = 'LABGRADE'
ON CONFLICT (
  family_id,
  length_cm,
  width_cm
)
DO UPDATE SET
  label = EXCLUDED.label,
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE;

-- ------------------------------------------------------------
-- ESPESORES
-- ------------------------------------------------------------

INSERT INTO project_family_thicknesses (
  family_id,
  thickness_mm,
  sort_order,
  is_active
)
SELECT
  family.id,
  data.thickness_mm,
  data.sort_order,
  TRUE
FROM project_product_families family
CROSS JOIN (
  VALUES
    (6.00::numeric, 10),
    (8.00::numeric, 20),
    (10.00::numeric, 30),
    (12.00::numeric, 40),
    (13.00::numeric, 50),
    (16.00::numeric, 60)
) AS data(
  thickness_mm,
  sort_order
)
WHERE family.code = 'LABGRADE'
ON CONFLICT (
  family_id,
  thickness_mm
)
DO UPDATE SET
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE;

COMMIT;
