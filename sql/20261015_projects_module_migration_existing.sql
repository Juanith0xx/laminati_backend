BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

/* =========================================================
   MIGRACIÓN COMPATIBLE CON EL MÓDULO DE PROYECTOS EXISTENTE
   - NO BORRA tablas
   - NO BORRA datos
   - Reutiliza estructura anterior
   - Agrega campos requeridos por la nueva API
========================================================= */


/* =========================================================
   PROJECTS
========================================================= */

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS category VARCHAR(80),
  ADD COLUMN IF NOT EXISTS project_year SMALLINT,
  ADD COLUMN IF NOT EXISTS short_description VARCHAR(500),
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS meta_title VARCHAR(180),
  ADD COLUMN IF NOT EXISTS meta_description VARCHAR(320),
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS updated_by UUID,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


/* Backfill desde la estructura existente */

UPDATE public.projects
SET category =
  COALESCE(
    NULLIF(BTRIM(category), ''),
    NULLIF(BTRIM(project_type), ''),
    'General'
  )
WHERE
  category IS NULL
  OR BTRIM(category) = '';


UPDATE public.projects
SET short_description =
  COALESCE(
    NULLIF(BTRIM(short_description), ''),
    NULLIF(BTRIM(subtitle), '')
  )
WHERE short_description IS NULL;


UPDATE public.projects
SET status =
  CASE
    WHEN is_published = TRUE
      THEN 'PUBLISHED'
    ELSE 'DRAFT'
  END
WHERE
  status IS NULL
  OR status NOT IN (
    'DRAFT',
    'PUBLISHED',
    'ARCHIVED'
  );


UPDATE public.projects
SET published_at =
  COALESCE(
    published_at,
    updated_at,
    created_at,
    NOW()
  )
WHERE
  status = 'PUBLISHED'
  AND published_at IS NULL;


/* CATEGORY pasa a ser obligatoria después del backfill */

ALTER TABLE public.projects
  ALTER COLUMN category SET NOT NULL,
  ALTER COLUMN status SET NOT NULL;


/* Foreign keys de auditoría */

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'projects_created_by_fkey'
      AND conrelid = 'public.projects'::regclass
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_created_by_fkey
      FOREIGN KEY (created_by)
      REFERENCES public.users(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'projects_updated_by_fkey'
      AND conrelid = 'public.projects'::regclass
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_updated_by_fkey
      FOREIGN KEY (updated_by)
      REFERENCES public.users(id)
      ON DELETE SET NULL;
  END IF;
END
$$;


/* Checks nuevos */

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_projects_status'
      AND conrelid = 'public.projects'::regclass
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT chk_projects_status
      CHECK (
        status IN (
          'DRAFT',
          'PUBLISHED',
          'ARCHIVED'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_projects_year'
      AND conrelid = 'public.projects'::regclass
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT chk_projects_year
      CHECK (
        project_year IS NULL
        OR project_year BETWEEN 1900 AND 2200
      );
  END IF;
END
$$;


/* =========================================================
   PROJECT_IMAGES
========================================================= */

ALTER TABLE public.project_images
  ADD COLUMN IF NOT EXISTS image_url TEXT;


/*
  image_url es nullable para conservar compatibilidad con
  imágenes antiguas que usan storage keys o Instagram.
*/


/* =========================================================
   PROJECT_PRODUCTS
========================================================= */

ALTER TABLE public.project_products
  ADD COLUMN IF NOT EXISTS application_note VARCHAR(500),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();


UPDATE public.project_products
SET application_note =
  COALESCE(
    NULLIF(BTRIM(application_note), ''),
    NULLIF(BTRIM(usage_label), '')
  )
WHERE application_note IS NULL;


/* =========================================================
   ÍNDICES NUEVOS
========================================================= */

CREATE INDEX IF NOT EXISTS idx_projects_public_listing_v2
  ON public.projects (
    status,
    is_active,
    is_featured DESC,
    sort_order,
    published_at DESC
  )
  WHERE deleted_at IS NULL;


CREATE INDEX IF NOT EXISTS idx_projects_category_v2
  ON public.projects (
    LOWER(category)
  )
  WHERE deleted_at IS NULL;


CREATE INDEX IF NOT EXISTS idx_projects_created_at_v2
  ON public.projects (
    created_at DESC
  );


/* =========================================================
   UPDATED_AT GENÉRICO
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
   COMPATIBILIDAD V1 <-> V2
   Mantiene sincronizados nombres viejos y nuevos.
========================================================= */

CREATE OR REPLACE FUNCTION public.sync_projects_compatibility()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN

  /* -----------------------------------------
     PUBLICACIÓN
  ----------------------------------------- */

  IF TG_OP = 'INSERT' THEN

    IF NEW.status IS NULL THEN
      NEW.status :=
        CASE
          WHEN NEW.is_published = TRUE
            THEN 'PUBLISHED'
          ELSE 'DRAFT'
        END;
    END IF;

    NEW.is_published :=
      (
        NEW.status = 'PUBLISHED'
      );

  ELSE

    IF
      NEW.status IS DISTINCT FROM OLD.status
      AND NEW.is_published IS NOT DISTINCT FROM OLD.is_published
    THEN

      NEW.is_published :=
        (
          NEW.status = 'PUBLISHED'
        );

    ELSIF
      NEW.is_published IS DISTINCT FROM OLD.is_published
      AND NEW.status IS NOT DISTINCT FROM OLD.status
    THEN

      NEW.status :=
        CASE
          WHEN NEW.is_published = TRUE
            THEN 'PUBLISHED'
          ELSE 'DRAFT'
        END;

    ELSIF
      NEW.status IS DISTINCT FROM OLD.status
      AND NEW.is_published IS DISTINCT FROM OLD.is_published
    THEN

      /* V2 manda si ambos campos cambian */
      NEW.is_published :=
        (
          NEW.status = 'PUBLISHED'
        );

    END IF;

  END IF;


  IF NEW.status = 'ARCHIVED' THEN
    NEW.is_published := FALSE;
    NEW.is_active := FALSE;
  END IF;


  IF
    NEW.status = 'PUBLISHED'
    AND NEW.published_at IS NULL
  THEN
    NEW.published_at := NOW();
  END IF;


  /* -----------------------------------------
     CATEGORÍA / PROJECT_TYPE
  ----------------------------------------- */

  IF TG_OP = 'INSERT' THEN

    NEW.category :=
      COALESCE(
        NULLIF(BTRIM(NEW.category), ''),
        NULLIF(BTRIM(NEW.project_type), ''),
        'General'
      );

    IF
      NEW.project_type IS NULL
      OR BTRIM(NEW.project_type) = ''
    THEN
      NEW.project_type :=
        NEW.category;
    END IF;

  ELSE

    IF
      NEW.category IS DISTINCT FROM OLD.category
      AND NEW.project_type IS NOT DISTINCT FROM OLD.project_type
    THEN

      NEW.project_type :=
        NEW.category;

    ELSIF
      NEW.project_type IS DISTINCT FROM OLD.project_type
      AND NEW.category IS NOT DISTINCT FROM OLD.category
    THEN

      NEW.category :=
        COALESCE(
          NULLIF(BTRIM(NEW.project_type), ''),
          'General'
        );

    END IF;

  END IF;


  /* -----------------------------------------
     SUBTITLE / SHORT_DESCRIPTION
  ----------------------------------------- */

  IF TG_OP = 'INSERT' THEN

    NEW.short_description :=
      COALESCE(
        NULLIF(BTRIM(NEW.short_description), ''),
        NULLIF(BTRIM(NEW.subtitle), '')
      );

    IF
      NEW.subtitle IS NULL
      AND NEW.short_description IS NOT NULL
    THEN
      NEW.subtitle :=
        LEFT(
          NEW.short_description,
          255
        );
    END IF;

  ELSE

    IF
      NEW.short_description IS DISTINCT FROM OLD.short_description
      AND NEW.subtitle IS NOT DISTINCT FROM OLD.subtitle
    THEN

      NEW.subtitle :=
        CASE
          WHEN NEW.short_description IS NULL
            THEN NULL
          ELSE LEFT(
            NEW.short_description,
            255
          )
        END;

    ELSIF
      NEW.subtitle IS DISTINCT FROM OLD.subtitle
      AND NEW.short_description IS NOT DISTINCT FROM OLD.short_description
    THEN

      NEW.short_description :=
        NEW.subtitle;

    END IF;

  END IF;


  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS trg_projects_compatibility
  ON public.projects;

CREATE TRIGGER trg_projects_compatibility
BEFORE INSERT OR UPDATE ON public.projects
FOR EACH ROW
EXECUTE FUNCTION public.sync_projects_compatibility();


/* =========================================================
   COMPATIBILIDAD PROJECT_PRODUCTS
========================================================= */

CREATE OR REPLACE FUNCTION public.sync_project_products_compatibility()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN

  IF TG_OP = 'INSERT' THEN

    NEW.application_note :=
      COALESCE(
        NULLIF(BTRIM(NEW.application_note), ''),
        NULLIF(BTRIM(NEW.usage_label), '')
      );

    IF
      NEW.usage_label IS NULL
      AND NEW.application_note IS NOT NULL
    THEN
      NEW.usage_label :=
        LEFT(
          NEW.application_note,
          100
        );
    END IF;

  ELSE

    IF
      NEW.application_note IS DISTINCT FROM OLD.application_note
      AND NEW.usage_label IS NOT DISTINCT FROM OLD.usage_label
    THEN

      NEW.usage_label :=
        CASE
          WHEN NEW.application_note IS NULL
            THEN NULL
          ELSE LEFT(
            NEW.application_note,
            100
          )
        END;

    ELSIF
      NEW.usage_label IS DISTINCT FROM OLD.usage_label
      AND NEW.application_note IS NOT DISTINCT FROM OLD.application_note
    THEN

      NEW.application_note :=
        NEW.usage_label;

    END IF;

  END IF;

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS trg_project_products_compatibility
  ON public.project_products;

CREATE TRIGGER trg_project_products_compatibility
BEFORE INSERT OR UPDATE ON public.project_products
FOR EACH ROW
EXECUTE FUNCTION public.sync_project_products_compatibility();


/* =========================================================
   VISTA PÚBLICA
========================================================= */

CREATE OR REPLACE VIEW public.vw_public_projects AS
SELECT
  p.id,
  p.title,
  p.slug,
  p.category,
  p.project_type,
  p.subtitle,
  p.short_description,
  p.description,
  p.location,
  p.project_year,
  p.cover_image_url,
  p.instagram_url,
  p.is_featured,
  p.show_on_home,
  p.sort_order,
  p.meta_title,
  p.meta_description,
  p.published_at,
  p.created_at,
  p.updated_at
FROM public.projects p
WHERE
  p.status = 'PUBLISHED'
  AND p.is_published = TRUE
  AND p.is_active = TRUE
  AND p.deleted_at IS NULL;


/* =========================================================
   COMENTARIOS
========================================================= */

COMMENT ON COLUMN public.projects.category IS
  'Categoría V2 del proyecto. Se sincroniza con project_type.';

COMMENT ON COLUMN public.projects.status IS
  'Estado V2: DRAFT, PUBLISHED o ARCHIVED. Se sincroniza con is_published.';

COMMENT ON COLUMN public.projects.short_description IS
  'Descripción breve V2. Compatible con subtitle.';

COMMENT ON COLUMN public.project_images.image_url IS
  'URL directa opcional para imágenes externas; la estructura storage existente permanece intacta.';

COMMENT ON COLUMN public.project_products.application_note IS
  'Nota de aplicación V2. Compatible con usage_label.';


COMMIT;
