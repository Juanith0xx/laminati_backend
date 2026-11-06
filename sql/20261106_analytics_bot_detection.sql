BEGIN;
ALTER TABLE public.analytics_sessions
  ADD COLUMN IF NOT EXISTS bot_reason varchar(100),
  ADD COLUMN IF NOT EXISTS bot_detected_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_analytics_sessions_bot_window
  ON public.analytics_sessions (country_code, first_seen_at DESC)
  WHERE device_type = 'desktop' AND landing_page LIKE '/productos/laminados?%';

CREATE INDEX IF NOT EXISTS idx_analytics_events_session_event
  ON public.analytics_events (session_id, event_type);
COMMIT;
