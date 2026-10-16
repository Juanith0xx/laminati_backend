BEGIN;

-- ============================================================
-- LAMINATIWORD · FASE 1
-- ENCUESTA POSTVENTA + RESEÑAS DE PRODUCTO
--
-- Objetivo:
-- - 1 invitación por orden
-- - Encuesta privada de experiencia web
-- - 1 reseña por order_item
-- - Reseñas verificadas y moderables
-- - Token público almacenado únicamente como SHA-256
-- ============================================================


-- ============================================================
-- 1. INVITACIONES DE ENCUESTA
-- ============================================================

CREATE TABLE IF NOT EXISTS post_sale_survey_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  order_id uuid NOT NULL
    REFERENCES orders(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  token_hash character varying(64) NOT NULL,

  status character varying(20) NOT NULL
    DEFAULT 'PENDING',

  scheduled_for timestamp with time zone NOT NULL,
  sent_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,

  email character varying(255) NOT NULL,

  send_attempts integer NOT NULL DEFAULT 0,
  last_error text,

  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT uq_post_sale_survey_order
    UNIQUE (order_id),

  CONSTRAINT uq_post_sale_survey_token_hash
    UNIQUE (token_hash),

  CONSTRAINT post_sale_survey_token_hash_length
    CHECK (char_length(token_hash) = 64),

  CONSTRAINT post_sale_survey_status_valid
    CHECK (
      status IN (
        'PENDING',
        'SENT',
        'COMPLETED',
        'EXPIRED',
        'CANCELLED'
      )
    ),

  CONSTRAINT post_sale_survey_attempts_positive
    CHECK (send_attempts >= 0),

  CONSTRAINT post_sale_survey_expiration_valid
    CHECK (expires_at > scheduled_for)
);


CREATE INDEX IF NOT EXISTS idx_post_sale_survey_status_scheduled
  ON post_sale_survey_invitations (
    status,
    scheduled_for
  );

CREATE INDEX IF NOT EXISTS idx_post_sale_survey_expires_at
  ON post_sale_survey_invitations (
    expires_at
  );

CREATE INDEX IF NOT EXISTS idx_post_sale_survey_email
  ON post_sale_survey_invitations (
    email
  );


DROP TRIGGER IF EXISTS
  trg_post_sale_survey_invitations_updated_at
  ON post_sale_survey_invitations;

CREATE TRIGGER
  trg_post_sale_survey_invitations_updated_at
BEFORE UPDATE
  ON post_sale_survey_invitations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 2. RESPUESTA PRIVADA DE EXPERIENCIA
-- ============================================================

CREATE TABLE IF NOT EXISTS post_sale_survey_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  invitation_id uuid NOT NULL
    REFERENCES post_sale_survey_invitations(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  overall_rating smallint NOT NULL,
  findability_rating smallint,
  product_info_rating smallint,
  checkout_rating smallint,
  recommendation_score smallint,

  comments text,

  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT uq_post_sale_survey_response_invitation
    UNIQUE (invitation_id),

  CONSTRAINT post_sale_survey_overall_rating_valid
    CHECK (
      overall_rating BETWEEN 1 AND 5
    ),

  CONSTRAINT post_sale_survey_findability_rating_valid
    CHECK (
      findability_rating IS NULL
      OR findability_rating BETWEEN 1 AND 5
    ),

  CONSTRAINT post_sale_survey_product_info_rating_valid
    CHECK (
      product_info_rating IS NULL
      OR product_info_rating BETWEEN 1 AND 5
    ),

  CONSTRAINT post_sale_survey_checkout_rating_valid
    CHECK (
      checkout_rating IS NULL
      OR checkout_rating BETWEEN 1 AND 5
    ),

  CONSTRAINT post_sale_survey_recommendation_score_valid
    CHECK (
      recommendation_score IS NULL
      OR recommendation_score BETWEEN 0 AND 10
    )
);


CREATE INDEX IF NOT EXISTS idx_post_sale_survey_responses_created_at
  ON post_sale_survey_responses (
    created_at DESC
  );


DROP TRIGGER IF EXISTS
  trg_post_sale_survey_responses_updated_at
  ON post_sale_survey_responses;

CREATE TRIGGER
  trg_post_sale_survey_responses_updated_at
BEFORE UPDATE
  ON post_sale_survey_responses
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 3. RESEÑAS DE PRODUCTOS
-- ============================================================

CREATE TABLE IF NOT EXISTS product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  invitation_id uuid NOT NULL
    REFERENCES post_sale_survey_invitations(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  order_id uuid NOT NULL
    REFERENCES orders(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  order_item_id uuid NOT NULL
    REFERENCES order_items(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,

  product_id uuid
    REFERENCES products(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  sku_snapshot character varying(120) NOT NULL,
  product_name_snapshot character varying(255) NOT NULL,

  reviewer_name character varying(120),

  rating smallint NOT NULL,
  title character varying(140),
  comment text,

  verified_purchase boolean NOT NULL DEFAULT TRUE,
  consent_public boolean NOT NULL DEFAULT FALSE,

  status character varying(20) NOT NULL DEFAULT 'PENDING',

  moderated_by uuid
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,

  moderated_at timestamp with time zone,
  moderation_notes text,

  published_at timestamp with time zone,

  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT uq_product_reviews_order_item
    UNIQUE (order_item_id),

  CONSTRAINT product_reviews_rating_valid
    CHECK (
      rating BETWEEN 1 AND 5
    ),

  CONSTRAINT product_reviews_status_valid
    CHECK (
      status IN (
        'PENDING',
        'APPROVED',
        'REJECTED'
      )
    ),

  CONSTRAINT product_reviews_publication_valid
    CHECK (
      published_at IS NULL
      OR (
        status = 'APPROVED'
        AND consent_public = TRUE
      )
    )
);


CREATE INDEX IF NOT EXISTS idx_product_reviews_product_status
  ON product_reviews (
    product_id,
    status
  );

CREATE INDEX IF NOT EXISTS idx_product_reviews_order_id
  ON product_reviews (
    order_id
  );

CREATE INDEX IF NOT EXISTS idx_product_reviews_invitation_id
  ON product_reviews (
    invitation_id
  );

CREATE INDEX IF NOT EXISTS idx_product_reviews_published_at
  ON product_reviews (
    published_at DESC
  )
  WHERE
    status = 'APPROVED'
    AND consent_public = TRUE;


DROP TRIGGER IF EXISTS
  trg_product_reviews_updated_at
  ON product_reviews;

CREATE TRIGGER
  trg_product_reviews_updated_at
BEFORE UPDATE
  ON product_reviews
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- 4. VISTA PARA FUTURO SEO / FICHA DE PRODUCTO
--
-- Solo considera reseñas:
-- - aprobadas
-- - con consentimiento público
-- - asociadas todavía a un producto
-- ============================================================

CREATE OR REPLACE VIEW vw_product_review_summary AS
SELECT
  product_id,
  COUNT(*)::integer AS review_count,
  ROUND(
    AVG(rating)::numeric,
    2
  ) AS average_rating,
  COUNT(*) FILTER (
    WHERE rating = 5
  )::integer AS five_star_count,
  COUNT(*) FILTER (
    WHERE rating = 4
  )::integer AS four_star_count,
  COUNT(*) FILTER (
    WHERE rating = 3
  )::integer AS three_star_count,
  COUNT(*) FILTER (
    WHERE rating = 2
  )::integer AS two_star_count,
  COUNT(*) FILTER (
    WHERE rating = 1
  )::integer AS one_star_count
FROM product_reviews
WHERE
  status = 'APPROVED'
  AND consent_public = TRUE
  AND product_id IS NOT NULL
GROUP BY
  product_id;


COMMIT;
