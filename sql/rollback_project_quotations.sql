BEGIN;

DROP TABLE IF EXISTS public.quotation_project_lines CASCADE;

DROP INDEX IF EXISTS public.idx_quotations_type_status_created_at;

ALTER TABLE public.quotations
  DROP CONSTRAINT IF EXISTS quotations_quotation_type_check;

ALTER TABLE public.quotations
  DROP COLUMN IF EXISTS project_reference;

ALTER TABLE public.quotations
  DROP COLUMN IF EXISTS project_name;

ALTER TABLE public.quotations
  DROP COLUMN IF EXISTS quotation_type;

COMMIT;
