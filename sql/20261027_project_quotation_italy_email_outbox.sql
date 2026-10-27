BEGIN;

-- ============================================================
-- EMAIL OUTBOX · COTIZACIONES PROJECT PARA GERENCIA ITALIA
-- ============================================================

ALTER TABLE public.email_outbox
  ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE public.email_outbox
  ADD COLUMN IF NOT EXISTS quotation_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'email_outbox_quotation_id_fkey'
  ) THEN
    ALTER TABLE public.email_outbox
      ADD CONSTRAINT email_outbox_quotation_id_fkey
      FOREIGN KEY (quotation_id)
      REFERENCES public.quotations(id)
      ON DELETE CASCADE;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS
  idx_email_outbox_quotation_id
ON public.email_outbox(quotation_id);

CREATE UNIQUE INDEX IF NOT EXISTS
  uq_email_outbox_project_quote_recipient
ON public.email_outbox (
  quotation_id,
  event_type,
  LOWER(recipient_email)
)
WHERE quotation_id IS NOT NULL
  AND event_type = 'PROJECT_QUOTATION_CREATED_ITALY';

COMMIT;

-- ============================================================
-- VERIFICACIÓN
-- ============================================================
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'email_outbox'
  AND column_name IN (
    'order_id',
    'quotation_id'
  )
ORDER BY column_name;

SELECT
  indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'email_outbox'
  AND indexname IN (
    'idx_email_outbox_quotation_id',
    'uq_email_outbox_project_quote_recipient'
  )
ORDER BY indexname;
