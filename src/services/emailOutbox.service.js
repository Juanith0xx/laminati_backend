import pool from "../config/database.js";

import {
  ensureCustomerDocumentAccessForAcceptedDte,
} from "./customerDocumentAccess.service.js";

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

const cleanText = (
  value
) =>
  String(
    value ?? ""
  ).trim();

const isValidEmail = (
  value
) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    cleanText(
      value
    )
  );

const resolveDocumentFormat = ({
  value,
  documentType,
}) => {
  const raw =
    cleanText(
      value
    ).toLowerCase();

  const normalizedType =
    cleanText(
      documentType
    ).toUpperCase();

  const fallback =
    normalizedType ===
    "FACTURA"
      ? "letter"
      : "original";

  if (!raw) {
    return fallback;
  }

  if (
    [
      "letter",
      "carta",
      "a4",
    ].includes(raw)
  ) {
    if (
      normalizedType !==
      "FACTURA"
    ) {
      throw createServiceError(
        "El formato Carta / A4 sólo se encuentra habilitado para facturas",
        409,
        "EMAIL_OUTBOX_DOCUMENT_FORMAT_NOT_ALLOWED"
      );
    }

    return "letter";
  }

  if (
    [
      "original",
      "pos",
      "80mm",
      "80-mm",
    ].includes(raw)
  ) {
    return "original";
  }

  throw createServiceError(
    "Formato de documento no soportado. Usa letter o original.",
    400,
    "EMAIL_OUTBOX_DOCUMENT_FORMAT_INVALID"
  );
};

export const ensureDteAcceptedEmailArtifacts =
  async ({
    taxDocumentId,
    recipientEmailOverride = null,
    documentFormat = null,
    forceResend = false,
  }) => {
    const normalizedTaxDocumentId =
      cleanText(
        taxDocumentId
      );

    if (
      !normalizedTaxDocumentId
    ) {
      throw createServiceError(
        "taxDocumentId es obligatorio",
        400,
        "EMAIL_OUTBOX_TAX_DOCUMENT_ID_REQUIRED"
      );
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const dteResult =
        await client.query(
          `
            SELECT
              td.id AS tax_document_id,
              td.order_id,
              td.document_type,
              td.status AS tax_document_status,
              td.sii_status,
              td.sii_status_name,
              td.folio,
              td.relbase_document_id,
              td.total_amount,

              o.order_number,
              o.customer_name,
              o.email,
              o.source,
              o.payment_status AS order_payment_status,
              o.total AS order_total,
              o.currency,

              p.status AS payment_status

            FROM tax_documents td

            INNER JOIN orders o
              ON o.id = td.order_id

            INNER JOIN payments p
              ON p.order_id = o.id

            WHERE td.id = $1

            LIMIT 1

            FOR UPDATE OF td, o
          `,
          [
            normalizedTaxDocumentId,
          ]
        );

      if (
        dteResult.rowCount ===
        0
      ) {
        throw createServiceError(
          "El documento tributario local no existe",
          404,
          "TAX_DOCUMENT_NOT_FOUND"
        );
      }

      const dte =
        dteResult.rows[0];

      const resolvedDocumentFormat =
        resolveDocumentFormat({
          value:
            documentFormat,
          documentType:
            dte.document_type,
        });

      if (
        cleanText(
          dte.tax_document_status
        ).toUpperCase() !==
          "ACCEPTED" ||
        ![
          "accepted",
          "aceptado",
        ].includes(
          cleanText(
            dte.sii_status
          ).toLowerCase()
        )
      ) {
        throw createServiceError(
          "El Email 1 sólo puede prepararse cuando el DTE está ACCEPTED por el SII",
          409,
          "EMAIL_OUTBOX_DTE_NOT_ACCEPTED"
        );
      }

      if (
        cleanText(
          dte.order_payment_status
        ).toUpperCase() !==
          "PAID" ||
        cleanText(
          dte.payment_status
        ).toUpperCase() !==
          "PAID"
      ) {
        throw createServiceError(
          "El Email 1 sólo puede prepararse para un pedido pagado",
          409,
          "EMAIL_OUTBOX_ORDER_NOT_PAID"
        );
      }

      const recipientEmail =
        cleanText(
          recipientEmailOverride ||
            dte.email
        ).toLowerCase();

      if (
        !isValidEmail(
          recipientEmail
        )
      ) {
        throw createServiceError(
          "El pedido no posee un correo válido para la notificación",
          409,
          "EMAIL_OUTBOX_RECIPIENT_INVALID"
        );
      }

      const documentAccess =
        await ensureCustomerDocumentAccessForAcceptedDte(
          client,
          normalizedTaxDocumentId
        );

      const payload = {
        schema:
          "LAMINATIWORD_EMAIL_EVENT_V1",
        order_number:
          dte.order_number,
        customer_name:
          dte.customer_name ||
          null,
        total:
          Number(
            dte.order_total
          ),
        currency:
          dte.currency ||
          "CLP",
        source:
          dte.source ||
          null,
        document_type:
          dte.document_type,
        document_format:
          resolvedDocumentFormat,
        folio:
          dte.folio ||
          null,
        document_access_id:
          documentAccess.access.id,
      };

      const insertResult =
        await client.query(
          `
            INSERT INTO email_outbox (
              order_id,
              tax_document_id,
              pickup_id,
              event_type,
              recipient_email,
              status,
              attempts,
              max_attempts,
              scheduled_at,
              payload
            )
            VALUES (
              $1,
              $2,
              NULL,
              'DTE_ACCEPTED',
              $3,
              'PENDING',
              0,
              5,
              NOW(),
              $4::jsonb
            )
            ON CONFLICT (
              order_id,
              event_type
            )
            DO NOTHING
            RETURNING
              id,
              order_id,
              tax_document_id,
              pickup_id,
              event_type,
              recipient_email,
              status,
              attempts,
              max_attempts,
              scheduled_at,
              sent_at,
              provider_message_id,
              payload,
              created_at,
              updated_at
          `,
          [
            dte.order_id,
            normalizedTaxDocumentId,
            recipientEmail,
            JSON.stringify(
              payload
            ),
          ]
        );

      let outbox =
        insertResult.rows[0] ||
        null;

      const created =
        insertResult.rowCount ===
        1;

      if (!outbox) {
        const existingResult =
          await client.query(
            `
              SELECT
                id,
                order_id,
                tax_document_id,
                pickup_id,
                event_type,
                recipient_email,
                status,
                attempts,
                max_attempts,
                scheduled_at,
                sent_at,
                provider_message_id,
                payload,
                created_at,
                updated_at
              FROM email_outbox
              WHERE order_id = $1
                AND event_type = 'DTE_ACCEPTED'
              LIMIT 1
            `,
            [
              dte.order_id,
            ]
          );

        outbox =
          existingResult.rows[0] ||
          null;
      }

      if (!outbox) {
        throw createServiceError(
          "No fue posible asegurar el evento DTE_ACCEPTED en email_outbox",
          500,
          "EMAIL_OUTBOX_ENQUEUE_FAILED"
        );
      }

      let manualResendQueued =
        false;

      if (
        forceResend === true &&
        !created
      ) {
        const resendResult =
          await client.query(
            `
              UPDATE email_outbox
              SET
                recipient_email = $2,
                status = 'PENDING',
                attempts = 0,
                scheduled_at = NOW(),
                sent_at = NULL,
                provider_message_id = NULL,
                payload = $3::jsonb,
                updated_at = NOW()
              WHERE id = $1
                AND status <> 'PROCESSING'
              RETURNING
                id,
                order_id,
                tax_document_id,
                pickup_id,
                event_type,
                recipient_email,
                status,
                attempts,
                max_attempts,
                scheduled_at,
                sent_at,
                provider_message_id,
                payload,
                created_at,
                updated_at
            `,
            [
              outbox.id,
              recipientEmail,
              JSON.stringify(
                payload
              ),
            ]
          );

        if (
          resendResult.rowCount !==
          1
        ) {
          throw createServiceError(
            "El correo ya está siendo procesado. Espera a que termine antes de reenviarlo.",
            409,
            "EMAIL_OUTBOX_ALREADY_PROCESSING"
          );
        }

        outbox =
          resendResult.rows[0];

        manualResendQueued =
          true;
      }

      await client.query(
        "COMMIT"
      );

      return {
        event_created:
          created,
        event_already_exists:
          !created,
        manual_resend_queued:
          manualResendQueued,
        outbox,
        document_access: {
          created:
            documentAccess.created,
          credential:
            documentAccess.credential,
          id:
            documentAccess.access.id,
          expires_at:
            documentAccess.access.expires_at,
          security:
            documentAccess.security,
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

/* =========================================
   EMAIL 2 - PEDIDO LISTO PARA RETIRO

   Debe ejecutarse dentro de la misma
   transacción que cambia el pickup a ACTIVE
   y la orden a READY_FOR_PICKUP.

   IMPORTANTE:
   - NO envía correo.
   - NO guarda QR en plaintext.
   - NO llama a Relbase.
   - Sólo asegura el evento idempotente.
========================================= */
export const ensureOrderReadyForPickupEmailArtifacts =
  async ({
    dbClient,
    orderId,
    pickupId,
  }) => {
    if (
      !dbClient ||
      typeof dbClient.query !==
        "function"
    ) {
      throw createServiceError(
        "Email 2 requiere un cliente PostgreSQL transaccional",
        500,
        "EMAIL_OUTBOX_TRANSACTION_CLIENT_REQUIRED"
      );
    }

    const normalizedOrderId =
      cleanText(
        orderId
      );

    const normalizedPickupId =
      cleanText(
        pickupId
      );

    if (
      !normalizedOrderId ||
      !normalizedPickupId
    ) {
      throw createServiceError(
        "orderId y pickupId son obligatorios para preparar Email 2",
        400,
        "EMAIL_OUTBOX_READY_PICKUP_IDS_REQUIRED"
      );
    }

    const result =
      await dbClient.query(
        `
          SELECT
            o.id AS order_id,
            o.order_number,
            o.customer_name,
            o.email,
            o.source,
            o.status AS order_status,
            o.payment_status AS order_payment_status,
            o.fulfillment_status,
            o.total AS order_total,
            o.currency,

            p.status AS payment_status,

            sp.id AS pickup_id,
            sp.status AS pickup_status,
            sp.generated_at AS pickup_generated_at,
            sp.expires_at AS pickup_expires_at,
            sp.used_at AS pickup_used_at,
            sp.revoked_at AS pickup_revoked_at,

            td.id AS tax_document_id,
            td.document_type,
            td.status AS tax_document_status,
            td.sii_status,
            td.sii_status_name,
            td.folio,
            td.relbase_document_id

          FROM orders o

          INNER JOIN payments p
            ON p.order_id = o.id
           AND p.status = 'PAID'

          INNER JOIN store_pickups sp
            ON sp.order_id = o.id
           AND sp.id = $2

          INNER JOIN LATERAL (
            SELECT
              td2.id,
              td2.document_type,
              td2.status,
              td2.sii_status,
              td2.sii_status_name,
              td2.folio,
              td2.relbase_document_id
            FROM tax_documents td2
            WHERE td2.order_id = o.id
              AND td2.status = 'ACCEPTED'
              AND LOWER(
                COALESCE(
                  td2.sii_status,
                  ''
                )
              ) IN (
                'accepted',
                'aceptado'
              )
            LIMIT 1
          ) td
            ON TRUE

          WHERE o.id = $1

          LIMIT 1
        `,
        [
          normalizedOrderId,
          normalizedPickupId,
        ]
      );

    if (
      result.rowCount ===
      0
    ) {
      throw createServiceError(
        "No fue posible preparar Email 2: la orden debe estar pagada, tener retiro válido y DTE ACCEPTED",
        409,
        "EMAIL_OUTBOX_READY_PICKUP_PREREQUISITES_NOT_MET"
      );
    }

    const row =
      result.rows[0];

    if (
      cleanText(
        row.order_status
      ).toUpperCase() ===
        "CANCELLED"
    ) {
      throw createServiceError(
        "No se puede preparar Email 2 para una orden cancelada",
        409,
        "EMAIL_OUTBOX_ORDER_CANCELLED"
      );
    }

    if (
      cleanText(
        row.order_payment_status
      ).toUpperCase() !==
        "PAID" ||
      cleanText(
        row.payment_status
      ).toUpperCase() !==
        "PAID"
    ) {
      throw createServiceError(
        "Email 2 requiere un pedido pagado",
        409,
        "EMAIL_OUTBOX_READY_PICKUP_ORDER_NOT_PAID"
      );
    }

    if (
      cleanText(
        row.fulfillment_status
      ).toUpperCase() !==
        "READY_FOR_PICKUP"
    ) {
      throw createServiceError(
        "Email 2 requiere fulfillment READY_FOR_PICKUP",
        409,
        "EMAIL_OUTBOX_READY_PICKUP_NOT_READY"
      );
    }

    if (
      cleanText(
        row.pickup_status
      ).toUpperCase() !==
        "ACTIVE" ||
      row.pickup_used_at ||
      row.pickup_revoked_at
    ) {
      throw createServiceError(
        "Email 2 requiere un retiro ACTIVE y no utilizado",
        409,
        "EMAIL_OUTBOX_READY_PICKUP_NOT_ACTIVE"
      );
    }

    const pickupExpiresAt =
      new Date(
        row.pickup_expires_at
      );

    if (
      Number.isNaN(
        pickupExpiresAt.getTime()
      ) ||
      pickupExpiresAt.getTime() <=
        Date.now()
    ) {
      throw createServiceError(
        "La credencial de retiro está expirada",
        409,
        "EMAIL_OUTBOX_READY_PICKUP_EXPIRED"
      );
    }

    const recipientEmail =
      cleanText(
        row.email
      ).toLowerCase();

    if (
      !isValidEmail(
        recipientEmail
      )
    ) {
      throw createServiceError(
        "El pedido no posee un correo válido para Email 2",
        409,
        "EMAIL_OUTBOX_READY_PICKUP_RECIPIENT_INVALID"
      );
    }

    const documentAccess =
      await ensureCustomerDocumentAccessForAcceptedDte(
        dbClient,
        row.tax_document_id
      );

    const payload = {
      schema:
        "LAMINATIWORD_EMAIL_EVENT_V1",

      order_number:
        row.order_number,

      customer_name:
        row.customer_name ||
        null,

      total:
        Number(
          row.order_total
        ),

      currency:
        row.currency ||
        "CLP",

      source:
        row.source ||
        null,

      document_type:
        row.document_type,

      folio:
        row.folio ||
        null,

      document_access_id:
        documentAccess.access.id,

      pickup_id:
        row.pickup_id,

      pickup_generated_at:
        row.pickup_generated_at,

      pickup_expires_at:
        row.pickup_expires_at,
    };

    const insertResult =
      await dbClient.query(
        `
          INSERT INTO email_outbox (
            order_id,
            tax_document_id,
            pickup_id,
            event_type,
            recipient_email,
            status,
            attempts,
            max_attempts,
            scheduled_at,
            payload
          )
          VALUES (
            $1,
            $2,
            $3,
            'ORDER_READY_FOR_PICKUP',
            $4,
            'PENDING',
            0,
            5,
            NOW(),
            $5::jsonb
          )

          ON CONFLICT (
            order_id,
            event_type
          )
          DO NOTHING

          RETURNING
            id,
            order_id,
            tax_document_id,
            pickup_id,
            event_type,
            recipient_email,
            status,
            attempts,
            max_attempts,
            scheduled_at,
            sent_at,
            provider_message_id,
            payload,
            created_at,
            updated_at
        `,
        [
          row.order_id,
          row.tax_document_id,
          row.pickup_id,
          recipientEmail,
          JSON.stringify(
            payload
          ),
        ]
      );

    let outbox =
      insertResult.rows[0] ||
      null;

    const created =
      insertResult.rowCount ===
      1;

    if (!outbox) {
      const existingResult =
        await dbClient.query(
          `
            SELECT
              id,
              order_id,
              tax_document_id,
              pickup_id,
              event_type,
              recipient_email,
              status,
              attempts,
              max_attempts,
              scheduled_at,
              sent_at,
              provider_message_id,
              payload,
              created_at,
              updated_at

            FROM email_outbox

            WHERE order_id = $1
              AND event_type =
                'ORDER_READY_FOR_PICKUP'

            LIMIT 1
          `,
          [
            row.order_id,
          ]
        );

      outbox =
        existingResult.rows[0] ||
        null;
    }

    if (!outbox) {
      throw createServiceError(
        "No fue posible asegurar ORDER_READY_FOR_PICKUP en email_outbox",
        500,
        "EMAIL_OUTBOX_READY_PICKUP_ENQUEUE_FAILED"
      );
    }

    if (
      cleanText(
        outbox.pickup_id
      ) !==
        cleanText(
          row.pickup_id
        )
    ) {
      throw createServiceError(
        "El evento Email 2 existente pertenece a una credencial de retiro diferente",
        409,
        "EMAIL_OUTBOX_READY_PICKUP_IDENTITY_MISMATCH"
      );
    }

    return {
      event_created:
        created,

      event_already_exists:
        !created,

      outbox,

      document_access: {
        created:
          documentAccess.created,

        id:
          documentAccess.access.id,

        expires_at:
          documentAccess.access.expires_at,

        security:
          documentAccess.security,
      },
    };
  };
