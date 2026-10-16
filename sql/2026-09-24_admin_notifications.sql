BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  type varchar(50) NOT NULL,
  title varchar(160) NOT NULL,
  message varchar(500) NOT NULL,

  entity_id varchar(120),
  href varchar(500),

  data jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT admin_notifications_type_not_blank
    CHECK (LENGTH(TRIM(type)) > 0),

  CONSTRAINT admin_notifications_title_not_blank
    CHECK (LENGTH(TRIM(title)) > 0),

  CONSTRAINT admin_notifications_message_not_blank
    CHECK (LENGTH(TRIM(message)) > 0),

  CONSTRAINT admin_notifications_data_object
    CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE IF NOT EXISTS public.admin_notification_reads (
  notification_id uuid NOT NULL
    REFERENCES public.admin_notifications(id)
    ON DELETE CASCADE,

  user_id uuid NOT NULL
    REFERENCES public.users(id)
    ON DELETE CASCADE,

  read_at timestamptz NOT NULL DEFAULT NOW(),

  PRIMARY KEY (
    notification_id,
    user_id
  )
);

CREATE INDEX IF NOT EXISTS
  idx_admin_notifications_created_at
ON public.admin_notifications (
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  idx_admin_notifications_type_created
ON public.admin_notifications (
  type,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  idx_admin_notification_reads_user
ON public.admin_notification_reads (
  user_id,
  read_at DESC
);

COMMIT;
