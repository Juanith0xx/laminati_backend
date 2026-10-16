BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS deleted_by uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_deleted_by_fkey'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_deleted_by_fkey
      FOREIGN KEY (deleted_by)
      REFERENCES public.users(id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at
  ON public.users (deleted_at);

CREATE INDEX IF NOT EXISTS idx_users_admin_management
  ON public.users (is_active, role_id, created_at DESC)
  WHERE deleted_at IS NULL;

COMMIT;
