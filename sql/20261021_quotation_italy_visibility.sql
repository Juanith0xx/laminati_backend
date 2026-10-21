BEGIN;

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS visible_to_italy BOOLEAN;

UPDATE quotations
SET visible_to_italy = FALSE
WHERE visible_to_italy IS NULL;

ALTER TABLE quotations
  ALTER COLUMN visible_to_italy SET DEFAULT FALSE;

ALTER TABLE quotations
  ALTER COLUMN visible_to_italy SET NOT NULL;

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS italy_visibility_set_at TIMESTAMPTZ;

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS italy_visibility_set_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'quotations_italy_visibility_set_by_fkey'
  ) THEN
    ALTER TABLE quotations
      ADD CONSTRAINT quotations_italy_visibility_set_by_fkey
      FOREIGN KEY (italy_visibility_set_by)
      REFERENCES users(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_quotations_project_visible_italy
  ON quotations(created_at DESC)
  WHERE quotation_type = 'PROJECT'
    AND visible_to_italy = TRUE;

COMMIT;

-- Verificación:
-- SELECT
--   quote_number,
--   quotation_type,
--   project_name,
--   visible_to_italy,
--   italy_visibility_set_at
-- FROM quotations
-- ORDER BY created_at DESC
-- LIMIT 20;
