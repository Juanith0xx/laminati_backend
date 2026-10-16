BEGIN;

-- ============================================================
-- LAMINATIWORD · FASE 1.3
-- CLASIFICACIÓN HPL PARA PRODUCTOS DE PROYECTO
--
-- Categorías:
--   MEG
--   Stratificato
--   Labgrade
--
-- Marca:
--   Abet Laminati
--
-- Colecciones:
--   MEG          -> Fachadas Ventiladas
--   Stratificato -> Cubiertas
--   Labgrade     -> Cubiertas de Laboratorio
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM brands
    WHERE LOWER(name) =
      LOWER('Abet Laminati')
       OR slug =
      'abet-laminati'
  ) THEN
    RAISE EXCEPTION
      'No existe la marca Abet Laminati. Créala antes de ejecutar esta migración.';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. La familia técnica también define marca y colección
-- ------------------------------------------------------------

ALTER TABLE project_product_families
ADD COLUMN IF NOT EXISTS brand_id UUID;

ALTER TABLE project_product_families
ADD COLUMN IF NOT EXISTS collection_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'project_product_families_brand_id_fkey'
  ) THEN
    ALTER TABLE project_product_families
    ADD CONSTRAINT project_product_families_brand_id_fkey
    FOREIGN KEY (brand_id)
    REFERENCES brands(id)
    ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'project_product_families_collection_id_fkey'
  ) THEN
    ALTER TABLE project_product_families
    ADD CONSTRAINT project_product_families_collection_id_fkey
    FOREIGN KEY (collection_id)
    REFERENCES collections(id)
    ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS
idx_project_product_families_brand
ON project_product_families(brand_id);

CREATE INDEX IF NOT EXISTS
idx_project_product_families_collection
ON project_product_families(collection_id);

-- ------------------------------------------------------------
-- 2. Crear / normalizar colecciones de Abet Laminati
-- ------------------------------------------------------------

WITH abet AS (
  SELECT id
  FROM brands
  WHERE LOWER(name) =
    LOWER('Abet Laminati')
     OR slug =
    'abet-laminati'
  ORDER BY
    CASE
      WHEN slug =
        'abet-laminati'
      THEN 0
      ELSE 1
    END,
    created_at
  LIMIT 1
)
INSERT INTO collections (
  brand_id,
  name,
  slug,
  description,
  image_url,
  banner_url,
  is_featured,
  is_active,
  sort_order
)
SELECT
  abet.id,
  data.name,
  data.slug,
  data.description,
  NULL,
  NULL,
  FALSE,
  TRUE,
  data.sort_order
FROM abet
CROSS JOIN (
  VALUES
    (
      'Cubiertas',
      'cubiertas',
      'Productos HPL Stratificato para cubiertas.',
      10
    ),
    (
      'Fachadas Ventiladas',
      'fachadas-ventiladas',
      'Productos MEG para fachadas ventiladas.',
      20
    ),
    (
      'Cubiertas de Laboratorio',
      'cubiertas-de-laboratorio',
      'Productos Labgrade para cubiertas y superficies de laboratorio.',
      30
    )
) AS data(
  name,
  slug,
  description,
  sort_order
)
WHERE NOT EXISTS (
  SELECT 1
  FROM collections existing
  WHERE existing.slug =
    data.slug
);

WITH abet AS (
  SELECT id
  FROM brands
  WHERE LOWER(name) =
    LOWER('Abet Laminati')
     OR slug =
    'abet-laminati'
  ORDER BY
    CASE
      WHEN slug =
        'abet-laminati'
      THEN 0
      ELSE 1
    END,
    created_at
  LIMIT 1
)
UPDATE collections collection
SET
  brand_id =
    abet.id,
  name =
    mapping.name,
  is_active =
    TRUE,
  sort_order =
    mapping.sort_order
FROM abet
CROSS JOIN (
  VALUES
    (
      'cubiertas',
      'Cubiertas',
      10
    ),
    (
      'fachadas-ventiladas',
      'Fachadas Ventiladas',
      20
    ),
    (
      'cubiertas-de-laboratorio',
      'Cubiertas de Laboratorio',
      30
    )
) AS mapping(
  slug,
  name,
  sort_order
)
WHERE collection.slug =
  mapping.slug;

-- ------------------------------------------------------------
-- 3. Crear familias técnicas base para las tres categorías
-- ------------------------------------------------------------

INSERT INTO project_product_families (
  code,
  name,
  application,
  default_core,
  description,
  is_active
)
SELECT
  'STRATIFICATO',
  'Stratificato',
  'Cubiertas',
  NULL,
  'Familia HPL Stratificato para productos de proyecto y cubiertas.',
  TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM project_product_families
  WHERE code =
    'STRATIFICATO'
);

INSERT INTO project_product_families (
  code,
  name,
  application,
  default_core,
  description,
  is_active
)
SELECT
  'LABGRADE',
  'Labgrade',
  'Cubiertas de Laboratorio',
  NULL,
  'Familia HPL Labgrade para productos y superficies de laboratorio.',
  TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM project_product_families
  WHERE code =
    'LABGRADE'
);

UPDATE project_product_families
SET
  name =
    'Stratificato',
  application =
    'Cubiertas',
  is_active =
    TRUE
WHERE code =
  'STRATIFICATO';

UPDATE project_product_families
SET
  name =
    'Labgrade',
  application =
    'Cubiertas de Laboratorio',
  is_active =
    TRUE
WHERE code =
  'LABGRADE';

-- ------------------------------------------------------------
-- 4. Mapear categoría + Abet Laminati + colección
-- ------------------------------------------------------------

WITH abet AS (
  SELECT id
  FROM brands
  WHERE LOWER(name) =
    LOWER('Abet Laminati')
     OR slug =
    'abet-laminati'
  ORDER BY
    CASE
      WHEN slug =
        'abet-laminati'
      THEN 0
      ELSE 1
    END,
    created_at
  LIMIT 1
)
UPDATE project_product_families family
SET
  category_id =
    category.id,
  brand_id =
    abet.id,
  collection_id =
    collection.id
FROM categories category
CROSS JOIN abet
JOIN collections collection
  ON collection.slug =
    'fachadas-ventiladas'
WHERE family.code =
    'MEG'
  AND category.slug =
    'meg';

WITH abet AS (
  SELECT id
  FROM brands
  WHERE LOWER(name) =
    LOWER('Abet Laminati')
     OR slug =
    'abet-laminati'
  ORDER BY
    CASE
      WHEN slug =
        'abet-laminati'
      THEN 0
      ELSE 1
    END,
    created_at
  LIMIT 1
)
UPDATE project_product_families family
SET
  category_id =
    category.id,
  brand_id =
    abet.id,
  collection_id =
    collection.id
FROM categories category
CROSS JOIN abet
JOIN collections collection
  ON collection.slug =
    'cubiertas'
WHERE family.code =
    'STRATIFICATO'
  AND category.slug =
    'stratificato';

WITH abet AS (
  SELECT id
  FROM brands
  WHERE LOWER(name) =
    LOWER('Abet Laminati')
     OR slug =
    'abet-laminati'
  ORDER BY
    CASE
      WHEN slug =
        'abet-laminati'
      THEN 0
      ELSE 1
    END,
    created_at
  LIMIT 1
)
UPDATE project_product_families family
SET
  category_id =
    category.id,
  brand_id =
    abet.id,
  collection_id =
    collection.id
FROM categories category
CROSS JOIN abet
JOIN collections collection
  ON collection.slug =
    'cubiertas-de-laboratorio'
WHERE family.code =
    'LABGRADE'
  AND category.slug =
    'labgrade';

COMMIT;
