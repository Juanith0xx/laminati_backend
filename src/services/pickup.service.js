import crypto from "crypto";

import pool from "../config/database.js";

import {
  ensureOrderReadyForPickupEmailArtifacts,
} from "./emailOutbox.service.js";


/* =========================================
   PASO 89 - RETIRO EN TIENDA

   REGLAS DE SEGURIDAD:
   - El QR contiene un token aleatorio opaco.
   - PostgreSQL guarda solamente SHA-256(token).
   - El token es de un solo uso.
   - No contiene PII ni order_number.
   - Un scan exitoso consume el token dentro
     de una transacción con bloqueo de fila.
========================================= */

const PICKUP_TOKEN_PREFIX =
  "LWPU1_";

const PICKUP_SIGNED_TOKEN_PREFIX =
  "LWPU2_";

const DEFAULT_TTL_HOURS =
  168; // 7 días

const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 720;


/* =========================================
   ERROR CONTROLADO
========================================= */
const createServiceError = (
  message,
  status = 400,
  code = null
) => {
  const error = new Error(message);

  error.status = status;
  error.code = code;

  return error;
};


/* =========================================
   UTILIDADES
========================================= */
const normalizeRole = (role) =>
  String(role || "")
    .trim()
    .toUpperCase();


const isAdminRole = (role) =>
  normalizeRole(role) === "ADMIN";


const isSellerRole = (role) =>
  normalizeRole(role) === "VENDEDOR";


const isPickupOperatorRole = (role) =>
  [
    "ADMIN",
    "VENDEDOR",
  ].includes(
    normalizeRole(role)
  );


const isPickupScannerRole = (role) =>
  isPickupOperatorRole(role);


const resolveTtlHours = () => {
  const parsed = Number(
    process.env.STORE_PICKUP_TOKEN_TTL_HOURS ||
      DEFAULT_TTL_HOURS
  );

  if (!Number.isFinite(parsed)) {
    return DEFAULT_TTL_HOURS;
  }

  return Math.min(
    Math.max(
      Math.trunc(parsed),
      MIN_TTL_HOURS
    ),
    MAX_TTL_HOURS
  );
};


const buildExpiryDate = () => {
  const ttlHours =
    resolveTtlHours();

  return new Date(
    Date.now() +
      ttlHours * 60 * 60 * 1000
  );
};


const getPickupQrSecret = () => {
  const secret =
    String(
      process.env.PICKUP_QR_SECRET ||
        ""
    ).trim();

  if (secret.length < 32) {
    throw createServiceError(
      "PICKUP_QR_SECRET no se encuentra configurado correctamente",
      500,
      "PICKUP_QR_SECRET_NOT_CONFIGURED"
    );
  }

  return secret;
};


const generatePickupCredential = () => {
  const randomPart =
    crypto
      .randomBytes(32)
      .toString("base64url");

  return `${PICKUP_TOKEN_PREFIX}${randomPart}`;
};


const buildSignedPickupCredential = (
  pickupId,
  generatedAt
) => {
  const normalizedPickupId =
    String(pickupId || "").trim();

  const date =
    generatedAt instanceof Date
      ? generatedAt
      : new Date(generatedAt);

  if (
    !normalizedPickupId ||
    Number.isNaN(date.getTime())
  ) {
    throw createServiceError(
      "No fue posible construir la credencial de retiro",
      500,
      "PICKUP_CREDENTIAL_BUILD_ERROR"
    );
  }

  const timestamp =
    date.getTime();

  const timestampPart =
    timestamp.toString(36);

  const signature =
    crypto
      .createHmac(
        "sha256",
        getPickupQrSecret()
      )
      .update(
        `laminatiword:pickup:v2:${normalizedPickupId}:${timestamp}`,
        "utf8"
      )
      .digest("base64url");

  return (
    `${PICKUP_SIGNED_TOKEN_PREFIX}` +
    `${normalizedPickupId}.` +
    `${timestampPart}.` +
    `${signature}`
  );
};


export const buildPickupQrToken = (
  pickupId,
  generatedAt
) => {
  return buildSignedPickupCredential(
    pickupId,
    generatedAt
  );
};


const hashPickupCredential = (
  credential
) => {
  return crypto
    .createHash("sha256")
    .update(
      String(credential || ""),
      "utf8"
    )
    .digest("hex");
};


export const hashPickupQrToken = (
  credential
) => {
  return hashPickupCredential(
    credential
  );
};


const isSupportedCredentialPrefix = (
  credential
) => {
  return (
    credential.startsWith(
      PICKUP_TOKEN_PREFIX
    ) ||
    credential.startsWith(
      PICKUP_SIGNED_TOKEN_PREFIX
    )
  );
};


const normalizeCredential = (value) => {
  const credential =
    String(value || "").trim();

  if (
    !credential ||
    credential.length > 128 ||
    !isSupportedCredentialPrefix(
      credential
    )
  ) {
    throw createServiceError(
      "El código de retiro no es válido",
      400,
      "PICKUP_TOKEN_INVALID"
    );
  }

  return credential;
};


const resolvePickupCredentialFromSnapshot = (
  pickup
) => {
  if (
    !pickup?.id ||
    !pickup?.generated_at ||
    !pickup?.token_hash
  ) {
    return null;
  }

  const credential =
    buildSignedPickupCredential(
      pickup.id,
      pickup.generated_at
    );

  const candidateHash =
    hashPickupCredential(
      credential
    );

  if (
    candidateHash !==
    String(
      pickup.token_hash ||
        ""
    )
      .trim()
      .toLowerCase()
  ) {
    return null;
  }

  return credential;
};


const serializePickupForClient = (
  pickup
) => {
  if (!pickup) {
    return null;
  }

  const credential =
    resolvePickupCredentialFromSnapshot(
      pickup
    );

  const status =
    String(
      pickup.status ||
        ""
    )
      .trim()
      .toUpperCase();

  const canExposeQr =
    Boolean(credential) &&
    ![
      "USED",
      "REVOKED",
      "EXPIRED",
    ].includes(status);

  return {
    ...pickup,

    qr: canExposeQr
      ? {
          version:
            "LWPU2",
          value:
            credential,
          token:
            credential,
          one_time:
            true,
          contains_personal_data:
            false,
        }
      : null,

    qr_plaintext_available:
      canExposeQr,

    legacy_credential:
      !credential,
  };
};


const assertOrderAccess = ({
  order,
  requesterUserId,
  requesterRole,
}) => {
  if (isAdminRole(requesterRole)) {
    return;
  }

  if (
    !requesterUserId ||
    !order?.user_id ||
    String(order.user_id) !==
      String(requesterUserId)
  ) {
    throw createServiceError(
      "No tienes permiso para consultar este retiro",
      403,
      "PICKUP_ACCESS_DENIED"
    );
  }
};


const assertPickupReadAccess = ({
  order,
  requesterUserId,
  requesterRole,
}) => {
  if (
    isPickupOperatorRole(
      requesterRole
    )
  ) {
    return;
  }

  assertOrderAccess({
    order,
    requesterUserId,
    requesterRole,
  });
};


const assertPickupOperator = (role) => {
  if (
    !isPickupOperatorRole(
      role
    )
  ) {
    throw createServiceError(
      "No tienes permisos para gestionar la entrega de retiros",
      403,
      "PICKUP_OPERATOR_REQUIRED"
    );
  }
};


const assertAdmin = (role) => {
  if (!isAdminRole(role)) {
    throw createServiceError(
      "No tienes permisos para realizar esta operación",
      403,
      "PICKUP_ADMIN_REQUIRED"
    );
  }
};


/* =========================================
   MÉTODO RETIRO EN TIENDA
========================================= */
const getStorePickupShippingMethod =
  async (client) => {
    const result =
      await client.query(
        `
          SELECT
            id,
            code,
            name,
            method_type,
            requires_address,
            base_price,
            is_active

          FROM shipping_methods

          WHERE code = 'STORE_PICKUP'
            AND method_type = 'PICKUP'
            AND is_active = TRUE

          LIMIT 1
        `
      );

    if (result.rowCount === 0) {
      throw createServiceError(
        "El método Retiro en tienda no está disponible",
        409,
        "STORE_PICKUP_METHOD_NOT_AVAILABLE"
      );
    }

    return result.rows[0];
  };


/* =========================================
   ORDEN + PAGO
========================================= */
const getOrderForUpdate =
  async (
    client,
    orderId
  ) => {
    const result =
      await client.query(
        `
          SELECT
            o.id,
            o.order_number,
            o.user_id,
            o.company_id,
            o.status,
            o.payment_status,
            o.fulfillment_status,
            o.total,
            o.currency,
            o.source,

            p.id AS payment_id,
            p.status AS payment_record_status,
            p.confirmed_at AS payment_confirmed_at

          FROM orders o

          LEFT JOIN payments p
            ON p.order_id = o.id

          WHERE o.id = $1

          LIMIT 1

          FOR UPDATE OF o
        `,
        [orderId]
      );

    if (result.rowCount === 0) {
      throw createServiceError(
        "La orden no existe",
        404,
        "ORDER_NOT_FOUND"
      );
    }

    return result.rows[0];
  };


const assertOrderCanUsePickup = (
  order,
  {
    requireReady = false,
  } = {}
) => {
  const orderStatus =
    String(order.status || "")
      .trim()
      .toUpperCase();

  if (orderStatus === "CANCELLED") {
    throw createServiceError(
      "No se puede gestionar retiro para una orden cancelada",
      409,
      "ORDER_CANCELLED"
    );
  }

  if (
    String(
      order.payment_status || ""
    )
      .trim()
      .toUpperCase() !== "PAID" ||
    String(
      order.payment_record_status || ""
    )
      .trim()
      .toUpperCase() !== "PAID"
  ) {
    throw createServiceError(
      "La orden debe estar pagada antes de habilitar el retiro",
      409,
      "PICKUP_PAYMENT_NOT_CONFIRMED"
    );
  }

  if (requireReady) {
    const fulfillment =
      String(
        order.fulfillment_status || ""
      )
        .trim()
        .toUpperCase();

    if (
      fulfillment !==
      "READY_FOR_PICKUP"
    ) {
      throw createServiceError(
        "La orden todavía no está lista para retiro",
        409,
        "PICKUP_ORDER_NOT_READY"
      );
    }
  }
};


/* =========================================
   SNAPSHOT RETIRO
========================================= */
const getPickupSnapshotByOrder =
  async (
    client,
    orderId
  ) => {
    const result =
      await client.query(
        `
          SELECT
            sp.id,
            sp.order_id,
            sp.shipping_method_id,
            sp.token_hash,
            sp.status,
            sp.generated_at,
            sp.expires_at,
            sp.used_at,
            sp.used_by,
            sp.revoked_at,
            sp.revoked_by,
            sp.revoke_reason,
            sp.created_at,
            sp.updated_at,

            sm.code AS shipping_method_code,
            sm.name AS shipping_method_name,

            o.order_number,
            o.user_id,
            o.status AS order_status,
            o.payment_status AS order_payment_status,
            o.fulfillment_status

          FROM store_pickups sp

          INNER JOIN shipping_methods sm
            ON sm.id = sp.shipping_method_id

          INNER JOIN orders o
            ON o.id = sp.order_id

          WHERE sp.order_id = $1

          LIMIT 1
        `,
        [orderId]
      );

    return (
      result.rows[0] ||
      null
    );
  };


/* =========================================
   ASEGURAR PICKUP AL CONFIRMAR PAGO

   - Idempotente por orders.id
   - Crea PENDING
   - NO cambia fulfillment_status
   - NO marca READY_FOR_PICKUP
   - El QR puede mostrarse al cliente desde
     el pago confirmado.
========================================= */
export const ensureStorePickupForPaidOrder =
  async (
    dbClient,
    orderId
  ) => {
    const db =
      dbClient ||
      pool;

    const normalizedOrderId =
      String(
        orderId ||
        ""
      ).trim();

    if (!normalizedOrderId) {
      throw createServiceError(
        "orderId es obligatorio",
        400,
        "PICKUP_ORDER_ID_REQUIRED"
      );
    }

    const orderResult =
      await db.query(
        `
          SELECT
            o.id,
            o.order_number,
            o.status,
            o.payment_status,
            o.fulfillment_status,

            p.status AS payment_record_status

          FROM orders o

          LEFT JOIN payments p
            ON p.order_id = o.id

          WHERE o.id = $1

          LIMIT 1
        `,
        [
          normalizedOrderId,
        ]
      );

    if (
      orderResult.rowCount ===
      0
    ) {
      throw createServiceError(
        "La orden no existe",
        404,
        "ORDER_NOT_FOUND"
      );
    }

    const order =
      orderResult.rows[0];

    const orderStatus =
      String(
        order.status ||
        ""
      )
        .trim()
        .toUpperCase();

    if (
      orderStatus ===
      "CANCELLED"
    ) {
      return null;
    }

    if (
      String(
        order.payment_status ||
          ""
      )
        .trim()
        .toUpperCase() !==
        "PAID" ||
      String(
        order.payment_record_status ||
          ""
      )
        .trim()
        .toUpperCase() !==
        "PAID"
    ) {
      return null;
    }

    const existing =
      await getPickupSnapshotByOrder(
        db,
        normalizedOrderId
      );

    if (existing) {
      return {
        order,
        pickup:
          serializePickupForClient(
            existing
          ),
        created:
          false,
      };
    }

    const shippingMethod =
      await getStorePickupShippingMethod(
        db
      );

    const pickupId =
      crypto.randomUUID();

    const generatedAt =
      new Date();

    const credential =
      buildSignedPickupCredential(
        pickupId,
        generatedAt
      );

    const tokenHash =
      hashPickupCredential(
        credential
      );

    try {
      await db.query(
        `
          INSERT INTO store_pickups (
            id,
            order_id,
            shipping_method_id,
            token_hash,
            pin_hash,
            status,
            generated_at,
            expires_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            NULL,
            'PENDING',
            $5,
            NULL
          )
        `,
        [
          pickupId,
          normalizedOrderId,
          shippingMethod.id,
          tokenHash,
          generatedAt,
        ]
      );
    } catch (error) {
      if (
        error?.code ===
        "23505"
      ) {
        const racedPickup =
          await getPickupSnapshotByOrder(
            db,
            normalizedOrderId
          );

        if (racedPickup) {
          return {
            order,
            pickup:
              serializePickupForClient(
                racedPickup
              ),
            created:
              false,
          };
        }
      }

      throw error;
    }

    const pickup =
      await getPickupSnapshotByOrder(
        db,
        normalizedOrderId
      );

    return {
      order,
      pickup:
        serializePickupForClient(
          pickup
        ),
      created:
        true,
    };
  };


/* =========================================
   ACTIVAR / ROTAR TOKEN

   actor ADMIN confirma que físicamente el
   pedido ya se encuentra listo para retiro.
========================================= */
export const activateStorePickup =
  async ({
    orderId,
    actorUserId,
    actorRole,
  }) => {
    assertPickupOperator(
      actorRole
    );

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const order =
        await getOrderForUpdate(
          client,
          orderId
        );

      assertOrderCanUsePickup(
        order
      );

      const shippingMethod =
        await getStorePickupShippingMethod(
          client
        );

      const existingResult =
        await client.query(
          `
            SELECT
              id,
              token_hash,
              status,
              generated_at,
              expires_at

            FROM store_pickups

            WHERE order_id = $1

            LIMIT 1

            FOR UPDATE
          `,
          [orderId]
        );

      const existing =
        existingResult.rows[0] ||
        null;

      if (
        existing &&
        String(existing.status)
          .trim()
          .toUpperCase() ===
          "USED"
      ) {
        throw createServiceError(
          "El retiro de esta orden ya fue utilizado",
          409,
          "PICKUP_ALREADY_USED"
        );
      }

      let expiresAt =
        buildExpiryDate();

      let pickupId;
      let credential;
      let created = false;
      let rotated = false;
      let alreadyActive = false;

      const existingStatus =
        String(
          existing?.status ||
            ""
        )
          .trim()
          .toUpperCase();

      /*
       * PENDING -> ACTIVE:
       * conserva exactamente la misma credencial
       * LWPU2 creada al confirmar el pago.
       */
      if (
        existing &&
        existingStatus ===
          "PENDING"
      ) {
        credential =
          resolvePickupCredentialFromSnapshot(
            existing
          );

        if (!credential) {
          /*
           * Compatibilidad con pickups PENDING
           * heredados: si no podemos reconstruir
           * el token, lo rotamos a LWPU2.
           */
          const generatedAt =
            new Date();

          credential =
            buildSignedPickupCredential(
              existing.id,
              generatedAt
            );

          const tokenHash =
            hashPickupCredential(
              credential
            );

          await client.query(
            `
              UPDATE store_pickups

              SET
                shipping_method_id = $2,
                token_hash = $3,
                pin_hash = NULL,
                status = 'ACTIVE',
                generated_at = $4,
                expires_at = $5,
                used_at = NULL,
                used_by = NULL,
                revoked_at = NULL,
                revoked_by = NULL,
                revoke_reason = NULL

              WHERE id = $1
            `,
            [
              existing.id,
              shippingMethod.id,
              tokenHash,
              generatedAt,
              expiresAt,
            ]
          );

          rotated = true;
        } else {
          await client.query(
            `
              UPDATE store_pickups

              SET
                shipping_method_id = $2,
                pin_hash = NULL,
                status = 'ACTIVE',
                expires_at = $3,
                used_at = NULL,
                used_by = NULL,
                revoked_at = NULL,
                revoked_by = NULL,
                revoke_reason = NULL

              WHERE id = $1
            `,
            [
              existing.id,
              shippingMethod.id,
              expiresAt,
            ]
          );
        }

        pickupId =
          existing.id;
      }

      /*
       * ACTIVE -> ACTIVE:
       * idempotente.
       *
       * NO rotamos el QR en una segunda pulsación
       * del administrador porque ese QR puede haber
       * sido enviado por Email 2.
       *
       * Si el QR ACTIVE ya expiró o no puede
       * reconstruirse, debe usarse explícitamente
       * el endpoint de reemisión de credencial.
       */
      else if (
        existing &&
        existingStatus ===
          "ACTIVE"
      ) {
        credential =
          resolvePickupCredentialFromSnapshot(
            existing
          );

        const currentExpiry =
          existing.expires_at
            ? new Date(
                existing.expires_at
              )
            : null;

        if (!credential) {
          throw createServiceError(
            "El retiro ya está activo pero su credencial no puede reconstruirse. Usa la reemisión explícita de credencial.",
            409,
            "PICKUP_ACTIVE_CREDENTIAL_REISSUE_REQUIRED"
          );
        }

        if (
          !currentExpiry ||
          Number.isNaN(
            currentExpiry.getTime()
          ) ||
          currentExpiry.getTime() <=
            Date.now()
        ) {
          throw createServiceError(
            "El retiro ya está activo pero su credencial expiró. Usa la reemisión explícita de credencial.",
            409,
            "PICKUP_ACTIVE_CREDENTIAL_EXPIRED"
          );
        }

        expiresAt =
          currentExpiry;

        pickupId =
          existing.id;

        alreadyActive =
          true;
      }

      /*
       * Otros estados existentes, como REVOKED
       * o EXPIRED, conservan el comportamiento
       * anterior: se crea una nueva credencial.
       */
      else if (existing) {
        const generatedAt =
          new Date();

        credential =
          buildSignedPickupCredential(
            existing.id,
            generatedAt
          );

        const tokenHash =
          hashPickupCredential(
            credential
          );

        await client.query(
          `
            UPDATE store_pickups

            SET
              shipping_method_id = $2,
              token_hash = $3,
              pin_hash = NULL,
              status = 'ACTIVE',
              generated_at = $4,
              expires_at = $5,
              used_at = NULL,
              used_by = NULL,
              revoked_at = NULL,
              revoked_by = NULL,
              revoke_reason = NULL

            WHERE id = $1
          `,
          [
            existing.id,
            shippingMethod.id,
            tokenHash,
            generatedAt,
            expiresAt,
          ]
        );

        pickupId =
          existing.id;

        rotated = true;
      } else {
        const pickupIdCandidate =
          crypto.randomUUID();

        const generatedAt =
          new Date();

        credential =
          buildSignedPickupCredential(
            pickupIdCandidate,
            generatedAt
          );

        const tokenHash =
          hashPickupCredential(
            credential
          );

        const inserted =
          await client.query(
            `
              INSERT INTO store_pickups (
                id,
                order_id,
                shipping_method_id,
                token_hash,
                pin_hash,
                status,
                generated_at,
                expires_at
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                NULL,
                'ACTIVE',
                $5,
                $6
              )
              RETURNING id
            `,
            [
              pickupIdCandidate,
              orderId,
              shippingMethod.id,
              tokenHash,
              generatedAt,
              expiresAt,
            ]
          );

        pickupId =
          inserted.rows[0].id;

        created = true;
      }

      await client.query(
        `
          UPDATE orders

          SET
            fulfillment_status =
              'READY_FOR_PICKUP',

            status =
              CASE
                WHEN status IN (
                  'PENDING',
                  'CONFIRMED'
                )
                  THEN 'PROCESSING'
                ELSE status
              END

          WHERE id = $1
        `,
        [orderId]
      );

      const pickupSnapshot =
        await getPickupSnapshotByOrder(
          client,
          orderId
        );

      const pickup =
        serializePickupForClient(
          pickupSnapshot
        );

      /*
       * TRANSACTIONAL OUTBOX:
       * el evento ORDER_READY_FOR_PICKUP queda
       * guardado dentro de la MISMA transacción
       * que activa el retiro.
       *
       * NO envía correo aquí.
       * NO llama a Relbase.
       * NO toca emisión DTE.
       */
      const emailArtifacts =
        await ensureOrderReadyForPickupEmailArtifacts({
          dbClient:
            client,
          orderId,
          pickupId,
        });

      await client.query("COMMIT");

      return {
        created,
        rotated,
        already_active:
          alreadyActive,

        pickup,

        credential: {
          qr_value:
            credential,

          expires_at:
            expiresAt.toISOString(),

          one_time:
            true,

          contains_personal_data:
            false,
        },

        email_2: {
          eligible:
            true,

          prepared:
            true,

          event_created:
            emailArtifacts
              .event_created,

          event_already_exists:
            emailArtifacts
              .event_already_exists,

          outbox_id:
            emailArtifacts
              .outbox.id,

          outbox_status:
            emailArtifacts
              .outbox.status,

          pickup_id:
            emailArtifacts
              .outbox.pickup_id,

          tax_document_id:
            emailArtifacts
              .outbox.tax_document_id,

          document_access_id:
            emailArtifacts
              .document_access.id,

          document_access_expires_at:
            emailArtifacts
              .document_access
              .expires_at,

          error:
            null,
        },
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La transacción puede haber finalizado.
      }

      throw error;
    } finally {
      client.release();
    }
  };


/* =========================================
   REEMITIR CREDENCIAL PARA CLIENTE/ADMIN

   Nunca recuperamos el token anterior porque
   no existe en plaintext. Se rota y se invalida
   automáticamente el QR anterior.
========================================= */
export const reissueStorePickupCredential =
  async ({
    orderId,
    requesterUserId,
    requesterRole,
  }) => {
    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const order =
        await getOrderForUpdate(
          client,
          orderId
        );

      assertOrderAccess({
        order,
        requesterUserId,
        requesterRole,
      });

      assertOrderCanUsePickup(
        order,
        {
          requireReady: true,
        }
      );

      const pickupResult =
        await client.query(
          `
            SELECT
              id,
              status

            FROM store_pickups

            WHERE order_id = $1

            LIMIT 1

            FOR UPDATE
          `,
          [orderId]
        );

      if (
        pickupResult.rowCount === 0
      ) {
        throw createServiceError(
          "La orden todavía no posee un retiro activo",
          404,
          "PICKUP_NOT_FOUND"
        );
      }

      const pickup =
        pickupResult.rows[0];

      const status =
        String(pickup.status || "")
          .trim()
          .toUpperCase();

      if (status === "USED") {
        throw createServiceError(
          "El retiro ya fue utilizado",
          409,
          "PICKUP_ALREADY_USED"
        );
      }

      if (status === "REVOKED") {
        throw createServiceError(
          "El retiro fue revocado y debe ser reactivado por un administrador",
          409,
          "PICKUP_REVOKED"
        );
      }

      const generatedAt =
        new Date();

      const credential =
        buildSignedPickupCredential(
          pickup.id,
          generatedAt
        );

      const tokenHash =
        hashPickupCredential(
          credential
        );

      const expiresAt =
        buildExpiryDate();

      await client.query(
        `
          UPDATE store_pickups

          SET
            token_hash = $2,
            status = 'ACTIVE',
            generated_at = $3,
            expires_at = $4

          WHERE id = $1
        `,
        [
          pickup.id,
          tokenHash,
          generatedAt,
          expiresAt,
        ]
      );

      const snapshot =
        serializePickupForClient(
          await getPickupSnapshotByOrder(
            client,
            orderId
          )
        );

      await client.query("COMMIT");

      return {
        rotated: true,
        previous_qr_invalidated:
          true,

        pickup: snapshot,

        credential: {
          qr_value:
            credential,

          expires_at:
            expiresAt.toISOString(),

          one_time:
            true,

          contains_personal_data:
            false,
        },
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La transacción puede haber finalizado.
      }

      throw error;
    } finally {
      client.release();
    }
  };


/* =========================================
   CONSULTAR ESTADO
========================================= */
export const getStorePickupByOrder =
  async ({
    orderId,
    requesterUserId,
    requesterRole,
  }) => {
    const result =
      await pool.query(
        `
          SELECT
            o.id,
            o.user_id,
            o.order_number,
            o.status,
            o.payment_status,
            o.fulfillment_status

          FROM orders o

          WHERE o.id = $1

          LIMIT 1
        `,
        [orderId]
      );

    if (result.rowCount === 0) {
      throw createServiceError(
        "La orden no existe",
        404,
        "ORDER_NOT_FOUND"
      );
    }

    const order =
      result.rows[0];

    assertPickupReadAccess({
      order,
      requesterUserId,
      requesterRole,
    });

    const pickupSnapshot =
      await getPickupSnapshotByOrder(
        pool,
        orderId
      );

    const pickup =
      serializePickupForClient(
        pickupSnapshot
      );

    /*
     * El VENDEDOR necesita consultar el estado
     * operativo del retiro para poder entregarlo,
     * pero no necesita conocer el secreto QR del
     * cliente. El QR debe ser presentado físicamente
     * por el cliente y leído desde el Lector QR.
     */
    const exposedPickup =
      isSellerRole(
        requesterRole
      ) &&
      pickup
        ? {
            ...pickup,
            qr:
              null,
            qr_plaintext_available:
              false,
          }
        : pickup;

    return {
      order: {
        id:
          order.id,
        order_number:
          order.order_number,
        status:
          order.status,
        payment_status:
          order.payment_status,
        fulfillment_status:
          order.fulfillment_status,
      },

      pickup:
        exposedPickup,

      qr_plaintext_available:
        Boolean(
          exposedPickup
            ?.qr
            ?.value
        ),

      next_action:
        !exposedPickup
          ? "WAIT_FOR_PICKUP_ACTIVATION"
          : exposedPickup.status ===
              "PENDING"
            ? "MARK_READY_FOR_PICKUP"
            : exposedPickup.status ===
                "ACTIVE"
              ? "SCAN_CUSTOMER_QR"
              : null,
    };
  };


/* =========================================
   LOG DE ESCANEO
========================================= */
const insertScanLog =
  async (
    client,
    {
      pickupId = null,
      attemptedTokenHash = null,
      resultCode,
      success,
      scannedBy = null,
      ipAddress = null,
      userAgent = null,
      notes = null,
    }
  ) => {
    await client.query(
      `
        INSERT INTO store_pickup_scan_logs (
          pickup_id,
          attempted_token_hash,
          scan_method,
          result_code,
          success,
          scanned_by,
          ip_address,
          user_agent,
          notes
        )
        VALUES (
          $1,
          $2,
          'QR',
          $3,
          $4,
          $5,
          $6,
          $7,
          $8
        )
      `,
      [
        pickupId,
        attemptedTokenHash,
        resultCode,
        success,
        scannedBy,
        ipAddress,
        userAgent,
        notes,
      ]
    );
  };


const failScan =
  async (
    client,
    {
      pickupId = null,
      attemptedTokenHash,
      resultCode,
      scannedBy,
      ipAddress,
      userAgent,
      message,
      status,
      code,
      notes = null,
    }
  ) => {
    await insertScanLog(
      client,
      {
        pickupId,
        attemptedTokenHash,
        resultCode,
        success: false,
        scannedBy,
        ipAddress,
        userAgent,
        notes,
      }
    );

    await client.query("COMMIT");

    throw createServiceError(
      message,
      status,
      code
    );
  };


/* =========================================
   ESCANEAR / CONSUMIR QR
========================================= */
export const consumeStorePickupQr =
  async ({
    token,
    scannedBy,
    scannerRole,
    ipAddress = null,
    userAgent = null,
  }) => {
    const rawCredential =
      String(token || "").trim();

    const attemptedTokenHash =
      hashPickupCredential(
        rawCredential
      );

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      if (!isPickupScannerRole(scannerRole)) {
        await failScan(
          client,
          {
            attemptedTokenHash,
            resultCode:
              "UNAUTHORIZED",
            scannedBy,
            ipAddress,
            userAgent,
            message:
              "No tienes permisos para validar retiros",
            status: 403,
            code:
              "PICKUP_SCAN_UNAUTHORIZED",
          }
        );
      }

      if (
        !rawCredential ||
        rawCredential.length > 128 ||
        !isSupportedCredentialPrefix(
          rawCredential
        )
      ) {
        await failScan(
          client,
          {
            attemptedTokenHash,
            resultCode:
              "INVALID_TOKEN",
            scannedBy,
            ipAddress,
            userAgent,
            message:
              "El código de retiro no es válido",
            status: 400,
            code:
              "PICKUP_TOKEN_INVALID",
          }
        );
      }

      const credential =
        normalizeCredential(
          rawCredential
        );

      const result =
        await client.query(
          `
            SELECT
              sp.id AS pickup_id,
              sp.order_id,
              sp.status AS pickup_status,
              sp.generated_at,
              sp.expires_at,
              sp.used_at,
              sp.used_by,
              sp.revoked_at,
              sp.revoke_reason,

              o.order_number,
              o.status AS order_status,
              o.payment_status AS order_payment_status,
              o.fulfillment_status,
              o.total,
              o.currency,

              p.id AS payment_id,
              p.status AS payment_status

            FROM store_pickups sp

            INNER JOIN orders o
              ON o.id = sp.order_id

            INNER JOIN payments p
              ON p.order_id = o.id

            WHERE sp.token_hash = $1

            LIMIT 1

            FOR UPDATE OF sp, o, p
          `,
          [attemptedTokenHash]
        );

      if (result.rowCount === 0) {
        await failScan(
          client,
          {
            attemptedTokenHash,
            resultCode:
              "INVALID_TOKEN",
            scannedBy,
            ipAddress,
            userAgent,
            message:
              "El código de retiro no es válido",
            status: 404,
            code:
              "PICKUP_TOKEN_NOT_FOUND",
          }
        );
      }

      const current =
        result.rows[0];

      const pickupStatus =
        String(
          current.pickup_status ||
            ""
        )
          .trim()
          .toUpperCase();

      if (pickupStatus === "USED") {
        await failScan(
          client,
          {
            pickupId:
              current.pickup_id,
            attemptedTokenHash,
            resultCode:
              "ALREADY_USED",
            scannedBy,
            ipAddress,
            userAgent,
            message:
              "Este código de retiro ya fue utilizado",
            status: 409,
            code:
              "PICKUP_ALREADY_USED",
          }
        );
      }

      if (pickupStatus === "REVOKED") {
        await failScan(
          client,
          {
            pickupId:
              current.pickup_id,
            attemptedTokenHash,
            resultCode:
              "REVOKED",
            scannedBy,
            ipAddress,
            userAgent,
            message:
              "Este código de retiro fue revocado",
            status: 409,
            code:
              "PICKUP_REVOKED",
          }
        );
      }

      if (
        current.expires_at &&
        new Date(
          current.expires_at
        ).getTime() <= Date.now()
      ) {
        await client.query(
          `
            UPDATE store_pickups
            SET status = 'EXPIRED'
            WHERE id = $1
          `,
          [current.pickup_id]
        );

        await failScan(
          client,
          {
            pickupId:
              current.pickup_id,
            attemptedTokenHash,
            resultCode:
              "EXPIRED",
            scannedBy,
            ipAddress,
            userAgent,
            message:
              "Este código de retiro está vencido",
            status: 410,
            code:
              "PICKUP_EXPIRED",
          }
        );
      }

      if (
        String(
          current.order_payment_status ||
            ""
        )
          .trim()
          .toUpperCase() !== "PAID" ||
        String(
          current.payment_status ||
            ""
        )
          .trim()
          .toUpperCase() !== "PAID"
      ) {
        await failScan(
          client,
          {
            pickupId:
              current.pickup_id,
            attemptedTokenHash,
            resultCode:
              "PAYMENT_NOT_CONFIRMED",
            scannedBy,
            ipAddress,
            userAgent,
            message:
              "El pago de la orden no está confirmado",
            status: 409,
            code:
              "PICKUP_PAYMENT_NOT_CONFIRMED",
          }
        );
      }

      if (
        String(
          current.fulfillment_status ||
            ""
        )
          .trim()
          .toUpperCase() !==
        "READY_FOR_PICKUP"
      ) {
        await failScan(
          client,
          {
            pickupId:
              current.pickup_id,
            attemptedTokenHash,
            resultCode:
              "ORDER_NOT_READY",
            scannedBy,
            ipAddress,
            userAgent,
            message:
              "La orden no está disponible para retiro",
            status: 409,
            code:
              "PICKUP_ORDER_NOT_READY",
          }
        );
      }

      if (
        String(
          current.order_status || ""
        )
          .trim()
          .toUpperCase() ===
        "CANCELLED"
      ) {
        await failScan(
          client,
          {
            pickupId:
              current.pickup_id,
            attemptedTokenHash,
            resultCode:
              "ORDER_NOT_READY",
            scannedBy,
            ipAddress,
            userAgent,
            message:
              "La orden fue cancelada",
            status: 409,
            code:
              "ORDER_CANCELLED",
          }
        );
      }

      const pickupUpdate =
        await client.query(
          `
            UPDATE store_pickups

            SET
              status = 'USED',
              used_at = NOW(),
              used_by = $2

            WHERE id = $1
              AND status = 'ACTIVE'

            RETURNING
              id,
              order_id,
              status,
              used_at,
              used_by
          `,
          [
            current.pickup_id,
            scannedBy,
          ]
        );

      if (
        pickupUpdate.rowCount !== 1
      ) {
        throw createServiceError(
          "El retiro cambió de estado durante la validación",
          409,
          "PICKUP_CONSUME_CONFLICT"
        );
      }

      const orderUpdate =
        await client.query(
          `
            UPDATE orders

            SET
              fulfillment_status =
                'DELIVERED',
              status = 'COMPLETED'

            WHERE id = $1

            RETURNING
              id,
              order_number,
              status,
              payment_status,
              fulfillment_status,
              total,
              currency
          `,
          [current.order_id]
        );

      await insertScanLog(
        client,
        {
          pickupId:
            current.pickup_id,
          attemptedTokenHash,
          resultCode:
            "VALID",
          success: true,
          scannedBy,
          ipAddress,
          userAgent,
          notes:
            "Retiro confirmado mediante QR de un solo uso",
        }
      );

      await client.query("COMMIT");

      return {
        consumed: true,
        reusable: false,

        pickup:
          pickupUpdate.rows[0],

        order:
          orderUpdate.rows[0],
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Puede haber sido COMMIT en failScan.
      }

      throw error;
    } finally {
      client.release();
    }
  };


/* =========================================
   REVOCAR RETIRO
========================================= */
export const revokeStorePickup =
  async ({
    pickupId,
    revokedBy,
    requesterRole,
    reason,
  }) => {
    assertAdmin(requesterRole);

    const normalizedReason =
      String(reason || "").trim();

    if (!normalizedReason) {
      throw createServiceError(
        "Se requiere un motivo de revocación",
        400,
        "PICKUP_REVOKE_REASON_REQUIRED"
      );
    }

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const result =
        await client.query(
          `
            SELECT
              id,
              order_id,
              status,
              revoked_at,
              revoked_by,
              revoke_reason

            FROM store_pickups

            WHERE id = $1

            LIMIT 1

            FOR UPDATE
          `,
          [pickupId]
        );

      if (result.rowCount === 0) {
        throw createServiceError(
          "El retiro no existe",
          404,
          "PICKUP_NOT_FOUND"
        );
      }

      const current =
        result.rows[0];

      const status =
        String(current.status || "")
          .trim()
          .toUpperCase();

      if (status === "USED") {
        throw createServiceError(
          "No se puede revocar un retiro que ya fue utilizado",
          409,
          "PICKUP_ALREADY_USED"
        );
      }

      if (status === "REVOKED") {
        await client.query("COMMIT");

        return {
          revoked: true,
          already_revoked: true,
          pickup: current,
        };
      }

      const updated =
        await client.query(
          `
            UPDATE store_pickups

            SET
              status = 'REVOKED',
              revoked_at = NOW(),
              revoked_by = $2,
              revoke_reason = $3

            WHERE id = $1

            RETURNING
              id,
              order_id,
              status,
              revoked_at,
              revoked_by,
              revoke_reason
          `,
          [
            pickupId,
            revokedBy,
            normalizedReason,
          ]
        );

      await client.query("COMMIT");

      return {
        revoked: true,
        already_revoked: false,
        pickup:
          updated.rows[0],
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // La transacción puede haber finalizado.
      }

      throw error;
    } finally {
      client.release();
    }
  };
