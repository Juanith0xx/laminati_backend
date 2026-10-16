-- ============================================================
-- LAMINATIWORD · FASE 1 · VERIFICACIÓN
-- ============================================================


-- 1. Tablas creadas
SELECT
  tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'post_sale_survey_invitations',
    'post_sale_survey_responses',
    'product_reviews'
  )
ORDER BY tablename;


-- 2. Vista SEO creada
SELECT
  schemaname,
  viewname
FROM pg_views
WHERE schemaname = 'public'
  AND viewname = 'vw_product_review_summary';


-- 3. Columnas principales
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'post_sale_survey_invitations',
    'post_sale_survey_responses',
    'product_reviews'
  )
ORDER BY
  table_name,
  ordinal_position;


-- 4. Constraints
SELECT
  conrelid::regclass AS tabla,
  conname AS constraint_name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  'post_sale_survey_invitations'::regclass,
  'post_sale_survey_responses'::regclass,
  'product_reviews'::regclass
)
ORDER BY
  conrelid::regclass::text,
  conname;


-- 5. Triggers
SELECT
  event_object_table AS tabla,
  trigger_name
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table IN (
    'post_sale_survey_invitations',
    'post_sale_survey_responses',
    'product_reviews'
  )
ORDER BY
  event_object_table,
  trigger_name;


-- 6. Estado actual de órdenes para referencia
SELECT
  status,
  COUNT(*) AS cantidad
FROM orders
GROUP BY status
ORDER BY status;


-- 7. Órdenes WEB COMPLETED que serán candidatas
--    para la automatización de la Fase 4.
SELECT
  COUNT(*) AS completed_web_orders
FROM orders
WHERE
  status = 'COMPLETED'
  AND source = 'WEB';
