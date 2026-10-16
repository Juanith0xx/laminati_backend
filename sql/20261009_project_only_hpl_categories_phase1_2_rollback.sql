BEGIN;

UPDATE project_product_families
SET category_id = NULL
WHERE code = 'MEG';

ALTER TABLE project_product_families
DROP CONSTRAINT IF EXISTS project_product_families_category_id_fkey;

DROP INDEX IF EXISTS idx_project_product_families_category;

ALTER TABLE project_product_families
DROP COLUMN IF EXISTS category_id;

COMMIT;
