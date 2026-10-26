CREATE TABLE IF NOT EXISTS auth_login_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NULL
    REFERENCES users(id)
    ON DELETE SET NULL,
  email VARCHAR(255),
  event_type VARCHAR(30) NOT NULL,
  success BOOLEAN NOT NULL DEFAULT TRUE,
  ip_address VARCHAR(100),
  user_agent TEXT,
  device_type VARCHAR(30),
  browser VARCHAR(100),
  operating_system VARCHAR(100),
  failure_reason VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_login_events_event_type_check
    CHECK (
      event_type IN (
        'LOGIN_SUCCESS',
        'LOGIN_FAILED',
        'LOGOUT'
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_auth_login_events_user_id
ON auth_login_events(user_id);

CREATE INDEX IF NOT EXISTS idx_auth_login_events_email
ON auth_login_events(email);

CREATE INDEX IF NOT EXISTS idx_auth_login_events_created_at
ON auth_login_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_login_events_event_type
ON auth_login_events(event_type);
