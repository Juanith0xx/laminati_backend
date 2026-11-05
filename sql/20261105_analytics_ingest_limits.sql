-- Ejecutar una sola vez, antes de desplegar el backend modificado.
BEGIN;
CREATE TABLE IF NOT EXISTS analytics_ingest_limits (
  visitor_hash VARCHAR(64) NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  new_sessions INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (visitor_hash, window_start)
);
CREATE INDEX IF NOT EXISTS idx_analytics_ingest_limits_updated_at
  ON analytics_ingest_limits (updated_at);
COMMIT;
-- Limpieza opcional semanal:
-- DELETE FROM analytics_ingest_limits WHERE updated_at < now() - INTERVAL '3 days';
