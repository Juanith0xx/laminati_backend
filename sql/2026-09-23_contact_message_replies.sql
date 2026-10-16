BEGIN;

CREATE TABLE IF NOT EXISTS public.contact_message_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  contact_message_id uuid NOT NULL
    REFERENCES public.contact_messages(id)
    ON DELETE CASCADE,

  admin_user_id uuid
    REFERENCES public.users(id)
    ON DELETE SET NULL,

  recipient_email varchar(255) NOT NULL,
  subject varchar(255) NOT NULL,
  message text NOT NULL,

  delivery_status varchar(20) NOT NULL
    DEFAULT 'PENDING',

  provider_message_id varchar(255),
  error_message varchar(1000),

  sent_at timestamptz,
  created_at timestamptz NOT NULL
    DEFAULT NOW(),

  CONSTRAINT contact_message_replies_delivery_status_check
    CHECK (
      delivery_status IN (
        'PENDING',
        'SENT',
        'FAILED'
      )
    ),

  CONSTRAINT contact_message_replies_recipient_email_not_blank
    CHECK (
      LENGTH(TRIM(recipient_email)) > 0
    ),

  CONSTRAINT contact_message_replies_subject_not_blank
    CHECK (
      LENGTH(TRIM(subject)) > 0
    ),

  CONSTRAINT contact_message_replies_message_not_blank
    CHECK (
      LENGTH(TRIM(message)) > 0
    )
);

CREATE INDEX IF NOT EXISTS
  idx_contact_message_replies_contact_created
ON public.contact_message_replies (
  contact_message_id,
  created_at
);

CREATE INDEX IF NOT EXISTS
  idx_contact_message_replies_admin_user
ON public.contact_message_replies (
  admin_user_id,
  created_at
);

COMMIT;
