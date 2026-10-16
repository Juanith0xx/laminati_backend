-- =========================================================
-- VERIFICACIÓN PASO 1
-- =========================================================

SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'quotations'
  AND column_name IN (
    'quotation_type',
    'project_name',
    'project_reference'
  )
ORDER BY ordinal_position;


SELECT
  table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'quotation_project_lines';


\d+ quotation_project_lines


SELECT
  quotation_type,
  COUNT(*) AS total
FROM public.quotations
GROUP BY quotation_type
ORDER BY quotation_type;


SELECT
  conname,
  pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid =
  'public.quotation_project_lines'::regclass
ORDER BY conname;
