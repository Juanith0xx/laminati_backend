\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS quotation_project_management (
  quotation_id UUID PRIMARY KEY REFERENCES quotations(id) ON DELETE CASCADE,
  stage VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
    CHECK (stage IN ('DRAFT','SENT','REVIEW','NEGOTIATION','APPROVED','WON','LOST')),
  priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'
    CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  next_action TEXT,
  next_action_at TIMESTAMPTZ,
  lost_reason TEXT,
  won_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qpm_stage
  ON quotation_project_management(stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_qpm_assigned
  ON quotation_project_management(assigned_to, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_qpm_next_action
  ON quotation_project_management(next_action_at)
  WHERE next_action_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS quotation_project_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  event_type VARCHAR(60) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qpe_quotation_event_at
  ON quotation_project_events(quotation_id, event_at DESC);

CREATE TABLE IF NOT EXISTS quotation_project_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  followup_type VARCHAR(40) NOT NULL DEFAULT 'FOLLOW_UP'
    CHECK (followup_type IN ('CALL','MEETING','EMAIL','FOLLOW_UP','TECHNICAL_MEETING','SAMPLE_DELIVERY','MILESTONE','OTHER')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','COMPLETED','CANCELLED')),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qpf_schedule
  ON quotation_project_followups(scheduled_at, status);
CREATE INDEX IF NOT EXISTS idx_qpf_quotation
  ON quotation_project_followups(quotation_id, scheduled_at);

CREATE OR REPLACE FUNCTION set_project_board_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qpm_updated_at ON quotation_project_management;
CREATE TRIGGER trg_qpm_updated_at
BEFORE UPDATE ON quotation_project_management
FOR EACH ROW EXECUTE FUNCTION set_project_board_updated_at();

DROP TRIGGER IF EXISTS trg_qpf_updated_at ON quotation_project_followups;
CREATE TRIGGER trg_qpf_updated_at
BEFORE UPDATE ON quotation_project_followups
FOR EACH ROW EXECUTE FUNCTION set_project_board_updated_at();

CREATE OR REPLACE FUNCTION ensure_project_board_for_quotation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  initial_stage VARCHAR(30);
BEGIN
  IF UPPER(COALESCE(NEW.quotation_type, '')) <> 'PROJECT' THEN
    RETURN NEW;
  END IF;

  initial_stage :=
    CASE
      WHEN NEW.status = 'SENT' THEN 'SENT'
      WHEN NEW.status = 'ACCEPTED' THEN 'APPROVED'
      WHEN NEW.status IN ('REJECTED','CANCELLED') THEN 'LOST'
      ELSE 'DRAFT'
    END;

  INSERT INTO quotation_project_management (
    quotation_id, stage, assigned_to, last_activity_at
  )
  VALUES (
    NEW.id, initial_stage, NEW.created_by, NOW()
  )
  ON CONFLICT (quotation_id)
  DO UPDATE SET
    stage = CASE
      WHEN quotation_project_management.stage = 'DRAFT' AND NEW.status = 'SENT' THEN 'SENT'
      WHEN quotation_project_management.stage NOT IN ('WON','LOST') AND NEW.status = 'ACCEPTED' THEN 'APPROVED'
      WHEN quotation_project_management.stage NOT IN ('WON','LOST') AND NEW.status IN ('REJECTED','CANCELLED') THEN 'LOST'
      ELSE quotation_project_management.stage
    END,
    last_activity_at = NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_project_board_for_quotation ON quotations;
CREATE TRIGGER trg_ensure_project_board_for_quotation
AFTER INSERT OR UPDATE OF quotation_type, status, sent_at
ON quotations
FOR EACH ROW EXECUTE FUNCTION ensure_project_board_for_quotation();

INSERT INTO quotation_project_management (
  quotation_id, stage, assigned_to, last_activity_at
)
SELECT
  q.id,
  CASE
    WHEN q.status = 'SENT' THEN 'SENT'
    WHEN q.status = 'ACCEPTED' THEN 'APPROVED'
    WHEN q.status IN ('REJECTED','CANCELLED') THEN 'LOST'
    ELSE 'DRAFT'
  END,
  q.created_by,
  COALESCE(q.sent_at, q.updated_at, q.created_at, NOW())
FROM quotations q
WHERE q.quotation_type = 'PROJECT'
ON CONFLICT (quotation_id) DO NOTHING;

INSERT INTO quotation_project_events (
  quotation_id, event_type, title, description, actor_user_id, event_at
)
SELECT
  q.id,
  'QUOTATION_CREATED',
  'Cotización de proyecto creada',
  q.quote_number,
  q.created_by,
  q.created_at
FROM quotations q
WHERE q.quotation_type = 'PROJECT'
AND NOT EXISTS (
  SELECT 1 FROM quotation_project_events e
  WHERE e.quotation_id = q.id
    AND e.event_type = 'QUOTATION_CREATED'
);

COMMIT;
