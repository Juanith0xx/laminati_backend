import cron from "node-cron";

import pool from "../config/database.js";

import {
  syncExistingRelbaseDteStatus,
} from "../controllers/relbase.controller.js";

import {
  runEmailOutboxCycle,
} from "./emailOutboxWorker.service.js";

const cleanText = (value) =>
  String(value ?? "").trim();

const isTrue = (value) =>
  ["1", "true", "yes", "on"].includes(
    cleanText(value).toLowerCase()
  );

const clampInteger = (
  value,
  fallback,
  min,
  max
) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(parsed, min),
    max
  );
};

const resolveCronExpression = () =>
  cleanText(
    process.env.RELBASE_DTE_STATUS_SYNC_CRON ||
      "*/30 * * * * *"
  );

const resolveBatchSize = () =>
  clampInteger(
    process.env.RELBASE_DTE_STATUS_SYNC_BATCH_SIZE,
    10,
    1,
    50
  );

const resolveMinRecheckSeconds = () =>
  clampInteger(
    process.env.RELBASE_DTE_STATUS_MIN_RECHECK_SECONDS,
    30,
    10,
    3600
  );

const shouldTriggerEmailImmediately = () =>
  isTrue(
    process.env
      .RELBASE_DTE_STATUS_TRIGGER_EMAIL ??
      "true"
  );

let running = false;
let task = null;

/* =========================================
   CAPTURA DE RESPUESTA DEL CONTROLADOR

   Reutiliza EXACTAMENTE el flujo existente de
   syncExistingRelbaseDteStatus:
   - GET exacto a Relbase por relbase_document_id.
   - Valida ID, tipo, folio y marcador.
   - Persiste mediante persistRelbaseDteResult.
   - Prepara DTE_ACCEPTED en email_outbox cuando
     corresponde.
   - NO ejecuta emisión.
   - NO ejecuta POST /api/v2/dtes.
========================================= */
const executeExistingDteSync = async (
  taxDocumentId
) => {
  let statusCode = 200;
  let responseBody = null;

  const req = {
    params: {
      taxDocumentId,
    },
    query: {},
    user: null,
  };

  const res = {
    status(code) {
      statusCode = Number(code) || 500;
      return this;
    },

    json(payload) {
      responseBody = payload;
      return payload;
    },
  };

  await syncExistingRelbaseDteStatus(
    req,
    res
  );

  return {
    status_code: statusCode,
    body: responseBody,
  };
};

/* =========================================
   DTE PENDIENTES DE CONFIRMACIÓN SII

   Sólo toma documentos locales ISSUED con un
   relbase_document_id ya conocido.

   Los DTE ACCEPTED / REJECTED dejan de ser
   candidatos automáticamente.
========================================= */
export const listPendingRelbaseDteStatusIds =
  async (
    limit = resolveBatchSize()
  ) => {
    const batchSize = clampInteger(
      limit,
      resolveBatchSize(),
      1,
      50
    );

    const minRecheckSeconds =
      resolveMinRecheckSeconds();

    const result = await pool.query(
      `
        SELECT
          td.id,
          td.order_id,
          o.order_number,
          td.relbase_document_id,
          td.folio,
          td.status,
          td.sii_status,
          td.sii_status_name,
          td.last_status_sync_at,
          td.issued_at
        FROM tax_documents td
        INNER JOIN orders o
          ON o.id = td.order_id
        WHERE
          UPPER(
            COALESCE(td.status, '')
          ) = 'ISSUED'
          AND td.relbase_document_id IS NOT NULL
          AND BTRIM(
            td.relbase_document_id::text
          ) ~ '^[0-9]+$'
          AND LOWER(
            COALESCE(td.sii_status, '')
          ) NOT IN (
            'accepted',
            'aceptado',
            'rejected',
            'rechazado'
          )
          AND (
            td.last_status_sync_at IS NULL
            OR td.last_status_sync_at <=
              NOW() -
              ($2::integer * INTERVAL '1 second')
          )
        ORDER BY
          td.last_status_sync_at ASC NULLS FIRST,
          td.issued_at ASC NULLS FIRST,
          td.id ASC
        LIMIT $1
      `,
      [
        batchSize,
        minRecheckSeconds,
      ]
    );

    return result.rows;
  };

/* =========================================
   CICLO AUTOMÁTICO DTE STATUS
========================================= */
export const runRelbaseDteStatusSyncCycle =
  async () => {
    if (running) {
      return {
        skipped: true,
        reason:
          "DTE_STATUS_CYCLE_ALREADY_RUNNING",
      };
    }

    running = true;

    try {
      const candidates =
        await listPendingRelbaseDteStatusIds();

      const results = [];
      let acceptedCount = 0;
      let emailPreparedCount = 0;

      for (const candidate of candidates) {
        try {
          const sync =
            await executeExistingDteSync(
              candidate.id
            );

          const data =
            sync.body?.data || null;

          const finalStatus =
            cleanText(
              data?.dte?.status
            ).toUpperCase();

          const siiStatus =
            cleanText(
              data?.dte?.sii_status
            ).toLowerCase();

          const accepted =
            finalStatus === "ACCEPTED" ||
            siiStatus === "accepted" ||
            siiStatus === "aceptado";

          const emailPrepared = Boolean(
            data?.email_1?.prepared
          );

          if (accepted) {
            acceptedCount += 1;
          }

          if (emailPrepared) {
            emailPreparedCount += 1;
          }

          results.push({
            tax_document_id:
              candidate.id,
            order_number:
              candidate.order_number,
            relbase_document_id:
              candidate.relbase_document_id,
            http_status:
              sync.status_code,
            success:
              Boolean(sync.body?.success),
            dte_status:
              data?.dte?.status || null,
            sii_status:
              data?.dte?.sii_status || null,
            email_1_prepared:
              emailPrepared,
            outbox_id:
              data?.email_1?.outbox_id ||
              null,
          });
        } catch (error) {
          results.push({
            tax_document_id:
              candidate.id,
            order_number:
              candidate.order_number,
            relbase_document_id:
              candidate.relbase_document_id,
            success: false,
            error: {
              message:
                error?.message ||
                "Error desconocido",
              code:
                error?.code || null,
            },
          });
        }
      }

      if (candidates.length > 0) {
        console.log(
          "Relbase DTE status ciclo completado:",
          {
            selected:
              candidates.length,
            accepted:
              acceptedCount,
            email_1_prepared:
              emailPreparedCount,
            errors:
              results.filter(
                (item) =>
                  item.success === false
              ).length,
          }
        );
      }

      /*
       * Si en este ciclo se preparó Email 1,
       * disparamos inmediatamente el worker de
       * email_outbox para evitar esperar hasta el
       * siguiente minuto. El propio worker tiene
       * protección anti-solapamiento e idempotencia.
       */
      if (
        emailPreparedCount > 0 &&
        shouldTriggerEmailImmediately() &&
        isTrue(
          process.env.EMAIL_OUTBOX_ENABLED
        )
      ) {
        await runEmailOutboxCycle();
      }

      return {
        skipped: false,
        selected:
          candidates.length,
        accepted:
          acceptedCount,
        email_1_prepared:
          emailPreparedCount,
        results,
      };
    } catch (error) {
      console.error(
        "Relbase DTE status worker no pudo ejecutar el ciclo:",
        {
          message:
            error?.message ||
            "Error desconocido",
          code:
            error?.code || null,
        }
      );

      return {
        skipped: false,
        selected: 0,
        error: {
          message:
            error?.message ||
            "Error desconocido",
          code:
            error?.code || null,
        },
      };
    } finally {
      running = false;
    }
  };

/* =========================================
   INICIAR WORKER
========================================= */
export const startRelbaseDteStatusWorker =
  () => {
    if (
      !isTrue(
        process.env
          .RELBASE_DTE_STATUS_SYNC_ENABLED
      )
    ) {
      return {
        enabled: false,
        started: false,
      };
    }

    const expression =
      resolveCronExpression();

    if (!cron.validate(expression)) {
      const error = new Error(
        `RELBASE_DTE_STATUS_SYNC_CRON no es válido: ${expression}`
      );
      error.code =
        "RELBASE_DTE_STATUS_SYNC_CRON_INVALID";
      throw error;
    }

    if (task) {
      return {
        enabled: true,
        started: false,
        already_started: true,
        cron: expression,
      };
    }

    task = cron.schedule(
      expression,
      () => {
        void runRelbaseDteStatusSyncCycle();
      }
    );

    console.log(
      "Relbase DTE status worker automático iniciado:",
      {
        cron: expression,
        batch_size:
          resolveBatchSize(),
        min_recheck_seconds:
          resolveMinRecheckSeconds(),
        trigger_email_immediately:
          shouldTriggerEmailImmediately(),
      }
    );

    if (
      isTrue(
        process.env
          .RELBASE_DTE_STATUS_SYNC_RUN_ON_START ??
          "true"
      )
    ) {
      void runRelbaseDteStatusSyncCycle();
    }

    return {
      enabled: true,
      started: true,
      cron: expression,
      batch_size:
        resolveBatchSize(),
    };
  };

export const stopRelbaseDteStatusWorker =
  () => {
    if (!task) {
      return false;
    }

    task.stop();
    task.destroy();
    task = null;

    return true;
  };
