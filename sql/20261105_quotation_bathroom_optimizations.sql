BEGIN;

CREATE TABLE IF NOT EXISTS quotation_bathroom_optimizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  quotation_id UUID NOT NULL
    REFERENCES quotations(id)
    ON DELETE CASCADE,

  optimizer_version VARCHAR(32) NOT NULL,
  kerf_model VARCHAR(64),

  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  optimization_json JSONB NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_quotation_bathroom_optimizations_quotation
  ON quotation_bathroom_optimizations(quotation_id);

CREATE INDEX IF NOT EXISTS idx_quotation_bathroom_optimizations_created_at
  ON quotation_bathroom_optimizations(created_at DESC);

COMMIT;

-- Verificación rápida:
-- SELECT
--   q.quote_number,
--   q.quotation_type,
--   qbo.optimizer_version,
--   qbo.kerf_model,
--   qbo.created_at
-- FROM quotation_bathroom_optimizations qbo
-- JOIN quotations q ON q.id = qbo.quotation_id
-- ORDER BY qbo.created_at DESC
-- LIMIT 20;
