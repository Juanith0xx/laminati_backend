-- Dashboard: clasificaciones comerciales independientes de colección y precio.
-- Respaldar la BD antes. No cambia pagos, órdenes, inventario ni productos existentes.
-- Nombres iniciales tentativos, sin reglas ni asignación automática.
BEGIN;

CREATE TABLE IF NOT EXISTS commercial_segments (
  slug text PRIMARY KEY,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT commercial_segments_slug_valid CHECK (slug ~ '^[a-z0-9_]{1,40}$')
);

CREATE TABLE IF NOT EXISTS product_commercial_segments (
  product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  segment_slug text NOT NULL REFERENCES commercial_segments(slug),
  assigned_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_commercial_segments_slug
  ON product_commercial_segments(segment_slug);

INSERT INTO commercial_segments (slug, name)
VALUES ('comodin', 'Comodín (por definir)'),
       ('commodity_caros', 'Commodity caros (por definir)')
ON CONFLICT (slug) DO NOTHING;

COMMIT;

-- No se asignan SKU automáticamente. Primero acordar qué productos corresponden.
-- Ejemplo SOLO después de validar el SKU, NO EJECUTAR como parte de la migración:
-- INSERT INTO product_commercial_segments (product_id, segment_slug)
-- SELECT id, 'comodin' FROM products WHERE sku = 'SKU_VALIDADO'
-- ON CONFLICT (product_id) DO UPDATE SET segment_slug = EXCLUDED.segment_slug;
