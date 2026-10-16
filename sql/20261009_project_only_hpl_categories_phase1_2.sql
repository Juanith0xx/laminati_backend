BEGIN;

INSERT INTO categories (
  parent_id, name, slug, description, is_active, sort_order
)
SELECT
  NULL,
  'HPL',
  'hpl',
  'High Pressure Laminate y soluciones HPL de Abet Laminati.',
  TRUE,
  20
WHERE NOT EXISTS (
  SELECT 1 FROM categories WHERE slug = 'hpl'
);

UPDATE categories
SET parent_id = NULL,
    name = 'HPL',
    is_active = TRUE
WHERE slug = 'hpl';

INSERT INTO categories (
  parent_id, name, slug, description, is_active, sort_order
)
SELECT
  hpl.id,
  child.name,
  child.slug,
  child.description,
  TRUE,
  child.sort_order
FROM categories hpl
CROSS JOIN (
  VALUES
    ('Stratificato','stratificato','HPL compacto para cubiertas y aplicaciones arquitectónicas.',10),
    ('MEG','meg','HPL para fachadas ventiladas y aplicaciones exteriores.',20),
    ('Labgrade','labgrade','HPL técnico para cubiertas y superficies de laboratorio.',30)
) AS child(name, slug, description, sort_order)
WHERE hpl.slug = 'hpl'
  AND NOT EXISTS (
    SELECT 1 FROM categories c WHERE c.slug = child.slug
  );

UPDATE categories child
SET parent_id = hpl.id,
    is_active = TRUE
FROM categories hpl
WHERE hpl.slug = 'hpl'
  AND child.slug IN ('stratificato','meg','labgrade');

ALTER TABLE project_product_families
ADD COLUMN IF NOT EXISTS category_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_product_families_category_id_fkey'
  ) THEN
    ALTER TABLE project_product_families
    ADD CONSTRAINT project_product_families_category_id_fkey
    FOREIGN KEY (category_id)
    REFERENCES categories(id)
    ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_project_product_families_category
ON project_product_families(category_id);

UPDATE project_product_families f
SET category_id = c.id
FROM categories c
WHERE f.code = 'MEG'
  AND c.slug = 'meg';

COMMIT;
