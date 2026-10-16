BEGIN;

-- =========================================================
-- LAMINATIWORD
-- COTIZACIONES ESTÁNDAR + COTIZACIONES DE PROYECTO
-- PASO 1: MODELO DE DATOS
-- =========================================================

-- ---------------------------------------------------------
-- 1. Extender la cabecera existente de quotations.
--    Todas las cotizaciones actuales quedan como STANDARD.
-- ---------------------------------------------------------

ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS quotation_type VARCHAR(20)
  NOT NULL DEFAULT 'STANDARD';

ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS project_name VARCHAR(255);

ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS project_reference VARCHAR(255);


DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.quotations'::regclass
      AND conname = 'quotations_quotation_type_check'
  ) THEN
    ALTER TABLE public.quotations
      ADD CONSTRAINT quotations_quotation_type_check
      CHECK (
        quotation_type IN (
          'STANDARD',
          'PROJECT'
        )
      );
  END IF;
END
$$;


CREATE INDEX IF NOT EXISTS idx_quotations_type_status_created_at
  ON public.quotations (
    quotation_type,
    status,
    created_at DESC
  );


-- ---------------------------------------------------------
-- 2. Líneas especiales para cotizaciones PROJECT.
--
--    quotation_items continúa intacta y sigue atendiendo
--    las cotizaciones STANDARD actuales.
--
--    Esta tabla funciona como snapshot comercial editable:
--    puede vincularse a products, pero el texto, formato,
--    acabado, espesor y valores quedan guardados en la
--    propia cotización para que puedan modificarse antes
--    del envío sin alterar el catálogo.
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.quotation_project_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  quotation_id UUID NOT NULL
    REFERENCES public.quotations(id)
    ON DELETE CASCADE,

  line_type VARCHAR(20) NOT NULL,

  product_id UUID
    REFERENCES public.products(id)
    ON DELETE SET NULL,

  description TEXT NOT NULL,

  code VARCHAR(160),

  finish VARCHAR(120),

  thickness_mm NUMERIC(10,2),

  quantity NUMERIC(14,3) NOT NULL,

  unit VARCHAR(40) NOT NULL DEFAULT 'UN',

  format_label VARCHAR(120),

  width_cm NUMERIC(10,2),

  height_cm NUMERIC(10,2),

  price_m2_gross NUMERIC(14,2),

  unit_price_gross NUMERIC(14,2) NOT NULL DEFAULT 0,

  line_total_gross NUMERIC(14,2) NOT NULL DEFAULT 0,

  tax_rate NUMERIC(8,2) NOT NULL DEFAULT 19.00,

  line_net NUMERIC(14,2) NOT NULL DEFAULT 0,

  line_tax NUMERIC(14,2) NOT NULL DEFAULT 0,

  pricing_mode VARCHAR(20) NOT NULL DEFAULT 'UNIT',

  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT quotation_project_lines_line_type_check
    CHECK (
      line_type IN (
        'PRODUCT',
        'SERVICE',
        'OTHER'
      )
    ),

  CONSTRAINT quotation_project_lines_pricing_mode_check
    CHECK (
      pricing_mode IN (
        'AREA',
        'UNIT',
        'TOTAL'
      )
    ),

  CONSTRAINT quotation_project_lines_description_not_empty
    CHECK (
      BTRIM(description) <> ''
    ),

  CONSTRAINT quotation_project_lines_quantity_check
    CHECK (
      quantity > 0
    ),

  CONSTRAINT quotation_project_lines_thickness_check
    CHECK (
      thickness_mm IS NULL
      OR thickness_mm > 0
    ),

  CONSTRAINT quotation_project_lines_width_check
    CHECK (
      width_cm IS NULL
      OR width_cm > 0
    ),

  CONSTRAINT quotation_project_lines_height_check
    CHECK (
      height_cm IS NULL
      OR height_cm > 0
    ),

  CONSTRAINT quotation_project_lines_price_m2_check
    CHECK (
      price_m2_gross IS NULL
      OR price_m2_gross >= 0
    ),

  CONSTRAINT quotation_project_lines_unit_price_check
    CHECK (
      unit_price_gross >= 0
    ),

  CONSTRAINT quotation_project_lines_total_check
    CHECK (
      line_total_gross >= 0
    ),

  CONSTRAINT quotation_project_lines_tax_rate_check
    CHECK (
      tax_rate >= 0
    ),

  CONSTRAINT quotation_project_lines_net_check
    CHECK (
      line_net >= 0
    ),

  CONSTRAINT quotation_project_lines_tax_check
    CHECK (
      line_tax >= 0
    ),

  CONSTRAINT quotation_project_lines_sort_order_check
    CHECK (
      sort_order >= 0
    )
);


CREATE INDEX IF NOT EXISTS idx_quotation_project_lines_quotation
  ON public.quotation_project_lines (
    quotation_id,
    sort_order,
    created_at
  );


CREATE INDEX IF NOT EXISTS idx_quotation_project_lines_product
  ON public.quotation_project_lines (
    product_id
  )
  WHERE product_id IS NOT NULL;


CREATE INDEX IF NOT EXISTS idx_quotation_project_lines_type
  ON public.quotation_project_lines (
    quotation_id,
    line_type,
    sort_order
  );


-- ---------------------------------------------------------
-- 3. updated_at automático.
--    La función set_updated_at() ya existe en la BD y
--    actualmente es usada por products.
-- ---------------------------------------------------------

DROP TRIGGER IF EXISTS trg_quotation_project_lines_updated_at
  ON public.quotation_project_lines;

CREATE TRIGGER trg_quotation_project_lines_updated_at
BEFORE UPDATE
ON public.quotation_project_lines
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();


-- ---------------------------------------------------------
-- 4. Documentación del modelo.
-- ---------------------------------------------------------

COMMENT ON COLUMN public.quotations.quotation_type IS
  'Tipo de cotización: STANDARD usa quotation_items; PROJECT usa quotation_project_lines.';

COMMENT ON COLUMN public.quotations.project_name IS
  'Nombre comercial del proyecto. Sólo se utiliza en cotizaciones PROJECT.';

COMMENT ON COLUMN public.quotations.project_reference IS
  'Referencia libre del proyecto, OC interna, obra, licitación u otra identificación.';

COMMENT ON TABLE public.quotation_project_lines IS
  'Snapshot editable de productos, servicios y otros conceptos de una cotización PROJECT.';

COMMENT ON COLUMN public.quotation_project_lines.product_id IS
  'Producto de catálogo opcional usado para precargar datos. La línea conserva su propio snapshot editable.';

COMMENT ON COLUMN public.quotation_project_lines.line_type IS
  'PRODUCT, SERVICE u OTHER. OTHER permite conceptos como boletas de garantía u otros cargos.';

COMMENT ON COLUMN public.quotation_project_lines.pricing_mode IS
  'AREA: cálculo sugerido por m2; UNIT: cantidad x valor unitario; TOTAL: total ingresado manualmente.';

COMMIT;
