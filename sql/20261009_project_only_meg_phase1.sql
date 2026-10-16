BEGIN;

CREATE TABLE IF NOT EXISTS project_product_families (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  application VARCHAR(120),
  default_core VARCHAR(120),
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_product_families_code_not_empty CHECK (TRIM(code) <> ''),
  CONSTRAINT project_product_families_name_not_empty CHECK (TRIM(name) <> '')
);

CREATE TABLE IF NOT EXISTS project_family_formats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES project_product_families(id) ON DELETE CASCADE,
  label VARCHAR(120) NOT NULL,
  length_cm NUMERIC(10,2) NOT NULL,
  width_cm NUMERIC(10,2) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_family_formats_dimensions_positive CHECK (length_cm > 0 AND width_cm > 0),
  CONSTRAINT project_family_formats_sort_order_check CHECK (sort_order >= 0),
  CONSTRAINT project_family_formats_unique UNIQUE (family_id, length_cm, width_cm)
);

CREATE TABLE IF NOT EXISTS project_family_finishes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES project_product_families(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_family_finishes_name_not_empty CHECK (TRIM(name) <> ''),
  CONSTRAINT project_family_finishes_sort_order_check CHECK (sort_order >= 0),
  CONSTRAINT project_family_finishes_unique UNIQUE (family_id, name)
);

CREATE TABLE IF NOT EXISTS project_family_thicknesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES project_product_families(id) ON DELETE CASCADE,
  thickness_mm NUMERIC(10,2) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_family_thicknesses_positive CHECK (thickness_mm > 0),
  CONSTRAINT project_family_thicknesses_sort_order_check CHECK (sort_order >= 0),
  CONSTRAINT project_family_thicknesses_unique UNIQUE (family_id, thickness_mm)
);

CREATE TABLE IF NOT EXISTS project_family_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES project_product_families(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  document_type VARCHAR(60) NOT NULL DEFAULT 'TECHNICAL_SHEET',
  document_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT project_family_documents_title_not_empty CHECK (TRIM(title) <> ''),
  CONSTRAINT project_family_documents_url_not_empty CHECK (TRIM(document_url) <> ''),
  CONSTRAINT project_family_documents_sort_order_check CHECK (sort_order >= 0)
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS commercial_mode VARCHAR(30) NOT NULL DEFAULT 'WEB';
ALTER TABLE products ADD COLUMN IF NOT EXISTS project_family_id UUID;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_commercial_mode_valid') THEN
    ALTER TABLE products ADD CONSTRAINT products_commercial_mode_valid CHECK (commercial_mode IN ('WEB','PROJECT_ONLY'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_project_family_id_fkey') THEN
    ALTER TABLE products ADD CONSTRAINT products_project_family_id_fkey FOREIGN KEY (project_family_id) REFERENCES project_product_families(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_project_only_family_required') THEN
    ALTER TABLE products ADD CONSTRAINT products_project_only_family_required CHECK (commercial_mode <> 'PROJECT_ONLY' OR project_family_id IS NOT NULL);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_project_only_not_saleable') THEN
    ALTER TABLE products ADD CONSTRAINT products_project_only_not_saleable CHECK (commercial_mode <> 'PROJECT_ONLY' OR allow_sale = FALSE);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_commercial_mode ON products(commercial_mode);
CREATE INDEX IF NOT EXISTS idx_products_project_family_id ON products(project_family_id);
CREATE INDEX IF NOT EXISTS idx_project_family_formats_family ON project_family_formats(family_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_project_family_finishes_family ON project_family_finishes(family_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_project_family_thicknesses_family ON project_family_thicknesses(family_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_project_family_documents_family ON project_family_documents(family_id, sort_order);

DROP TRIGGER IF EXISTS trg_project_product_families_updated_at ON project_product_families;
CREATE TRIGGER trg_project_product_families_updated_at BEFORE UPDATE ON project_product_families FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_project_family_formats_updated_at ON project_family_formats;
CREATE TRIGGER trg_project_family_formats_updated_at BEFORE UPDATE ON project_family_formats FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_project_family_finishes_updated_at ON project_family_finishes;
CREATE TRIGGER trg_project_family_finishes_updated_at BEFORE UPDATE ON project_family_finishes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_project_family_thicknesses_updated_at ON project_family_thicknesses;
CREATE TRIGGER trg_project_family_thicknesses_updated_at BEFORE UPDATE ON project_family_thicknesses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_project_family_documents_updated_at ON project_family_documents;
CREATE TRIGGER trg_project_family_documents_updated_at BEFORE UPDATE ON project_family_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO project_product_families (code,name,application,default_core,description,is_active)
VALUES ('MEG','MEG','Exterior','Brown','Panel HPL para fachadas ventiladas y soluciones arquitectónicas de exterior. Producto a pedido para proyectos.',TRUE)
ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, application=EXCLUDED.application, default_core=EXCLUDED.default_core, description=EXCLUDED.description, is_active=TRUE;

INSERT INTO project_family_formats (family_id,label,length_cm,width_cm,sort_order)
SELECT f.id,v.label,v.length_cm,v.width_cm,v.sort_order
FROM project_product_families f
CROSS JOIN (VALUES ('305 × 130 cm',305.00::numeric,130.00::numeric,10),('420 × 130 cm',420.00::numeric,130.00::numeric,20),('420 × 161 cm',420.00::numeric,161.00::numeric,30)) AS v(label,length_cm,width_cm,sort_order)
WHERE f.code='MEG'
ON CONFLICT (family_id,length_cm,width_cm) DO UPDATE SET label=EXCLUDED.label,sort_order=EXCLUDED.sort_order,is_active=TRUE;

INSERT INTO project_family_finishes (family_id,name,sort_order)
SELECT f.id,v.name,v.sort_order FROM project_product_families f
CROSS JOIN (VALUES ('Sei',10),('Sei Due',20),('Climb',30)) AS v(name,sort_order)
WHERE f.code='MEG'
ON CONFLICT (family_id,name) DO UPDATE SET sort_order=EXCLUDED.sort_order,is_active=TRUE;

INSERT INTO project_family_thicknesses (family_id,thickness_mm,sort_order)
SELECT f.id,v.thickness_mm,v.sort_order FROM project_product_families f
CROSS JOIN (VALUES (1.20::numeric,10),(2.00::numeric,20),(2.50::numeric,30),(3.00::numeric,40),(4.00::numeric,50),(5.00::numeric,60),(6.00::numeric,70),(7.00::numeric,80),(8.00::numeric,90),(9.00::numeric,100),(10.00::numeric,110),(11.00::numeric,120),(12.00::numeric,130),(13.00::numeric,140),(14.00::numeric,150),(15.00::numeric,160),(16.00::numeric,170),(18.00::numeric,180)) AS v(thickness_mm,sort_order)
WHERE f.code='MEG'
ON CONFLICT (family_id,thickness_mm) DO UPDATE SET sort_order=EXCLUDED.sort_order,is_active=TRUE;

CREATE OR REPLACE VIEW vw_product_catalog AS
SELECT p.id,
p.sku,
p.internal_code,
p.relbase_product_id,
p.name,
p.slug,
p.short_description,
p.description,
p.category_id,
cat.name AS category,
cat.slug AS category_slug,
p.brand_id,
br.name AS brand,
br.slug AS brand_slug,
p.collection_id,
col.name AS collection,
col.slug AS collection_slug,
p.color,
p.finish,
p.texture,
p.width_mm,
p.height_mm,
p.thickness_mm,
p.weight_kg,
p.base_price,
p.tax_rate,
promo.id AS promotion_id,
promo.name AS promotion_name,
CASE
WHEN promo.promotion_type::text = 'FIXED_PRICE'::text THEN promo.promotional_price
ELSE NULL::numeric
END::numeric(14,2) AS promotional_price,
promo.starts_at AS promotion_starts_at,
promo.ends_at AS promotion_ends_at,
CASE
WHEN promo.promotion_type::text = 'FIXED_PRICE'::text THEN COALESCE(promo.promotional_price, p.base_price)
ELSE p.base_price
END AS final_price,
promo.id IS NOT NULL AND promo.promotion_type::text = 'FIXED_PRICE'::text AS has_promotion,
COALESCE(inv.stock_quantity, 0::numeric) AS stock_quantity,
COALESCE(res.reserved_quantity, 0::numeric) AS reserved_quantity,
COALESCE(inv.safety_stock, 0::numeric) AS safety_stock,
GREATEST(COALESCE(inv.stock_quantity, 0::numeric) - COALESCE(res.reserved_quantity, 0::numeric) - COALESCE(inv.safety_stock, 0::numeric), 0::numeric) AS available_web,
inv.last_sync_at,
COALESCE(inv.warehouse_count, 0::bigint) AS warehouse_count,
img.image_url AS primary_image_url,
img.alt_text AS primary_image_alt,
seo.meta_title,
seo.meta_description,
seo.canonical_url,
seo.og_title,
seo.og_description,
seo.og_image_url,
seo.robots_index,
seo.robots_follow,
p.is_active,
p.is_published,
p.is_featured,
p.allow_sale,
p.sort_order,
p.created_at,
p.updated_at,
promo.promotion_type,
promo.id IS NOT NULL AND promo.promotion_type::text = 'QUANTITY_TIER'::text AS has_quantity_promotion,
COALESCE(promo.quantity_tiers, '[]'::jsonb) AS quantity_tiers,
COALESCE(active_promos.active_promotions, '[]'::jsonb) AS active_promotions,
p.commercial_mode,
p.project_family_id,
project_family.code AS project_family_code,
project_family.name AS project_family_name,
project_family.application AS project_application,
project_family.default_core AS project_default_core,
project_family.description AS project_family_description,
COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'label', f.label, 'length_cm', f.length_cm, 'width_cm', f.width_cm, 'sort_order', f.sort_order) ORDER BY f.sort_order, f.length_cm, f.width_cm) FROM project_family_formats f WHERE f.family_id = project_family.id AND f.is_active = TRUE), '[]'::jsonb) AS project_formats,
COALESCE((SELECT jsonb_agg(jsonb_build_object('id', ff.id, 'name', ff.name, 'sort_order', ff.sort_order) ORDER BY ff.sort_order, ff.name) FROM project_family_finishes ff WHERE ff.family_id = project_family.id AND ff.is_active = TRUE), '[]'::jsonb) AS project_finishes,
COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'thickness_mm', t.thickness_mm, 'sort_order', t.sort_order) ORDER BY t.sort_order, t.thickness_mm) FROM project_family_thicknesses t WHERE t.family_id = project_family.id AND t.is_active = TRUE), '[]'::jsonb) AS project_thicknesses,
COALESCE((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'document_type', d.document_type, 'document_url', d.document_url, 'sort_order', d.sort_order) ORDER BY d.sort_order, d.title) FROM project_family_documents d WHERE d.family_id = project_family.id AND d.is_active = TRUE), '[]'::jsonb) AS project_documents
FROM products p
LEFT JOIN categories cat ON cat.id = p.category_id
LEFT JOIN brands br ON br.id = p.brand_id
LEFT JOIN collections col ON col.id = p.collection_id
LEFT JOIN product_seo seo ON seo.product_id = p.id
LEFT JOIN project_product_families project_family ON project_family.id = p.project_family_id
LEFT JOIN LATERAL ( SELECT sum(i.stock_quantity) AS stock_quantity,
sum(i.safety_stock) AS safety_stock,
max(i.last_sync_at) AS last_sync_at,
count(*) AS warehouse_count
FROM inventory i
WHERE i.product_id = p.id) inv ON true
LEFT JOIN LATERAL ( SELECT sum(ir.quantity) AS reserved_quantity
FROM inventory_reservations ir
JOIN inventory i ON i.id = ir.inventory_id
WHERE i.product_id = p.id AND (ir.status::text = ANY (ARRAY['ACTIVE'::character varying, 'CONFIRMED'::character varying]::text[])) AND (ir.expires_at IS NULL OR ir.expires_at > now())) res ON true
LEFT JOIN LATERAL ( SELECT pr.id,
pr.name,
pr.promotion_type,
pr.promotional_price,
pr.starts_at,
pr.ends_at,
COALESCE(( SELECT jsonb_agg(jsonb_build_object('id', tier.id, 'min_quantity', tier.min_quantity, 'unit_price', tier.unit_price) ORDER BY tier.min_quantity) AS jsonb_agg
FROM promotion_price_tiers tier
WHERE tier.promotion_id = pr.id), '[]'::jsonb) AS quantity_tiers
FROM promotions pr
WHERE pr.product_id = p.id AND pr.is_active = true AND (pr.starts_at IS NULL OR pr.starts_at <= now()) AND (pr.ends_at IS NULL OR pr.ends_at > now())
ORDER BY pr.starts_at DESC NULLS LAST, pr.created_at DESC
LIMIT 1) promo ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', pr.id,
          'name', pr.name,
          'promotion_type', pr.promotion_type,
          'promotional_price', pr.promotional_price,
          'starts_at', pr.starts_at,
          'ends_at', pr.ends_at,
          'tiers',
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', tier.id,
                    'min_quantity', tier.min_quantity,
                    'unit_price', tier.unit_price
                  )
                  ORDER BY tier.min_quantity
                )
                FROM promotion_price_tiers tier
                WHERE tier.promotion_id = pr.id
              ),
              '[]'::jsonb
            )
        )
        ORDER BY
          pr.created_at DESC,
          pr.id DESC
      ),
      '[]'::jsonb
    ) AS active_promotions
  FROM promotions pr
  WHERE pr.product_id = p.id
    AND pr.is_active = TRUE
    AND (
      pr.starts_at IS NULL
      OR pr.starts_at <= NOW()
    )
    AND (
      pr.ends_at IS NULL
      OR pr.ends_at > NOW()
    )
) active_promos ON true
LEFT JOIN LATERAL ( SELECT pi.image_url,
pi.alt_text
FROM product_images pi
WHERE pi.product_id = p.id AND pi.is_primary = true
ORDER BY pi.sort_order, pi.created_at
LIMIT 1) img ON true;;

COMMIT;
