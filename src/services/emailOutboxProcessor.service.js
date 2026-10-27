import crypto from "crypto";

import pool from "../config/database.js";

import {
  buildCustomerDocumentAccessCredential,
} from "./customerDocumentAccess.service.js";

import {
  buildPickupQrToken,
  hashPickupQrToken,
} from "./pickup.service.js";

import {
  sendTransactionalEmail,
} from "./emailTransport.service.js";

import {
  buildDteAcceptedEmail,
  buildProjectQuotationItalyEmail,
  buildReadyForPickupEmail,
} from "./emailTemplates.service.js";

const PROJECT_QUOTATION_ITALY_EVENT =
  "PROJECT_QUOTATION_CREATED_ITALY";

const SUPPORTED_EVENTS = new Set([
  "DTE_ACCEPTED",
  "ORDER_READY_FOR_PICKUP",
  PROJECT_QUOTATION_ITALY_EVENT,
]);

const cleanText = (value) => String(value ?? "").trim();

const isTrue = (value) =>
  ["1", "true", "yes", "on"].includes(cleanText(value).toLowerCase());

const hashCredential = (credential) =>
  crypto
    .createHash("sha256")
    .update(String(credential ?? ""), "utf8")
    .digest("hex");

const safeHashMatches = (expected, candidate) => {
  const a = cleanText(expected).toLowerCase();
  const b = cleanText(candidate).toLowerCase();

  if (a.length !== 64 || b.length !== 64) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
};

const sanitizeError = (error) =>
  String(error?.message || "Error desconocido")
    .replace(/Bearer\s+[-A-Za-z0-9._~+/=]+/gi, "Bearer [REDACTED]")
    .slice(0, 2000);

const getRetryDate = (attempts) => {
  const safeAttempts = Math.max(1, Number(attempts) || 1);
  const seconds = Math.min(3600, 60 * 2 ** Math.min(safeAttempts - 1, 6));
  return new Date(Date.now() + seconds * 1000);
};

const resolveDestination = (recipientEmail) => {
  const testMode = isTrue(process.env.EMAIL_OUTBOX_TEST_MODE);
  const testTo = cleanText(process.env.EMAIL_OUTBOX_TEST_TO).toLowerCase();

  if (
    testMode &&
    String(process.env.NODE_ENV || "").trim().toLowerCase() === "production"
  ) {
    const error = new Error(
      "EMAIL_OUTBOX_TEST_MODE no puede estar habilitado en producción"
    );
    error.code = "EMAIL_OUTBOX_TEST_MODE_PRODUCTION_BLOCKED";
    throw error;
  }

  if (testMode && !testTo) {
    const error = new Error(
      "EMAIL_OUTBOX_TEST_MODE=true requiere EMAIL_OUTBOX_TEST_TO"
    );
    error.code = "EMAIL_OUTBOX_TEST_TO_REQUIRED";
    throw error;
  }

  return {
    destination: testMode ? testTo : cleanText(recipientEmail).toLowerCase(),
    testMode,
  };
};

const loadProjectQuotationItalyEvent =
  async (
    outboxId
  ) => {
    const result =
      await pool.query(
        `
          SELECT
            eo.id,
            eo.quotation_id,
            eo.event_type,
            eo.recipient_email,
            eo.status,
            eo.attempts,
            eo.max_attempts,
            eo.payload,

            q.quote_number,
            q.quotation_type,
            q.project_name,
            q.status AS quotation_status,
            q.visible_to_italy,
            q.created_at,
            q.valid_until

          FROM email_outbox eo

          INNER JOIN quotations q
            ON q.id =
              eo.quotation_id

          WHERE eo.id = $1
            AND eo.event_type =
              $2

          LIMIT 1
        `,
        [
          outboxId,
          PROJECT_QUOTATION_ITALY_EVENT,
        ]
      );

    if (
      result.rowCount ===
      0
    ) {
      const error =
        new Error(
          "No fue posible cargar el evento de cotización PROJECT para Gerencia Italia"
        );

      error.code =
        "EMAIL_OUTBOX_PROJECT_QUOTATION_EVENT_LOAD_FAILED";

      throw error;
    }

    return result.rows[0];
  };

const validateProjectQuotationItalyEvent =
  (
    row
  ) => {
    if (
      cleanText(
        row.event_type
      ) !==
      PROJECT_QUOTATION_ITALY_EVENT
    ) {
      const error =
        new Error(
          "El evento no corresponde a una cotización PROJECT para Gerencia Italia"
        );

      error.code =
        "EMAIL_OUTBOX_PROJECT_QUOTATION_EVENT_INVALID";

      throw error;
    }

    if (
      cleanText(
        row.quotation_type
      ).toUpperCase() !==
      "PROJECT"
    ) {
      const error =
        new Error(
          "La cotización asociada no es PROJECT"
        );

      error.code =
        "EMAIL_OUTBOX_PROJECT_QUOTATION_TYPE_INVALID";

      throw error;
    }

    if (
      row
        .visible_to_italy !==
      true
    ) {
      const error =
        new Error(
          "La cotización ya no se encuentra visible para Gerencia Italia"
        );

      error.code =
        "EMAIL_OUTBOX_PROJECT_QUOTATION_NOT_VISIBLE";

      throw error;
    }

    const payload =
      row.payload &&
      typeof row.payload ===
        "object"
        ? row.payload
        : {};

    if (
      cleanText(
        payload.schema
      ) !==
      "LAMINATIWORD_PROJECT_QUOTATION_ITALY_V1"
    ) {
      const error =
        new Error(
          "El payload de la cotización PROJECT no posee el schema esperado"
        );

      error.code =
        "EMAIL_OUTBOX_PROJECT_QUOTATION_PAYLOAD_SCHEMA_INVALID";

      throw error;
    }

    if (
      cleanText(
        payload
          .quotation_id
      ) !==
      cleanText(
        row
          .quotation_id
      )
    ) {
      const error =
        new Error(
          "quotation_id del payload no coincide"
        );

      error.code =
        "EMAIL_OUTBOX_PROJECT_QUOTATION_ID_MISMATCH";

      throw error;
    }

    if (
      cleanText(
        payload
          .quote_number
      ) !==
      cleanText(
        row
          .quote_number
      )
    ) {
      const error =
        new Error(
          "El número de cotización del payload no coincide"
        );

      error.code =
        "EMAIL_OUTBOX_PROJECT_QUOTATION_NUMBER_MISMATCH";

      throw error;
    }

    return {
      payload,
    };
  };

const loadCommonEvent = async (outboxId) => {
  const result = await pool.query(
    `
      SELECT
        eo.id,
        eo.order_id,
        eo.tax_document_id,
        eo.pickup_id,
        eo.event_type,
        eo.recipient_email,
        eo.status,
        eo.attempts,
        eo.max_attempts,
        eo.payload,

        o.order_number,
        o.customer_name,
        o.email AS order_email,
        o.payment_status AS order_payment_status,
        o.status AS order_status,
        o.fulfillment_status,
        o.total AS order_total,
        o.currency,

        td.document_type,
        td.status AS tax_document_status,
        td.sii_status,
        td.sii_status_name,
        td.folio,

        p.status AS payment_status,

        cdat.id AS access_id,
        cdat.order_id AS access_order_id,
        cdat.tax_document_id AS access_tax_document_id,
        cdat.token_hash AS document_token_hash,
        cdat.expires_at AS document_expires_at,
        cdat.revoked_at AS document_revoked_at,
        cdat.created_at AS access_created_at,

        sp.status AS pickup_status,
        sp.token_hash AS pickup_token_hash,
        sp.generated_at AS pickup_generated_at,
        sp.expires_at AS pickup_expires_at,
        sp.used_at AS pickup_used_at,
        sp.revoked_at AS pickup_revoked_at

      FROM email_outbox eo

      INNER JOIN orders o
        ON o.id = eo.order_id

      INNER JOIN tax_documents td
        ON td.id = eo.tax_document_id

      INNER JOIN payments p
        ON p.order_id = o.id
       AND p.status = 'PAID'

      INNER JOIN customer_document_access_tokens cdat
        ON cdat.id = NULLIF(eo.payload->>'document_access_id', '')::uuid
       AND cdat.order_id = eo.order_id
       AND cdat.tax_document_id = eo.tax_document_id

      LEFT JOIN store_pickups sp
        ON sp.id = eo.pickup_id
       AND sp.order_id = eo.order_id

      WHERE eo.id = $1
      LIMIT 1
    `,
    [outboxId]
  );

  if (result.rowCount === 0) {
    const error = new Error("No fue posible cargar el evento de email_outbox");
    error.code = "EMAIL_OUTBOX_EVENT_LOAD_FAILED";
    throw error;
  }

  return result.rows[0];
};

const validateCommonEvent = (row) => {
  const eventType = cleanText(row.event_type);

  if (!SUPPORTED_EVENTS.has(eventType)) {
    const error = new Error(`Evento no soportado: ${eventType || "vacío"}`);
    error.code = "EMAIL_OUTBOX_EVENT_UNSUPPORTED";
    throw error;
  }

  if (cleanText(row.order_payment_status).toUpperCase() !== "PAID") {
    const error = new Error("La orden no se encuentra PAID");
    error.code = "EMAIL_OUTBOX_ORDER_NOT_PAID";
    throw error;
  }

  if (cleanText(row.payment_status).toUpperCase() !== "PAID") {
    const error = new Error("El pago asociado no se encuentra PAID");
    error.code = "EMAIL_OUTBOX_PAYMENT_NOT_PAID";
    throw error;
  }

  if (cleanText(row.order_status).toUpperCase() === "CANCELLED") {
    const error = new Error("La orden se encuentra cancelada");
    error.code = "EMAIL_OUTBOX_ORDER_CANCELLED";
    throw error;
  }

  if (cleanText(row.tax_document_status).toUpperCase() !== "ACCEPTED") {
    const error = new Error("El DTE no se encuentra ACCEPTED");
    error.code = "EMAIL_OUTBOX_DTE_NOT_ACCEPTED";
    throw error;
  }

  if (
    !["accepted", "aceptado"].includes(
      cleanText(row.sii_status).toLowerCase()
    )
  ) {
    const error = new Error("El DTE no se encuentra aceptado por el SII");
    error.code = "EMAIL_OUTBOX_SII_NOT_ACCEPTED";
    throw error;
  }

  if (row.document_revoked_at) {
    const error = new Error("El acceso documental está revocado");
    error.code = "EMAIL_OUTBOX_DOCUMENT_ACCESS_REVOKED";
    throw error;
  }

  const documentExpiresAt = new Date(row.document_expires_at);
  if (
    Number.isNaN(documentExpiresAt.getTime()) ||
    documentExpiresAt.getTime() <= Date.now()
  ) {
    const error = new Error("El acceso documental está expirado");
    error.code = "EMAIL_OUTBOX_DOCUMENT_ACCESS_EXPIRED";
    throw error;
  }

  const payload =
    row.payload && typeof row.payload === "object" ? row.payload : {};

  if (cleanText(payload.schema) !== "LAMINATIWORD_EMAIL_EVENT_V1") {
    const error = new Error("El payload del evento no posee el schema esperado");
    error.code = "EMAIL_OUTBOX_PAYLOAD_SCHEMA_INVALID";
    throw error;
  }

  if (cleanText(payload.order_number) !== cleanText(row.order_number)) {
    const error = new Error("El número de pedido del payload no coincide");
    error.code = "EMAIL_OUTBOX_ORDER_NUMBER_MISMATCH";
    throw error;
  }

  if (cleanText(payload.document_type) !== cleanText(row.document_type)) {
    const error = new Error("El tipo de documento del payload no coincide");
    error.code = "EMAIL_OUTBOX_DOCUMENT_TYPE_MISMATCH";
    throw error;
  }

  if (cleanText(payload.folio) !== cleanText(row.folio)) {
    const error = new Error("El folio del payload no coincide");
    error.code = "EMAIL_OUTBOX_FOLIO_MISMATCH";
    throw error;
  }

  if (cleanText(payload.document_access_id) !== cleanText(row.access_id)) {
    const error = new Error("El acceso documental del payload no coincide");
    error.code = "EMAIL_OUTBOX_DOCUMENT_ACCESS_MISMATCH";
    throw error;
  }

  const payloadTotal = Number(payload.total);
  const orderTotal = Number(row.order_total);

  if (
    Number.isFinite(payloadTotal) &&
    Number.isFinite(orderTotal) &&
    Math.abs(payloadTotal - orderTotal) > 0.01
  ) {
    const error = new Error("El total del payload no coincide con el pedido");
    error.code = "EMAIL_OUTBOX_TOTAL_MISMATCH";
    throw error;
  }

  const documentCredential = buildCustomerDocumentAccessCredential({
    id: row.access_id,
    created_at: row.access_created_at,
  });

  if (
    !safeHashMatches(
      row.document_token_hash,
      hashCredential(documentCredential)
    )
  ) {
    const error = new Error(
      "La credencial documental reconstruida no coincide con el hash almacenado"
    );
    error.code = "EMAIL_OUTBOX_DOCUMENT_TOKEN_HASH_MISMATCH";
    throw error;
  }

  return {
    payload,
    documentCredential,
  };
};

const validateReadyForPickup = (row, payload) => {
  if (cleanText(row.fulfillment_status).toUpperCase() !== "READY_FOR_PICKUP") {
    const error = new Error("La orden no se encuentra READY_FOR_PICKUP");
    error.code = "EMAIL_OUTBOX_ORDER_NOT_READY";
    throw error;
  }

  if (!row.pickup_id || !row.pickup_status) {
    const error = new Error("El evento no posee un retiro válido asociado");
    error.code = "EMAIL_OUTBOX_PICKUP_MISSING";
    throw error;
  }

  if (cleanText(row.pickup_status).toUpperCase() !== "ACTIVE") {
    const error = new Error("El retiro no se encuentra ACTIVE");
    error.code = "EMAIL_OUTBOX_PICKUP_NOT_ACTIVE";
    throw error;
  }

  if (row.pickup_used_at) {
    const error = new Error("El retiro ya fue utilizado");
    error.code = "EMAIL_OUTBOX_PICKUP_ALREADY_USED";
    throw error;
  }

  if (row.pickup_revoked_at) {
    const error = new Error("El retiro fue revocado");
    error.code = "EMAIL_OUTBOX_PICKUP_REVOKED";
    throw error;
  }

  const pickupExpiresAt = new Date(row.pickup_expires_at);
  if (
    Number.isNaN(pickupExpiresAt.getTime()) ||
    pickupExpiresAt.getTime() <= Date.now()
  ) {
    const error = new Error("El QR de retiro está expirado");
    error.code = "EMAIL_OUTBOX_PICKUP_EXPIRED";
    throw error;
  }

  if (cleanText(payload.pickup_id) !== cleanText(row.pickup_id)) {
    const error = new Error("El pickup del payload no coincide");
    error.code = "EMAIL_OUTBOX_PICKUP_ID_MISMATCH";
    throw error;
  }

  const pickupCredential = buildPickupQrToken(
    row.pickup_id,
    row.pickup_generated_at
  );

  if (
    !safeHashMatches(
      row.pickup_token_hash,
      hashPickupQrToken(pickupCredential)
    )
  ) {
    const error = new Error(
      "La credencial QR reconstruida no coincide con el hash almacenado"
    );
    error.code = "EMAIL_OUTBOX_PICKUP_TOKEN_HASH_MISMATCH";
    throw error;
  }

  return pickupCredential;
};

const claimEvent = async (outboxId) => {
  const result = await pool.query(
    `
      UPDATE email_outbox
      SET
        status = 'PROCESSING',
        attempts = attempts + 1,
        processing_at = NOW(),
        last_error = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND event_type IN ('DTE_ACCEPTED', 'ORDER_READY_FOR_PICKUP', 'PROJECT_QUOTATION_CREATED_ITALY')
        AND status IN ('PENDING', 'FAILED')
        AND scheduled_at <= NOW()
        AND attempts < max_attempts
      RETURNING
        id,
        event_type,
        status,
        attempts,
        max_attempts
    `,
    [outboxId]
  );

  return result.rows[0] || null;
};

const markPreSendFailure = async (outboxId, attempts, error) => {
  const safeError = sanitizeError(error);
  const retryAt = getRetryDate(attempts);

  await pool.query(
    `
      UPDATE email_outbox
      SET
        status = 'FAILED',
        processing_at = NULL,
        scheduled_at = $2,
        last_error = $3,
        updated_at = NOW()
      WHERE id = $1
        AND status = 'PROCESSING'
    `,
    [outboxId, retryAt, `PRE_SEND_FAILED: ${safeError}`]
  );
};

const quarantineAmbiguousSend = async (outboxId, prefix, error) => {
  const safeError = sanitizeError(error);

  await pool.query(
    `
      UPDATE email_outbox
      SET
        last_error = $2,
        updated_at = NOW()
      WHERE id = $1
        AND status = 'PROCESSING'
    `,
    [outboxId, `${prefix}: ${safeError}`]
  );
};

export const listRunnableEmailOutboxIds = async (limit = 5) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 25);

  const result = await pool.query(
    `
      SELECT id
      FROM email_outbox
      WHERE event_type IN ('DTE_ACCEPTED', 'ORDER_READY_FOR_PICKUP', 'PROJECT_QUOTATION_CREATED_ITALY')
        AND status IN ('PENDING', 'FAILED')
        AND scheduled_at <= NOW()
        AND attempts < max_attempts
      ORDER BY scheduled_at ASC, created_at ASC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows.map((row) => row.id);
};

export const processEmailOutboxEvent = async (outboxId) => {
  const normalizedId = cleanText(outboxId);
  const claim = await claimEvent(normalizedId);

  if (!claim) {
    const currentResult = await pool.query(
      `
        SELECT
          id,
          event_type,
          status,
          attempts,
          max_attempts,
          processing_at,
          sent_at,
          last_error
        FROM email_outbox
        WHERE id = $1
        LIMIT 1
      `,
      [normalizedId]
    );

    return {
      processed: false,
      reason: "NOT_CLAIMED",
      current: currentResult.rows[0] || null,
    };
  }

  let smtpStarted = false;
  let smtpAccepted = false;
  let smtpDefinitivelyRejected = false;

  try {
    let row;
    let email;
    let testMode;

    if (
      claim.event_type ===
      PROJECT_QUOTATION_ITALY_EVENT
    ) {
      row =
        await loadProjectQuotationItalyEvent(
          normalizedId
        );

      validateProjectQuotationItalyEvent(
        row
      );

      const destinationResult =
        resolveDestination(
          row
            .recipient_email
        );

      testMode =
        destinationResult
          .testMode;

      email =
        buildProjectQuotationItalyEmail({
          row,
          to:
            destinationResult
              .destination,
        });
    } else {
      row =
        await loadCommonEvent(
          normalizedId
        );

      const {
        payload,
        documentCredential,
      } =
        validateCommonEvent(
          row
        );

      const destinationResult =
        resolveDestination(
          row
            .recipient_email
        );

      testMode =
        destinationResult
          .testMode;

      if (
        row.event_type ===
        "DTE_ACCEPTED"
      ) {
        email =
          await buildDteAcceptedEmail({
            row,
            documentCredential,
            to:
              destinationResult
                .destination,
          });
      } else {
        const pickupCredential =
          validateReadyForPickup(
            row,
            payload
          );

        email =
          await buildReadyForPickupEmail({
            row,
            documentCredential,
            pickupCredential,
            to:
              destinationResult
                .destination,
          });
      }
    }

    smtpStarted = true;
    const info = await sendTransactionalEmail(email);

    const accepted = Array.isArray(info.accepted)
      ? info.accepted.map((value) => cleanText(value).toLowerCase())
      : [];

    if (accepted.length === 0) {
      smtpDefinitivelyRejected = true;
      const error = new Error("Zoho no confirmó ningún destinatario aceptado");
      error.code = "EMAIL_SMTP_RECIPIENT_NOT_ACCEPTED";
      throw error;
    }

    smtpAccepted = true;

    const sentResult = await pool.query(
      `
        UPDATE email_outbox
        SET
          status = 'SENT',
          sent_at = NOW(),
          processing_at = NULL,
          provider_message_id = $2,
          last_error = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'PROCESSING'
        RETURNING
          id,
          event_type,
          recipient_email,
          status,
          attempts,
          sent_at,
          provider_message_id
      `,
      [normalizedId, info.message_id]
    );

    if (sentResult.rowCount !== 1) {
      const error = new Error(
        "Zoho aceptó el correo, pero no fue posible confirmar SENT en email_outbox"
      );
      error.code = "EMAIL_OUTBOX_SENT_PERSIST_FAILED";
      throw error;
    }

    return {
      processed: true,
      sent: true,
      test_mode: testMode,
      result: sentResult.rows[0],
    };
  } catch (error) {
    if (smtpAccepted) {
      await quarantineAmbiguousSend(
        normalizedId,
        "SMTP_ACCEPTED_DB_CONFIRMATION_FAILED",
        error
      );
    } else if (smtpStarted && !smtpDefinitivelyRejected) {
      await quarantineAmbiguousSend(
        normalizedId,
        "SMTP_RESULT_AMBIGUOUS_NO_AUTO_RETRY",
        error
      );
    } else {
      await markPreSendFailure(normalizedId, claim.attempts, error);
    }

    return {
      processed: true,
      sent: false,
      quarantined:
        smtpAccepted || (smtpStarted && !smtpDefinitivelyRejected),
      error: {
        message: sanitizeError(error),
        code: error?.code || null,
      },
    };
  }
};
