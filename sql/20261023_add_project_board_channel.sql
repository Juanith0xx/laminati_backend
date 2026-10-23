BEGIN;

ALTER TABLE public.quotation_project_management
  ADD COLUMN IF NOT EXISTS channel text;

ALTER TABLE public.quotation_project_management
  DROP CONSTRAINT IF EXISTS quotation_project_management_channel_check;

ALTER TABLE public.quotation_project_management
  ADD CONSTRAINT quotation_project_management_channel_check
  CHECK (
    channel IS NULL
    OR channel IN (
      'EMAIL',
      'WHATSAPP',
      'PHONE',
      'SHOWROOM',
      'WEB'
    )
  );

CREATE INDEX IF NOT EXISTS idx_quotation_project_management_channel
  ON public.quotation_project_management (channel)
  WHERE channel IS NOT NULL;

COMMIT;
