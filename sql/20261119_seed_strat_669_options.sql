BEGIN;

UPDATE product_abet_collections pac
SET is_primary = FALSE
FROM products p
WHERE pac.product_id = p.id
  AND p.sku = 'STRAT-669';

UPDATE product_abet_collections pac
SET is_primary = TRUE
FROM products p,
     abet_collections ac
WHERE pac.product_id = p.id
  AND pac.abet_collection_id = ac.id
  AND p.sku = 'STRAT-669'
  AND ac.slug = 'legni-dark';

INSERT INTO product_project_finishes (
  product_id,
  finish_id,
  is_default,
  is_active,
  source_name,
  source_url,
  source_version
)
SELECT
  p.id,
  f.id,
  CASE
    WHEN f.name = 'Root' THEN TRUE
    ELSE FALSE
  END,
  TRUE,
  'Abet Laminati',
  'https://abetlaminati.com/decori/rovere-primitivo-669/',
  '2026'
FROM products p
JOIN project_product_families fam
  ON fam.id = p.project_family_id
JOIN project_family_finishes f
  ON f.family_id = fam.id
WHERE p.sku = 'STRAT-669'
  AND fam.code = 'STRATIFICATO'
  AND f.name IN (
    'Aquarama',
    'Cross',
    'Grainwood',
    'Microline',
    'Papier',
    'Root',
    'Velwood'
  )
ON CONFLICT (product_id, finish_id)
DO UPDATE SET
  is_active = TRUE,
  is_default = EXCLUDED.is_default,
  source_name = EXCLUDED.source_name,
  source_url = EXCLUDED.source_url,
  source_version = EXCLUDED.source_version,
  updated_at = NOW();

COMMIT;
