BEGIN;

UPDATE project_product_families
SET
  brand_id = NULL,
  collection_id = NULL
WHERE code IN (
  'MEG',
  'STRATIFICATO',
  'LABGRADE'
);

DELETE FROM project_product_families
WHERE code IN (
  'STRATIFICATO',
  'LABGRADE'
);

ALTER TABLE project_product_families
DROP CONSTRAINT IF EXISTS
project_product_families_collection_id_fkey;

ALTER TABLE project_product_families
DROP CONSTRAINT IF EXISTS
project_product_families_brand_id_fkey;

DROP INDEX IF EXISTS
idx_project_product_families_collection;

DROP INDEX IF EXISTS
idx_project_product_families_brand;

ALTER TABLE project_product_families
DROP COLUMN IF EXISTS collection_id;

ALTER TABLE project_product_families
DROP COLUMN IF EXISTS brand_id;

-- No se eliminan las colecciones creadas para evitar
-- borrar relaciones si ya fueron utilizadas.

COMMIT;
