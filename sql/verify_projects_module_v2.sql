/* =========================================================
   VERIFY — PROJECTS MODULE V2
========================================================= */

SELECT
  table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'projects',
    'project_images',
    'project_products'
  )
ORDER BY table_name;


SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'projects'
ORDER BY ordinal_position;


SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'project_images'
ORDER BY ordinal_position;


SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'project_products'
ORDER BY ordinal_position;


SELECT
  conname AS constraint_name,
  conrelid::regclass AS table_name,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN (
  'public.projects'::regclass,
  'public.project_images'::regclass,
  'public.project_products'::regclass
)
ORDER BY
  conrelid::regclass::text,
  conname;


SELECT
  tablename,
  indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'projects',
    'project_images',
    'project_products'
  )
ORDER BY
  tablename,
  indexname;


SELECT
  event_object_table AS table_name,
  trigger_name,
  action_timing,
  event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND event_object_table IN (
    'projects',
    'project_images',
    'project_products'
  )
ORDER BY
  event_object_table,
  trigger_name,
  event_manipulation;


SELECT
  table_name
FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name = 'vw_public_projects';


SELECT
  status,
  is_published,
  is_active,
  COUNT(*) AS total
FROM public.projects
GROUP BY
  status,
  is_published,
  is_active
ORDER BY
  status,
  is_published,
  is_active;


SELECT
  COUNT(*) AS public_projects
FROM public.vw_public_projects;


/* Compatibilidad esperada: cero filas */
SELECT
  id,
  title,
  project_type,
  category,
  is_published,
  status
FROM public.projects
WHERE
  COALESCE(project_type, '') <> COALESCE(category, '')
  OR (
    is_published = TRUE
    AND status <> 'PUBLISHED'
  )
  OR (
    is_published = FALSE
    AND status = 'PUBLISHED'
  );
