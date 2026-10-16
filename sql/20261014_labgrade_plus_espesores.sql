BEGIN;

-- ============================================================
-- LAMINATIWORD · LABGRADE PLUS
-- ESPESORES DISPONIBLES
--
-- Según la ficha técnica entregada:
-- 8, 13, 16, 18 y 20 mm
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM project_product_families
    WHERE code = 'LABGRADE_PLUS'
      AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION
      'No existe la familia técnica LABGRADE_PLUS activa.';
  END IF;
END $$;

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
    (8.00::numeric, 10),
    (13.00::numeric, 20),
    (16.00::numeric, 30),
    (18.00::numeric, 40),
    (20.00::numeric, 50)
) AS data(
  thickness_mm,
  sort_order
)
WHERE family.code = 'LABGRADE_PLUS'
ON CONFLICT (
  family_id,
  thickness_mm
)
DO UPDATE SET
  sort_order = EXCLUDED.sort_order,
  is_active = TRUE;

COMMIT;
