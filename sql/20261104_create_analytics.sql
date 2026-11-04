BEGIN;

CREATE TABLE IF NOT EXISTS analytics_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key VARCHAR(100) NOT NULL UNIQUE,
  country_code VARCHAR(10),
  region_code VARCHAR(30),
  city VARCHAR(150),
  commune VARCHAR(150),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  device_type VARCHAR(30),
  landing_page TEXT,
  referrer TEXT,
  utm_source VARCHAR(150),
  utm_medium VARCHAR(150),
  utm_campaign VARCHAR(150),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL
    REFERENCES analytics_sessions(id)
    ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  page_path TEXT,
  product_id UUID,
  product_code VARCHAR(100),
  collection_slug VARCHAR(150),
  search_term TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_sessions_first_seen
  ON analytics_sessions(first_seen_at);

CREATE INDEX IF NOT EXISTS idx_analytics_sessions_city
  ON analytics_sessions(city);

CREATE INDEX IF NOT EXISTS idx_analytics_sessions_commune
  ON analytics_sessions(commune);

CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
  ON analytics_events(created_at);

CREATE INDEX IF NOT EXISTS idx_analytics_events_type
  ON analytics_events(event_type);

CREATE INDEX IF NOT EXISTS idx_analytics_events_product_code
  ON analytics_events(product_code);

CREATE INDEX IF NOT EXISTS idx_analytics_events_collection
  ON analytics_events(collection_slug);

COMMIT;
