BEGIN;

CREATE TABLE IF NOT EXISTS tax_document_emission_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  tax_document_id uuid,
  requested_by uuid,
  status varchar(40) NOT NULL DEFAULT 'QUEUED',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  processing_started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  last_error_code varchar(160),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT tax_document_emission_jobs_order_fk
    FOREIGN KEY (order_id)
    REFERENCES orders(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  CONSTRAINT tax_document_emission_jobs_tax_document_fk
    FOREIGN KEY (tax_document_id)
    REFERENCES tax_documents(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  CONSTRAINT tax_document_emission_jobs_requested_by_fk
    FOREIGN KEY (requested_by)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  CONSTRAINT tax_document_emission_jobs_order_unique
    UNIQUE (order_id),

  CONSTRAINT tax_document_emission_jobs_status_check
    CHECK (
      status IN (
        'QUEUED',
        'PROCESSING',
        'COMPLETED',
        'BLOCKED',
        'FAILED',
        'REQUIRES_RECONCILIATION'
      )
    ),

  CONSTRAINT tax_document_emission_jobs_attempts_check
    CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_document_emission_jobs_tax_document
  ON tax_document_emission_jobs(tax_document_id)
  WHERE tax_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tax_document_emission_jobs_queue
  ON tax_document_emission_jobs(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_tax_document_emission_jobs_order
  ON tax_document_emission_jobs(order_id);

COMMIT;
