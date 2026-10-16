BEGIN;

CREATE TABLE IF NOT EXISTS quotation_daily_sequences (
  sequence_date date PRIMARY KEY,
  last_value integer NOT NULL CHECK (last_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION generate_quotation_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  current_date_local date := (now() AT TIME ZONE 'America/Santiago')::date;
  next_value integer;
BEGIN
  INSERT INTO quotation_daily_sequences (
    sequence_date,
    last_value,
    updated_at
  )
  VALUES (
    current_date_local,
    1,
    now()
  )
  ON CONFLICT (sequence_date)
  DO UPDATE SET
    last_value = quotation_daily_sequences.last_value + 1,
    updated_at = now()
  RETURNING last_value
  INTO next_value;

  RETURN 'COT-' ||
    to_char(current_date_local, 'DDMMYY') ||
    '-' ||
    lpad(next_value::text, 6, '0');
END;
$$;

CREATE TABLE IF NOT EXISTS quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number varchar(40) NOT NULL UNIQUE DEFAULT generate_quotation_number(),
  created_by uuid NOT NULL REFERENCES users(id),

  intended_document_type varchar(20) NOT NULL
    CHECK (intended_document_type IN ('BOLETA', 'FACTURA')),
  customer_type varchar(20) NOT NULL
    CHECK (customer_type IN ('PERSON', 'COMPANY')),

  rut varchar(20) NOT NULL,
  customer_name varchar(255) NOT NULL,
  legal_name varchar(255),
  trade_name varchar(255),
  business_activity varchar(255),
  email varchar(255) NOT NULL,
  phone varchar(40) NOT NULL,
  address_line text NOT NULL,
  commune varchar(120),
  city varchar(120),
  region varchar(120),
  country varchar(120) NOT NULL DEFAULT 'Chile',
  relbase_customer_id text,

  status varchar(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT',
      'SENT',
      'ACCEPTED',
      'REJECTED',
      'EXPIRED',
      'CONVERTED',
      'CANCELLED'
    )),

  currency varchar(10) NOT NULL DEFAULT 'CLP',
  net_total numeric(14,2) NOT NULL CHECK (net_total >= 0),
  tax_total numeric(14,2) NOT NULL CHECK (tax_total >= 0),
  total numeric(14,2) NOT NULL CHECK (total >= 0),

  valid_until date NOT NULL,
  notes text,
  sent_at timestamptz,

  conversion_idempotency_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  converted_order_id uuid UNIQUE REFERENCES orders(id),
  converted_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotations_created_by_created_at
  ON quotations (created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quotations_status_valid_until
  ON quotations (status, valid_until);

CREATE INDEX IF NOT EXISTS idx_quotations_rut
  ON quotations (rut);

CREATE TABLE IF NOT EXISTS quotation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id uuid NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  sku varchar(120) NOT NULL,
  product_name text NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price_gross numeric(14,2) NOT NULL CHECK (unit_price_gross > 0),
  unit_price_net numeric(14,2) NOT NULL CHECK (unit_price_net >= 0),
  tax_rate numeric(8,2) NOT NULL CHECK (tax_rate >= 0),
  line_net numeric(14,2) NOT NULL CHECK (line_net >= 0),
  line_tax numeric(14,2) NOT NULL CHECK (line_tax >= 0),
  line_total numeric(14,2) NOT NULL CHECK (line_total >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quotation_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_quotation_items_quotation
  ON quotation_items (quotation_id);

CREATE OR REPLACE FUNCTION set_quotations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quotations_updated_at ON quotations;
CREATE TRIGGER trg_quotations_updated_at
BEFORE UPDATE ON quotations
FOR EACH ROW
EXECUTE FUNCTION set_quotations_updated_at();

COMMIT;
