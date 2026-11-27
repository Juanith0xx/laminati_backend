BEGIN;

CREATE TABLE IF NOT EXISTS mailing_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL,
  first_name varchar(120),
  last_name varchar(120),
  company_name varchar(180),
  phone varchar(60),
  source varchar(60) NOT NULL DEFAULT 'MANUAL',
  status varchar(30) NOT NULL DEFAULT 'SUBSCRIBED',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_contacts_email_unique UNIQUE (email),
  CONSTRAINT mailing_contacts_status_check CHECK (status IN ('SUBSCRIBED','UNSUBSCRIBED','BOUNCED','SUPPRESSED'))
);

CREATE INDEX IF NOT EXISTS idx_mailing_contacts_status ON mailing_contacts(status);
CREATE INDEX IF NOT EXISTS idx_mailing_contacts_created_at ON mailing_contacts(created_at DESC);

CREATE TABLE IF NOT EXISTS mailing_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  description text,
  status varchar(30) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_segments_status_check CHECK (status IN ('ACTIVE','ARCHIVED'))
);

CREATE TABLE IF NOT EXISTS mailing_segment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id uuid NOT NULL REFERENCES mailing_segments(id) ON DELETE CASCADE,
  field varchar(80) NOT NULL,
  operator varchar(40) NOT NULL,
  value jsonb NOT NULL DEFAULT 'null'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mailing_segment_rules_segment ON mailing_segment_rules(segment_id);

CREATE TABLE IF NOT EXISTS mailing_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(180) NOT NULL,
  subject varchar(255) NOT NULL,
  preview_text varchar(255),
  html_content text NOT NULL DEFAULT '',
  text_content text,
  status varchar(30) NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_templates_status_check CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED'))
);

CREATE TABLE IF NOT EXISTS mailing_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(180) NOT NULL,
  subject varchar(255) NOT NULL,
  preview_text varchar(255),
  template_id uuid REFERENCES mailing_templates(id) ON DELETE SET NULL,
  segment_id uuid REFERENCES mailing_segments(id) ON DELETE SET NULL,
  sender_name varchar(160),
  sender_email varchar(320),
  reply_to varchar(320),
  status varchar(30) NOT NULL DEFAULT 'DRAFT',
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_campaigns_status_check CHECK (status IN ('DRAFT','SCHEDULED','SENDING','SENT','CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_mailing_campaigns_status ON mailing_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_mailing_campaigns_scheduled_at ON mailing_campaigns(scheduled_at);

CREATE TABLE IF NOT EXISTS mailing_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES mailing_campaigns(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES mailing_contacts(id) ON DELETE SET NULL,
  email varchar(320) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'PENDING',
  provider_message_id varchar(255),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_campaign_recipients_status_check CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  CONSTRAINT mailing_campaign_recipient_unique UNIQUE (campaign_id, email)
);

CREATE INDEX IF NOT EXISTS idx_mailing_campaign_recipients_campaign ON mailing_campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mailing_campaign_recipients_status ON mailing_campaign_recipients(status);

CREATE TABLE IF NOT EXISTS mailing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES mailing_campaigns(id) ON DELETE CASCADE,
  recipient_id uuid REFERENCES mailing_campaign_recipients(id) ON DELETE CASCADE,
  event_type varchar(40) NOT NULL,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_events_type_check CHECK (event_type IN ('DELIVERED','OPENED','CLICKED','BOUNCED','COMPLAINED','UNSUBSCRIBED'))
);

CREATE INDEX IF NOT EXISTS idx_mailing_events_campaign ON mailing_events(campaign_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS mailing_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NOT NULL,
  reason varchar(40) NOT NULL,
  source varchar(60) NOT NULL DEFAULT 'MANUAL',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailing_suppressions_email_unique UNIQUE (email),
  CONSTRAINT mailing_suppressions_reason_check CHECK (reason IN ('UNSUBSCRIBED','BOUNCE','COMPLAINT','MANUAL'))
);

COMMIT;
