BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

/* =========================================================
   PROYECTOS
========================================================= */

CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  title VARCHAR(180) NOT NULL,
  slug VARCHAR(200) NOT NULL UNIQUE,

  category VARCHAR(80) NOT NULL,
  location VARCHAR(180),
  project_year SMALLINT,

  short_description VARCHAR(500),
  description TEXT,

  cover_image_url TEXT,

  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,

  meta_title VARCHAR(180),
  meta_description VARCHAR(320),

  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,

  published_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_projects_status
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),

  CONSTRAINT chk_projects_year
    CHECK (
      project_year IS NULL
      OR project_year BETWEEN 1900 AND 2200
    ),

  CONSTRAINT chk_projects_sort_order
    CHECK (sort_order >= 0)
);


/* =========================================================
   IMÁGENES DE PROYECTOS
========================================================= */

CREATE TABLE IF NOT EXISTS public.project_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  project_id UUID NOT NULL
    REFERENCES public.projects(id)
    ON DELETE CASCADE,

  image_url TEXT NOT NULL,
  alt_text VARCHAR(240),
  caption VARCHAR(500),

  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_project_images_sort_order
    CHECK (sort_order >= 0)
);


/* =========================================================
   PRODUCTOS UTILIZADOS EN UN PROYECTO
========================================================= */

CREATE TABLE IF NOT EXISTS public.project_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  project_id UUID NOT NULL
    REFERENCES public.projects(id)
    ON DELETE CASCADE,

  product_id UUID NOT NULL
    REFERENCES public.products(id)
    ON DELETE CASCADE,

  application_note VARCHAR(500),
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_project_products
    UNIQUE (project_id, product_id),

  CONSTRAINT chk_project_products_sort_order
    CHECK (sort_order >= 0)
);


/* =========================================================
   ÍNDICES
========================================================= */

CREATE INDEX IF NOT EXISTS idx_projects_public_listing
  ON public.projects (
    status,
    is_active,
    is_featured DESC,
    sort_order,
    published_at DESC
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_projects_category
  ON public.projects (LOWER(category))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_projects_created_at
  ON public.projects (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_images_project
  ON public.project_images (
    project_id,
    is_primary DESC,
    sort_order,
    created_at
  );

CREATE INDEX IF NOT EXISTS idx_project_products_project
  ON public.project_products (
    project_id,
    sort_order,
    created_at
  );

CREATE INDEX IF NOT EXISTS idx_project_products_product
  ON public.project_products (product_id);


/* =========================================================
   UNA SOLA IMAGEN PRINCIPAL POR PROYECTO
========================================================= */

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_images_primary
  ON public.project_images (project_id)
  WHERE is_primary = TRUE;


/* =========================================================
   UPDATED_AT
========================================================= */

CREATE OR REPLACE FUNCTION public.set_projects_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_updated_at
  ON public.projects;

CREATE TRIGGER trg_projects_updated_at
BEFORE UPDATE ON public.projects
FOR EACH ROW
EXECUTE FUNCTION public.set_projects_updated_at();

DROP TRIGGER IF EXISTS trg_project_images_updated_at
  ON public.project_images;

CREATE TRIGGER trg_project_images_updated_at
BEFORE UPDATE ON public.project_images
FOR EACH ROW
EXECUTE FUNCTION public.set_projects_updated_at();

DROP TRIGGER IF EXISTS trg_project_products_updated_at
  ON public.project_products;

CREATE TRIGGER trg_project_products_updated_at
BEFORE UPDATE ON public.project_products
FOR EACH ROW
EXECUTE FUNCTION public.set_projects_updated_at();


/* =========================================================
   VISTA DE LECTURA PÚBLICA
========================================================= */

CREATE OR REPLACE VIEW public.vw_public_projects AS
SELECT
  p.id,
  p.title,
  p.slug,
  p.category,
  p.location,
  p.project_year,
  p.short_description,
  p.description,
  p.cover_image_url,
  p.is_featured,
  p.sort_order,
  p.meta_title,
  p.meta_description,
  p.published_at,
  p.created_at,
  p.updated_at
FROM public.projects p
WHERE
  p.status = 'PUBLISHED'
  AND p.is_active = TRUE
  AND p.deleted_at IS NULL;

COMMENT ON TABLE public.projects IS
  'Portafolio administrable de proyectos publicados por Laminati.';

COMMENT ON TABLE public.project_images IS
  'Galería de imágenes asociada a cada proyecto.';

COMMENT ON TABLE public.project_products IS
  'Relación entre proyectos y productos Laminati utilizados.';

COMMIT;
