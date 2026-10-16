import cron from "node-cron";

import pool from "../config/database.js";

import {
  prepareTaxDocument,
} from "./taxDocument.service.js";

import {
  emitRelbaseDte,
} from "./relbaseDteEmission.service.js";

import {
  emitTaxDocumentUpdated,
} from "./realtime.service.js";

const normalizeText = (value) =>
  String(value ?? "").trim();

const UNCERTAIN_CODES =
  new Set([
    "RELBASE_DTE_EMISSION_UNCERTAIN",
    "RELBASE_DTE_POST_SUCCEEDED_PERSISTENCE_UNCERTAIN",
  ]);


const isTrue = (value) =>
  [
    "1",
    "true",
    "yes",
    "on",
  ].includes(
    normalizeText(
      value
    ).toLowerCase()
  );

const resolveQueueCron = () =>
  normalizeText(
    process.env
      .TAX_DOCUMENT_EMISSION_QUEUE_CRON ||
      "*/5 * * * * *"
  );

let queueTask = null;
let queueCycleRunning = false;

const toSafeError = (error) => ({
  message:
    normalizeText(error?.message) ||
    "Error desconocido durante la emisión DTE",
  code:
    normalizeText(error?.code) ||
    null,
});

const getJobByOrderId = async (
  orderId
) => {
  const result =
    await pool.query(
      `
        SELECT
          id,
          order_id,
          tax_document_id,
          requested_by,
          status,
          attempts,
          next_attempt_at,
          processing_started_at,
          completed_at,
          last_error,
          last_error_code,
          created_at,
          updated_at
        FROM tax_document_emission_jobs
        WHERE order_id = $1
        LIMIT 1
      `,
      [orderId]
    );

  return result.rows[0] || null;
};

const emitJobEvent = (
  job,
  extra = {}
) => {
  if (!job) {
    return false;
  }

  return emitTaxDocumentUpdated({
    job_id:
      job.id,
    order_id:
      job.order_id,
    tax_document_id:
      job.tax_document_id,
    job_status:
      job.status,
    attempts:
      Number(job.attempts || 0),
    ...extra,
  });
};

export const enqueueTaxDocumentEmissionJob =
  async ({
    orderId,
    requestedBy = null,
  }) => {
    const normalizedOrderId =
      normalizeText(orderId);

    if (!normalizedOrderId) {
      const error =
        new Error(
          "Se requiere orderId para encolar la emisión DTE"
        );

      error.status = 400;
      error.code =
        "DTE_EMISSION_QUEUE_ORDER_REQUIRED";

      throw error;
    }

    const insert =
      await pool.query(
        `
          INSERT INTO tax_document_emission_jobs (
            order_id,
            requested_by,
            status,
            next_attempt_at
          )
          VALUES (
            $1,
            $2,
            'QUEUED',
            NOW()
          )
          ON CONFLICT (order_id)
          DO NOTHING
          RETURNING
            id,
            order_id,
            tax_document_id,
            requested_by,
            status,
            attempts,
            next_attempt_at,
            processing_started_at,
            completed_at,
            last_error,
            last_error_code,
            created_at,
            updated_at
        `,
        [
          normalizedOrderId,
          requestedBy || null,
        ]
      );

    const job =
      insert.rows[0] ||
      await getJobByOrderId(
        normalizedOrderId
      );

    emitJobEvent(
      job,
      {
        event_type:
          insert.rowCount > 0
            ? "QUEUED"
            : "ALREADY_QUEUED",
      }
    );

    return {
      created:
        insert.rowCount > 0,
      job,
    };
  };

const claimJobByOrderId =
  async (orderId) => {
    const result =
      await pool.query(
        `
          UPDATE tax_document_emission_jobs
          SET
            status = 'PROCESSING',
            attempts = attempts + 1,
            processing_started_at = NOW(),
            last_error = NULL,
            last_error_code = NULL,
            updated_at = NOW()
          WHERE order_id = $1
            AND status = 'QUEUED'
            AND next_attempt_at <= NOW()
          RETURNING
            id,
            order_id,
            tax_document_id,
            requested_by,
            status,
            attempts,
            next_attempt_at,
            processing_started_at,
            completed_at,
            last_error,
            last_error_code,
            created_at,
            updated_at
        `,
        [orderId]
      );

    return result.rows[0] || null;
  };

const updateJob =
  async ({
    id,
    status,
    taxDocumentId = undefined,
    completed = false,
    error = null,
  }) => {
    const safeError =
      error
        ? toSafeError(error)
        : {
            message: null,
            code: null,
          };

    const result =
      await pool.query(
        `
          UPDATE tax_document_emission_jobs
          SET
            status = $2,
            tax_document_id =
              CASE
                WHEN $3::uuid IS NULL
                  THEN tax_document_id
                ELSE $3::uuid
              END,
            completed_at =
              CASE
                WHEN $4::boolean
                  THEN NOW()
                ELSE completed_at
              END,
            last_error = $5,
            last_error_code = $6,
            updated_at = NOW()
          WHERE id = $1
          RETURNING
            id,
            order_id,
            tax_document_id,
            requested_by,
            status,
            attempts,
            next_attempt_at,
            processing_started_at,
            completed_at,
            last_error,
            last_error_code,
            created_at,
            updated_at
        `,
        [
          id,
          status,
          taxDocumentId || null,
          completed === true,
          safeError.message,
          safeError.code,
        ]
      );

    return result.rows[0] || null;
  };

const readTaxDocumentState =
  async (
    taxDocumentId
  ) => {
    const result =
      await pool.query(
        `
          SELECT
            id,
            order_id,
            document_type,
            status,
            folio,
            relbase_document_id,
            external_status,
            relbase_status,
            sii_status,
            sii_status_name,
            issued_at,
            error_message
          FROM tax_documents
          WHERE id = $1
          LIMIT 1
        `,
        [taxDocumentId]
      );

    return result.rows[0] || null;
  };

export const processTaxDocumentEmissionJobByOrderId =
  async ({
    orderId,
  }) => {
    const job =
      await claimJobByOrderId(
        orderId
      );

    if (!job) {
      return {
        processed: false,
        reason:
          "JOB_NOT_QUEUED",
        job:
          await getJobByOrderId(
            orderId
          ),
      };
    }

    emitJobEvent(
      job,
      {
        event_type:
          "PROCESSING",
      }
    );

    let taxDocumentId = null;

    try {
      const preparation =
        await prepareTaxDocument(
          job.order_id
        );

      taxDocumentId =
        preparation
          ?.tax_document
          ?.id ||
        null;

      if (!taxDocumentId) {
        const error =
          new Error(
            "La preparación tributaria no devolvió tax_document_id"
          );

        error.code =
          "DTE_PREPARATION_ID_MISSING";

        throw error;
      }

      const current =
        preparation
          ?.tax_document ||
        await readTaxDocumentState(
          taxDocumentId
        );

      const currentStatus =
        normalizeText(
          current?.status
        ).toUpperCase();

      if (
        ["ISSUED", "ACCEPTED"]
          .includes(
            currentStatus
          )
      ) {
        const completedJob =
          await updateJob({
            id:
              job.id,
            status:
              "COMPLETED",
            taxDocumentId,
            completed:
              true,
          });

        emitJobEvent(
          completedJob,
          {
            event_type:
              "COMPLETED",
            tax_document:
              current,
          }
        );

        return {
          processed: true,
          already_issued:
            true,
          job:
            completedJob,
          tax_document:
            current,
        };
      }

      if (
        currentStatus !== "PENDING"
      ) {
        const error =
          new Error(
            `El DTE quedó en estado ${currentStatus || "DESCONOCIDO"} y no puede emitirse automáticamente`
          );

        error.code =
          "DTE_AUTOMATIC_EMISSION_STATUS_BLOCKED";

        throw error;
      }

      const emission =
        await emitRelbaseDte({
          taxDocumentId,
          issuedBy:
            job.requested_by ||
            null,
          maxPages:
            100,
        });

      if (
        emission
          ?.emission_executed !==
        true
      ) {
        const blockedJob =
          await updateJob({
            id:
              job.id,
            status:
              "BLOCKED",
            taxDocumentId,
            error: {
              message:
                emission?.message ||
                "La emisión real DTE está deshabilitada",
              code:
                "DTE_REAL_EMISSION_DISABLED",
            },
          });

        emitJobEvent(
          blockedJob,
          {
            event_type:
              "BLOCKED",
          }
        );

        return {
          processed: true,
          emitted: false,
          job:
            blockedJob,
          emission,
        };
      }

      const taxDocument =
        emission
          ?.result
          ?.tax_document ||
        await readTaxDocumentState(
          taxDocumentId
        );

      const completedJob =
        await updateJob({
          id:
            job.id,
          status:
            "COMPLETED",
          taxDocumentId,
          completed:
            true,
        });

      emitJobEvent(
        completedJob,
        {
          event_type:
            "ISSUED",
          tax_document:
            taxDocument,
          timings:
            emission?.timings ||
            null,
        }
      );

      return {
        processed: true,
        emitted: true,
        job:
          completedJob,
        tax_document:
          taxDocument,
        timings:
          emission?.timings ||
          null,
      };
    } catch (error) {
      const safe =
        toSafeError(
          error
        );

      const requiresReconciliation =
        UNCERTAIN_CODES.has(
          safe.code
        );

      const failedJob =
        await updateJob({
          id:
            job.id,
          status:
            requiresReconciliation
              ? "REQUIRES_RECONCILIATION"
              : "FAILED",
          taxDocumentId:
            taxDocumentId ||
            undefined,
          error,
        });

      emitJobEvent(
        failedJob,
        {
          event_type:
            requiresReconciliation
              ? "REQUIRES_RECONCILIATION"
              : "FAILED",
          error:
            safe,
        }
      );

      console.error(
        "Emisión DTE asíncrona falló:",
        {
          order_id:
            job.order_id,
          tax_document_id:
            taxDocumentId,
          job_id:
            job.id,
          job_status:
            failedJob?.status ||
            null,
          ...safe,
        }
      );

      return {
        processed: true,
        emitted: false,
        job:
          failedJob,
        error:
          safe,
      };
    }
  };

export const processQueuedTaxDocumentEmissionJobs =
  async ({
    limit = 5,
  } = {}) => {
    const safeLimit =
      Math.min(
        Math.max(
          Number(limit) || 5,
          1
        ),
        20
      );

    const queued =
      await pool.query(
        `
          SELECT order_id
          FROM tax_document_emission_jobs
          WHERE status = 'QUEUED'
            AND next_attempt_at <= NOW()
          ORDER BY
            created_at ASC,
            id ASC
          LIMIT $1
        `,
        [safeLimit]
      );

    const results = [];

    for (
      const row of
      queued.rows
    ) {
      results.push(
        await processTaxDocumentEmissionJobByOrderId({
          orderId:
            row.order_id,
        })
      );
    }

    return {
      selected:
        queued.rowCount,
      completed:
        results.filter(
          (item) =>
            item?.job?.status ===
            "COMPLETED"
        ).length,
      failed:
        results.filter(
          (item) =>
            ["FAILED", "BLOCKED", "REQUIRES_RECONCILIATION"]
              .includes(
                item?.job?.status
              )
        ).length,
      results,
    };
  };

export const runTaxDocumentEmissionQueueCycle =
  async () => {
    if (
      queueCycleRunning
    ) {
      return {
        skipped: true,
        reason:
          "DTE_EMISSION_QUEUE_CYCLE_ALREADY_RUNNING",
      };
    }

    queueCycleRunning =
      true;

    try {
      return await processQueuedTaxDocumentEmissionJobs({
        limit:
          Number(
            process.env
              .TAX_DOCUMENT_EMISSION_QUEUE_BATCH_SIZE
          ) || 5,
      });
    } finally {
      queueCycleRunning =
        false;
    }
  };

export const startTaxDocumentEmissionQueueWorker =
  () => {
    const enabled =
      process.env
        .TAX_DOCUMENT_EMISSION_QUEUE_ENABLED ===
        undefined
        ? true
        : isTrue(
            process.env
              .TAX_DOCUMENT_EMISSION_QUEUE_ENABLED
          );

    if (!enabled) {
      return {
        enabled: false,
        started: false,
      };
    }

    if (queueTask) {
      return {
        enabled: true,
        started: false,
        already_started: true,
        cron:
          resolveQueueCron(),
      };
    }

    const expression =
      resolveQueueCron();

    if (
      !cron.validate(
        expression
      )
    ) {
      const error =
        new Error(
          `TAX_DOCUMENT_EMISSION_QUEUE_CRON no es válido: ${expression}`
        );

      error.code =
        "DTE_EMISSION_QUEUE_CRON_INVALID";

      throw error;
    }

    queueTask =
      cron.schedule(
        expression,
        () => {
          void runTaxDocumentEmissionQueueCycle()
            .catch(
              (
                error
              ) => {
                console.error(
                  "Worker de emisión DTE no pudo ejecutar el ciclo:",
                  {
                    message:
                      error?.message ||
                      "Error desconocido",
                    code:
                      error?.code ||
                      null,
                  }
                );
              }
            );
        }
      );

    console.log(
      "Worker de emisión DTE automática iniciado:",
      {
        cron:
          expression,
      }
    );

    if (
      process.env
        .TAX_DOCUMENT_EMISSION_QUEUE_RUN_ON_START ===
        undefined ||
      isTrue(
        process.env
          .TAX_DOCUMENT_EMISSION_QUEUE_RUN_ON_START
      )
    ) {
      void runTaxDocumentEmissionQueueCycle()
        .catch(
          (
            error
          ) => {
            console.error(
              "No fue posible ejecutar la cola DTE al iniciar:",
              {
                message:
                  error?.message ||
                  "Error desconocido",
                code:
                  error?.code ||
                  null,
              }
            );
          }
        );
    }

    return {
      enabled: true,
      started: true,
      cron:
        expression,
    };
  };

export const stopTaxDocumentEmissionQueueWorker =
  () => {
    if (!queueTask) {
      return false;
    }

    queueTask.stop();
    queueTask.destroy();
    queueTask = null;

    return true;
  };

