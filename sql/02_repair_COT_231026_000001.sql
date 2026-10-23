\set ON_ERROR_STOP on

BEGIN;

-- IMPORTANTE:
-- Este script es específico para COT-231026-000001.
-- Úsalo sólo si confirmaste que la línea código 1853 corresponde
-- realmente a ABET LAMINATI y que la cotización debe ser visible
-- para Gerencia Italia.

UPDATE quotations
SET
  visible_to_italy = TRUE,
  italy_visibility_set_at = COALESCE(
    italy_visibility_set_at,
    NOW()
  ),
  italy_visibility_set_by = COALESCE(
    italy_visibility_set_by,
    created_by
  )
WHERE quote_number = 'COT-231026-000001'
  AND quotation_type = 'PROJECT';

UPDATE quotation_project_lines qpl
SET
  brand = 'ABET LAMINATI'
FROM quotations q
WHERE q.id = qpl.quotation_id
  AND q.quote_number = 'COT-231026-000001'
  AND qpl.line_type = 'PRODUCT'
  AND qpl.code = '1853'
  AND (
    qpl.brand IS NULL
    OR BTRIM(qpl.brand) = ''
    OR UPPER(BTRIM(qpl.brand)) = 'ABET'
  );

COMMIT;

SELECT
  q.quote_number,
  q.visible_to_italy,
  qpl.code,
  qpl.description,
  qpl.brand,
  qpl.italy_price_usd,
  qpl.quantity
FROM quotations q
JOIN quotation_project_lines qpl
  ON qpl.quotation_id = q.id
WHERE q.quote_number = 'COT-231026-000001';
