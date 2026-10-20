CREATE TABLE IF NOT EXISTS relbase_customer_sync_state (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  next_page INTEGER NOT NULL DEFAULT 1,
  total_pages INTEGER,
  total_count INTEGER,
  completed_at TIMESTAMPTZ,
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ck_relbase_customer_sync_state_singleton
    CHECK (id = 1),

  CONSTRAINT ck_relbase_customer_sync_state_next_page
    CHECK (next_page >= 1)
);

INSERT INTO relbase_customer_sync_state (
  id,
  next_page
)
VALUES (1, 1)
ON CONFLICT (id)
DO NOTHING;
