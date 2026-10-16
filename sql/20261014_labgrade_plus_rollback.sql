BEGIN;

DELETE FROM project_family_formats
WHERE family_id IN (
  SELECT id
  FROM project_product_families
  WHERE code = 'LABGRADE_PLUS'
);

DELETE FROM project_family_finishes
WHERE family_id IN (
  SELECT id
  FROM project_product_families
  WHERE code = 'LABGRADE_PLUS'
);

DELETE FROM project_family_thicknesses
WHERE family_id IN (
  SELECT id
  FROM project_product_families
  WHERE code = 'LABGRADE_PLUS'
);

DELETE FROM project_family_documents
WHERE family_id IN (
  SELECT id
  FROM project_product_families
  WHERE code = 'LABGRADE_PLUS'
);

DELETE FROM project_product_families
WHERE code = 'LABGRADE_PLUS';

COMMIT;
