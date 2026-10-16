import crypto from "crypto";

import pool from "../config/database.js";


/* =========================================
   CONFIGURACIÓN
========================================= */

const MAX_TOKEN_LENGTH = 256;

const PUBLIC_ALLOWED_STATUSES =
  new Set([
    "SENT",
    "COMPLETED",
  ]);


/* =========================================
   ERROR CONTROLADO
========================================= */

const createServiceError = (
  message,
  status = 400,
  code = null
) => {
  const error =
    new Error(message);

  error.status =
    status;

  error.code =
    code;

  return error;
};


/* =========================================
   HELPERS
========================================= */

const normalizeToken = (
  value
) => {
  const token =
    String(
      value || ""
    ).trim();

  if (
    !token ||
    token.length >
      MAX_TOKEN_LENGTH
  ) {
    throw createServiceError(
      "Enlace de encuesta inválido",
      400,
      "INVALID_SURVEY_TOKEN"
    );
  }

  return token;
};


const hashToken = (
  token
) =>
  crypto
    .createHash(
      "sha256"
    )
    .update(token)
    .digest("hex");


const toIntegerOrNull = (
  value
) => {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  if (
    !Number.isInteger(
      number
    )
  ) {
    return null;
  }

  return number;
};


const validateRating = (
  value,
  field,
  {
    required = false,
    min = 1,
    max = 5,
  } = {}
) => {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    if (required) {
      throw createServiceError(
        `${field} es obligatorio`,
        400,
        "SURVEY_VALIDATION_ERROR"
      );
    }

    return null;
  }

  const number =
    toIntegerOrNull(
      value
    );

  if (
    number === null ||
    number < min ||
    number > max
  ) {
    throw createServiceError(
      `${field} debe estar entre ${min} y ${max}`,
      400,
      "SURVEY_VALIDATION_ERROR"
    );
  }

  return number;
};


const normalizeOptionalText = (
  value,
  maxLength,
  field
) => {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const text =
    String(value)
      .trim();

  if (!text) {
    return null;
  }

  if (
    text.length >
    maxLength
  ) {
    throw createServiceError(
      `${field} supera el máximo de ${maxLength} caracteres`,
      400,
      "SURVEY_VALIDATION_ERROR"
    );
  }

  return text;
};


const normalizeBoolean = (
  value
) =>
  value === true;


/* =========================================
   OBTENER INVITACIÓN POR TOKEN
========================================= */

const getInvitationByTokenHash =
  async (
    client,
    tokenHash,
    {
      forUpdate = false,
    } = {}
  ) => {
    const lock =
      forUpdate
        ? "FOR UPDATE"
        : "";

    const result =
      await client.query(
        `
          SELECT
            i.id,
            i.order_id,
            i.status,
            i.scheduled_for,
            i.sent_at,
            i.expires_at,
            i.completed_at,
            i.email,
            i.created_at,
            o.order_number,
            o.customer_name,
            o.status
              AS order_status,
            o.source
              AS order_source
          FROM
            post_sale_survey_invitations i
          INNER JOIN
            orders o
              ON o.id =
                i.order_id
          WHERE
            i.token_hash = $1
          LIMIT 1
          ${lock}
        `,
        [
          tokenHash,
        ]
      );

    return (
      result.rows[0] ||
      null
    );
  };


const assertInvitationCanBeRead =
  async (
    client,
    invitation
  ) => {
    if (!invitation) {
      throw createServiceError(
        "Encuesta no encontrada",
        404,
        "SURVEY_NOT_FOUND"
      );
    }

    if (
      invitation
        .order_source !==
      "WEB"
    ) {
      throw createServiceError(
        "Encuesta no disponible",
        404,
        "SURVEY_NOT_FOUND"
      );
    }

    if (
      invitation
        .order_status !==
      "COMPLETED"
    ) {
      throw createServiceError(
        "La orden todavía no está disponible para evaluación",
        409,
        "ORDER_NOT_COMPLETED"
      );
    }

    const expiresAt =
      new Date(
        invitation
          .expires_at
      );

    if (
      Number.isFinite(
        expiresAt.getTime()
      ) &&
      expiresAt <
        new Date()
    ) {
      if (
        invitation.status !==
        "EXPIRED"
      ) {
        await client.query(
          `
            UPDATE
              post_sale_survey_invitations
            SET
              status =
                'EXPIRED'
            WHERE
              id = $1
              AND status <>
                'COMPLETED'
          `,
          [
            invitation.id,
          ]
        );
      }

      throw createServiceError(
        "El enlace de encuesta ha expirado",
        410,
        "SURVEY_EXPIRED"
      );
    }

    if (
      !PUBLIC_ALLOWED_STATUSES
        .has(
          invitation.status
        )
    ) {
      if (
        invitation.status ===
        "EXPIRED"
      ) {
        throw createServiceError(
          "El enlace de encuesta ha expirado",
          410,
          "SURVEY_EXPIRED"
        );
      }

      throw createServiceError(
        "Encuesta no disponible",
        404,
        "SURVEY_NOT_FOUND"
      );
    }
  };


const assertInvitationCanBeModified =
  async (
    client,
    invitation
  ) => {
    await assertInvitationCanBeRead(
      client,
      invitation
    );

    if (
      invitation.status ===
      "COMPLETED"
    ) {
      throw createServiceError(
        "Esta encuesta ya fue enviada",
        409,
        "SURVEY_ALREADY_COMPLETED"
      );
    }
  };


/* =========================================
   PRODUCTOS DE LA ORDEN
========================================= */

const getSurveyOrderItems =
  async (
    client,
    orderId
  ) => {
    const result =
      await client.query(
        `
          SELECT
            oi.id
              AS order_item_id,
            oi.product_id,
            oi.sku,
            oi.product_name,
            oi.quantity,
            oi.finish,
            oi.product_code,
            pi.image_url,
            pi.alt_text
              AS image_alt
          FROM
            order_items oi
          LEFT JOIN LATERAL (
            SELECT
              image_url,
              alt_text
            FROM
              product_images
            WHERE
              product_id =
                oi.product_id
            ORDER BY
              is_primary DESC,
              sort_order ASC,
              id ASC
            LIMIT 1
          ) pi
            ON TRUE
          WHERE
            oi.order_id = $1
            AND oi.product_id
              IS NOT NULL
          ORDER BY
            oi.created_at ASC,
            oi.id ASC
        `,
        [
          orderId,
        ]
      );

    return result.rows;
  };


/* =========================================
   CARGAR ENCUESTA PÚBLICA
========================================= */

export const getPublicPostSaleSurvey =
  async (
    rawToken
  ) => {
    const token =
      normalizeToken(
        rawToken
      );

    const tokenHash =
      hashToken(
        token
      );

    const client =
      await pool.connect();

    try {
      const invitation =
        await getInvitationByTokenHash(
          client,
          tokenHash
        );

      await assertInvitationCanBeRead(
        client,
        invitation
      );

      const [
        items,
        experienceResult,
        reviewsResult,
      ] =
        await Promise.all([
          getSurveyOrderItems(
            client,
            invitation.order_id
          ),

          client.query(
            `
              SELECT
                overall_rating,
                findability_rating,
                product_info_rating,
                checkout_rating,
                recommendation_score,
                comments,
                created_at,
                updated_at
              FROM
                post_sale_survey_responses
              WHERE
                invitation_id = $1
              LIMIT 1
            `,
            [
              invitation.id,
            ]
          ),

          client.query(
            `
              SELECT
                id,
                order_item_id,
                product_id,
                rating,
                title,
                comment,
                consent_public,
                status,
                created_at,
                updated_at
              FROM
                product_reviews
              WHERE
                invitation_id = $1
              ORDER BY
                created_at ASC
            `,
            [
              invitation.id,
            ]
          ),
        ]);

      const reviewsByItem =
        new Map(
          reviewsResult.rows.map(
            (
              review
            ) => [
              String(
                review
                  .order_item_id
              ),
              review,
            ]
          )
        );

      const products =
        items.map(
          (
            item
          ) => ({
            order_item_id:
              item.order_item_id,
            product_id:
              item.product_id,
            sku:
              item.sku,
            product_code:
              item.product_code,
            product_name:
              item.product_name,
            finish:
              item.finish,
            quantity:
              Number(
                item.quantity
              ),
            image_url:
              item.image_url,
            image_alt:
              item.image_alt,
            review:
              reviewsByItem.get(
                String(
                  item.order_item_id
                )
              ) ||
              null,
          })
        );

      return {
        id:
          invitation.id,

        status:
          invitation.status,

        order: {
          order_number:
            invitation
              .order_number,
          customer_name:
            invitation
              .customer_name,
        },

        expires_at:
          invitation
            .expires_at,

        progress: {
          experience_completed:
            experienceResult
              .rowCount ===
            1,

          completed:
            invitation.status ===
            "COMPLETED",
        },

        experience:
          experienceResult
            .rows[0] ||
          null,

        products,
      };
    } finally {
      client.release();
    }
  };


/* =========================================
   GUARDAR PASO 1 · EXPERIENCIA
========================================= */

export const savePostSaleExperience =
  async (
    rawToken,
    payload = {}
  ) => {
    const token =
      normalizeToken(
        rawToken
      );

    const tokenHash =
      hashToken(
        token
      );

    const overallRating =
      validateRating(
        payload
          .overall_rating,
        "La experiencia general",
        {
          required:
            true,
        }
      );

    const findabilityRating =
      validateRating(
        payload
          .findability_rating,
        "La facilidad para encontrar productos"
      );

    const productInfoRating =
      validateRating(
        payload
          .product_info_rating,
        "La información de productos"
      );

    const checkoutRating =
      validateRating(
        payload
          .checkout_rating,
        "El proceso de compra"
      );

    const recommendationScore =
      validateRating(
        payload
          .recommendation_score,
        "La recomendación",
        {
          min: 0,
          max: 10,
        }
      );

    const comments =
      normalizeOptionalText(
        payload.comments,
        2000,
        "El comentario"
      );

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const invitation =
        await getInvitationByTokenHash(
          client,
          tokenHash,
          {
            forUpdate:
              true,
          }
        );

      await assertInvitationCanBeModified(
        client,
        invitation
      );

      const result =
        await client.query(
          `
            INSERT INTO
              post_sale_survey_responses (
                invitation_id,
                overall_rating,
                findability_rating,
                product_info_rating,
                checkout_rating,
                recommendation_score,
                comments
              )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7
            )
            ON CONFLICT (
              invitation_id
            )
            DO UPDATE SET
              overall_rating =
                EXCLUDED.overall_rating,
              findability_rating =
                EXCLUDED.findability_rating,
              product_info_rating =
                EXCLUDED.product_info_rating,
              checkout_rating =
                EXCLUDED.checkout_rating,
              recommendation_score =
                EXCLUDED.recommendation_score,
              comments =
                EXCLUDED.comments
            RETURNING
              id,
              invitation_id,
              overall_rating,
              findability_rating,
              product_info_rating,
              checkout_rating,
              recommendation_score,
              comments,
              created_at,
              updated_at
          `,
          [
            invitation.id,
            overallRating,
            findabilityRating,
            productInfoRating,
            checkoutRating,
            recommendationScore,
            comments,
          ]
        );

      await client.query(
        "COMMIT"
      );

      return result.rows[0];
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // La transacción puede haber finalizado.
      }

      throw error;
    } finally {
      client.release();
    }
  };


/* =========================================
   GUARDAR PASO 2 · RESEÑAS
   Y COMPLETAR ENCUESTA
========================================= */

export const savePostSaleProductReviews =
  async (
    rawToken,
    payload = {}
  ) => {
    const token =
      normalizeToken(
        rawToken
      );

    const tokenHash =
      hashToken(
        token
      );

    const rawReviews =
      payload
        ?.reviews;

    if (
      !Array.isArray(
        rawReviews
      )
    ) {
      throw createServiceError(
        "reviews debe ser un arreglo",
        400,
        "SURVEY_VALIDATION_ERROR"
      );
    }

    if (
      rawReviews.length >
      50
    ) {
      throw createServiceError(
        "La cantidad de reseñas supera el máximo permitido",
        400,
        "SURVEY_VALIDATION_ERROR"
      );
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const invitation =
        await getInvitationByTokenHash(
          client,
          tokenHash,
          {
            forUpdate:
              true,
          }
        );

      await assertInvitationCanBeModified(
        client,
        invitation
      );

      const experienceResult =
        await client.query(
          `
            SELECT id
            FROM
              post_sale_survey_responses
            WHERE
              invitation_id = $1
            LIMIT 1
          `,
          [
            invitation.id,
          ]
        );

      if (
        experienceResult.rowCount ===
        0
      ) {
        throw createServiceError(
          "Primero debes completar tu experiencia general",
          409,
          "EXPERIENCE_REQUIRED"
        );
      }

      const items =
        await getSurveyOrderItems(
          client,
          invitation.order_id
        );

      const itemsById =
        new Map(
          items.map(
            (
              item
            ) => [
              String(
                item
                  .order_item_id
              ),
              item,
            ]
          )
        );

      const seen =
        new Set();

      const savedReviews =
        [];

      for (
        const review
        of rawReviews
      ) {
        const orderItemId =
          String(
            review
              ?.order_item_id ||
              ""
          ).trim();

        if (
          !orderItemId
        ) {
          throw createServiceError(
            "order_item_id es obligatorio",
            400,
            "SURVEY_VALIDATION_ERROR"
          );
        }

        if (
          seen.has(
            orderItemId
          )
        ) {
          throw createServiceError(
            "No puedes enviar dos reseñas para el mismo producto",
            400,
            "SURVEY_DUPLICATE_ITEM"
          );
        }

        seen.add(
          orderItemId
        );

        const item =
          itemsById.get(
            orderItemId
          );

        if (!item) {
          throw createServiceError(
            "Uno de los productos no pertenece a esta compra",
            400,
            "SURVEY_INVALID_ORDER_ITEM"
          );
        }

        const rating =
          validateRating(
            review.rating,
            `La calificación de ${item.product_name}`,
            {
              required:
                true,
            }
          );

        const title =
          normalizeOptionalText(
            review.title,
            140,
            "El título"
          );

        const comment =
          normalizeOptionalText(
            review.comment,
            2000,
            "La opinión"
          );

        const consentPublic =
          normalizeBoolean(
            review
              .consent_public
          );

        const reviewResult =
          await client.query(
            `
              INSERT INTO
                product_reviews (
                  invitation_id,
                  order_id,
                  order_item_id,
                  product_id,
                  sku_snapshot,
                  product_name_snapshot,
                  reviewer_name,
                  rating,
                  title,
                  comment,
                  verified_purchase,
                  consent_public,
                  status,
                  moderated_by,
                  moderated_at,
                  moderation_notes,
                  published_at
                )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                TRUE,
                $11,
                'PENDING',
                NULL,
                NULL,
                NULL,
                NULL
              )
              ON CONFLICT (
                order_item_id
              )
              DO UPDATE SET
                rating =
                  EXCLUDED.rating,
                title =
                  EXCLUDED.title,
                comment =
                  EXCLUDED.comment,
                consent_public =
                  EXCLUDED.consent_public,
                reviewer_name =
                  EXCLUDED.reviewer_name,
                status =
                  'PENDING',
                moderated_by =
                  NULL,
                moderated_at =
                  NULL,
                moderation_notes =
                  NULL,
                published_at =
                  NULL
              RETURNING
                id,
                order_item_id,
                product_id,
                rating,
                title,
                comment,
                verified_purchase,
                consent_public,
                status,
                created_at,
                updated_at
            `,
            [
              invitation.id,
              invitation.order_id,
              item.order_item_id,
              item.product_id,
              item.sku,
              item.product_name,
              invitation
                .customer_name,
              rating,
              title,
              comment,
              consentPublic,
            ]
          );

        savedReviews.push(
          reviewResult
            .rows[0]
        );
      }

      const completionResult =
        await client.query(
          `
            UPDATE
              post_sale_survey_invitations
            SET
              status =
                'COMPLETED',
              completed_at =
                NOW()
            WHERE
              id = $1
            RETURNING
              id,
              status,
              completed_at
          `,
          [
            invitation.id,
          ]
        );

      await client.query(
        "COMMIT"
      );

      return {
        invitation:
          completionResult
            .rows[0],

        reviews:
          savedReviews,
      };
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // La transacción puede haber finalizado.
      }

      throw error;
    } finally {
      client.release();
    }
  };


/* =========================================
   DEV · CREAR / ROTAR TOKEN DE PRUEBA
   NO USAR COMO ENDPOINT PÚBLICO
========================================= */

export const createOrRotateTestSurveyInvitation =
  async (
    orderId = null
  ) => {
    if (
      process.env
        .NODE_ENV ===
      "production"
    ) {
      throw createServiceError(
        "La creación manual de tokens de prueba está deshabilitada en producción",
        403,
        "DEV_ONLY"
      );
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const orderResult =
        orderId
          ? await client.query(
              `
                SELECT
                  id,
                  order_number,
                  email,
                  customer_name,
                  status,
                  source
                FROM orders
                WHERE
                  id = $1
                LIMIT 1
                FOR UPDATE
              `,
              [
                orderId,
              ]
            )
          : await client.query(
              `
                SELECT
                  id,
                  order_number,
                  email,
                  customer_name,
                  status,
                  source
                FROM orders
                WHERE
                  status =
                    'COMPLETED'
                  AND source =
                    'WEB'
                ORDER BY
                  updated_at DESC,
                  created_at DESC
                LIMIT 1
                FOR UPDATE
              `
            );

      const order =
        orderResult
          .rows[0];

      if (!order) {
        throw createServiceError(
          "No se encontró una orden WEB COMPLETED para probar la encuesta",
          404,
          "TEST_ORDER_NOT_FOUND"
        );
      }

      if (
        order.status !==
          "COMPLETED" ||
        order.source !==
          "WEB"
      ) {
        throw createServiceError(
          "La orden de prueba debe ser WEB y COMPLETED",
          409,
          "TEST_ORDER_NOT_ELIGIBLE"
        );
      }

      const token =
        crypto
          .randomBytes(32)
          .toString(
            "base64url"
          );

      const tokenHash =
        hashToken(
          token
        );

      const result =
        await client.query(
          `
            INSERT INTO
              post_sale_survey_invitations (
                order_id,
                token_hash,
                status,
                scheduled_for,
                sent_at,
                expires_at,
                email,
                send_attempts
              )
            VALUES (
              $1,
              $2,
              'SENT',
              NOW(),
              NOW(),
              NOW() +
                INTERVAL '30 days',
              $3,
              0
            )
            ON CONFLICT (
              order_id
            )
            DO UPDATE SET
              token_hash =
                EXCLUDED.token_hash,
              status =
                'SENT',
              scheduled_for =
                NOW(),
              sent_at =
                NOW(),
              expires_at =
                NOW() +
                  INTERVAL '30 days',
              completed_at =
                NULL,
              email =
                EXCLUDED.email,
              last_error =
                NULL
            RETURNING
              id,
              order_id,
              status,
              expires_at
          `,
          [
            order.id,
            tokenHash,
            order.email,
          ]
        );

      /*
       * Para una nueva prueba sobre esa misma orden,
       * limpiamos respuestas/reseñas anteriores.
       */
      await client.query(
        `
          DELETE FROM
            product_reviews
          WHERE
            invitation_id =
              $1
        `,
        [
          result.rows[0]
            .id,
        ]
      );

      await client.query(
        `
          DELETE FROM
            post_sale_survey_responses
          WHERE
            invitation_id =
              $1
        `,
        [
          result.rows[0]
            .id,
        ]
      );

      await client.query(
        "COMMIT"
      );

      return {
        token,

        invitation:
          result.rows[0],

        order: {
          id:
            order.id,
          order_number:
            order.order_number,
          customer_name:
            order.customer_name,
        },
      };
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // La transacción puede haber finalizado.
      }

      throw error;
    } finally {
      client.release();
    }
  };
