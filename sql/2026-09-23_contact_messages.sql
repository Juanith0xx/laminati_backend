BEGIN;

CREATE TABLE IF NOT EXISTS public.contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name varchar(120) NOT NULL,
  last_name varchar(120) NOT NULL,
  company_name varchar(255),
  email varchar(255) NOT NULL,
  phone varchar(30) NOT NULL,
  subject varchar(40) NOT NULL,
  message text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'NEW',
  source varchar(30) NOT NULL DEFAULT 'WEB',
  read_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_messages_subject_check CHECK (
    subject IN ('QUOTE', 'PRODUCT', 'STOCK', 'BUSINESS', 'PROJECT', 'OTHER')
  ),
  CONSTRAINT contact_messages_status_check CHECK (
    status IN ('NEW', 'READ', 'RESPONDED', 'CLOSED')
  ),
  CONSTRAINT contact_messages_source_check CHECK (
    source IN ('WEB')
  ),
  CONSTRAINT contact_messages_first_name_not_empty CHECK (length(btrim(first_name)) > 0),
  CONSTRAINT contact_messages_last_name_not_empty CHECK (length(btrim(last_name)) > 0),
  CONSTRAINT contact_messages_email_not_empty CHECK (length(btrim(email)) > 0),
  CONSTRAINT contact_messages_phone_not_empty CHECK (length(btrim(phone)) > 0),
  CONSTRAINT contact_messages_message_not_empty CHECK (length(btrim(message)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_status_created
  ON public.contact_messages (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_messages_email
  ON public.contact_messages (lower(email));

CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
  ON public.contact_messages (created_at DESC);

COMMIT;
