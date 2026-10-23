\set ON_ERROR_STOP on

SELECT
  q.id AS quotation_id,
  q.quote_number,
  q.quotation_type,
  q.status,
  q.visible_to_italy,
  q.project_name,
  qpl.id AS line_id,
  qpl.line_type,
  qpl.product_id,
  qpl.code,
  qpl.description,
  qpl.brand,
  qpl.collection,
  qpl.italy_price_usd,
  qpl.italy_price_source,
  qpl.quantity
FROM quotations q
LEFT JOIN quotation_project_lines qpl
  ON qpl.quotation_id = q.id
WHERE q.quote_number = 'COT-231026-000001'
ORDER BY qpl.sort_order, qpl.created_at;
