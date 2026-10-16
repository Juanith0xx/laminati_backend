import pool from "../config/database.js";

import {

  relbaseRequest,

} from "./relbase.service.js";

import {

  previewTaxDocumentRelbaseEmissionPreflight,

} from "./relbaseDteReconciliation.service.js";

import {

  claimTaxDocumentForEmission,

  persistRelbaseDteResult,

  markTaxDocumentEmissionError,

} from "./relbaseDteSync.service.js";



/* =========================================*

*   ERROR CONTROLADO*

*========================================= */

const createServiceError = (

  message,

  status = 400,

  code = null,

  details = null

) => {

  const error =

    new Error(message);

  error.status =

    status;

  error.code =

    code;

  error.details =

    details;

  return error;

};



/* =========================================*

*   BOOLEAN DESDE ENV*

*========================================= */

const getEnvBoolean = (

  name,

  defaultValue = false

) => {

  const raw =

    process.env[name];

  if (

    raw === undefined ||

    raw === null ||

    String(raw).trim() === ""

  ) {

    return defaultValue;

  }

  const normalized =

    String(raw)

      .trim()

      .toLowerCase();

  if (

    [

      "true",

      "1",

      "yes",

      "si",

      "sí",

    ].includes(normalized)

  ) {

    return true;

  }

  if (

    [

      "false",

      "0",

      "no",

    ].includes(normalized)

  ) {

    return false;

  }

  return defaultValue;

};



/* =========================================*

*   MAX PÁGINAS RECONCILIACIÓN*

*========================================= */

const normalizeMaxPages = (

  value

) => {

  return Math.min(

    Math.max(

      Number(value) || 100,

      1

    ),

    500

  );

};



/* =========================================*

*   MENSAJE SEGURO DE ERROR*

*========================================= */

const getSafeErrorMessage = (

  error

) => {

  return String(

    error?.relbaseData

      ?.meta

      ?.message ||

    error?.relbaseData

      ?.message ||

    error?.message ||

    "Error desconocido durante la emisión Relbase"

  )

    .trim()

    .slice(

      0,

      1000

    );

};



/* =========================================*

*   EXTRAER DTE DEL ENVELOPE V2*

*   Relbase V2:*

*   {*

*     data: {...},*

*     meta: {...}*

*   }*

*========================================= */

const extractRelbaseDte = (

  response

) => {

  const envelope =

    response?.data;

  const candidate =

    envelope?.data;

  if (

    !candidate ||

    typeof candidate !== "object" ||

    Array.isArray(candidate)

  ) {

    throw createServiceError(

      "Relbase respondió correctamente al POST pero no devolvió un DTE válido dentro de data",

      502,

      "RELBASE_DTE_CREATE_RESPONSE_INVALID"

    );

  }

  return candidate;

};



/* =========================================*

*   GUARDAR REQUEST EXACTO*

*   Se ejecuta DESPUÉS del claim y*

*   ANTES del POST externo.*

*========================================= */

const persistRequestPayload = async ({

  taxDocumentId,

  payload,

}) => {

  const result =

    await pool.query(

      `

        UPDATE tax_documents

        SET

          request_payload = $2::jsonb,

          updated_at = NOW()

        WHERE

          id = $1

          AND status = 'PROCESSING'

          AND relbase_document_id

              IS NULL

        RETURNING

          id,

          order_id,

          status,

          idempotency_key,

          request_payload

      `,

      [

        taxDocumentId,

        JSON.stringify(

          payload

        ),

      ]

    );

  if (

    result.rowCount !==

    1

  ) {

    throw createServiceError(

      "No fue posible guardar el request de emisión antes de contactar Relbase",

      409,

      "RELBASE_DTE_REQUEST_SNAPSHOT_CONFLICT"

    );

  }

  return result.rows[0];

};



/* =========================================*

*   ESTADO INCIERTO*

*   IMPORTANTE:*

*   Si ya ejecutamos el POST y no sabemos*

*   con certeza si Relbase creó el documento,*

*   NO cambiamos PROCESSING -> ERROR.*

*   Esto evita que alguien vuelva a emitir*

*   automáticamente un posible DTE existente.*

*========================================= */

const markEmissionAsUncertain =

  async ({

    taxDocumentId,

    error,

  }) => {

    const message =

      getSafeErrorMessage(

        error

      );

    await pool.query(

      `

        UPDATE tax_documents

        SET

          error_message = $2,

          updated_at = NOW()

        WHERE

          id = $1

          AND status = 'PROCESSING'

          AND relbase_document_id

              IS NULL

      `,

      [

        taxDocumentId,

        `[RELBASE_EMISSION_UNCERTAIN] ${message}`,

      ]

    );

  };



/* =========================================*

*   ERROR DEFINITIVO SIN DTE*

*   Sólo consideramos definitivos ciertos*

*   errores HTTP de validación/autorización.*

*   409, 429, 5xx y errores de red se*

*   consideran inciertos de forma conservadora.*

*========================================= */

const isDefinitiveRelbaseRejection = (

  error

) => {

  const status =

    Number(

      error?.status

    );

  return [

    400,

    401,

    403,

    404,

    405,

    422,

  ].includes(

    status

  );

};



/* =========================================*

*   EMITIR DTE REAL RELBASE*

*   FLUJO:*

*   PREFLIGHT*

*      ↓*

*   KILL SWITCH*

*      ↓*

*   CLAIM*

*      ↓*

*   REQUEST SNAPSHOT*

*      ↓*

*   POST /api/v2/dtes*

*      ↓*

*   PERSIST RESULT*

*   IMPORTANTE:*

*   Por defecto la emisión está APAGADA.*

*========================================= */

export const emitRelbaseDte =

  async ({

    taxDocumentId,

    issuedBy = null,

    maxPages = 100,

  }) => {

    if (!taxDocumentId) {

      throw createServiceError(

        "Se requiere taxDocumentId",

        400,

        "TAX_DOCUMENT_ID_REQUIRED"

      );

    }

    /*
     * Métricas de rendimiento.
     * Sólo miden tiempos; no cambian ninguna
     * validación, claim, persistencia ni POST.
     */
    const totalStartedAt =
      Date.now();

    console.log(
      "\n[RELBASE DTE PERF] ===== INICIO =====",
      {
        tax_document_id:
          taxDocumentId,
        max_pages:
          maxPages,
        started_at:
          new Date().toISOString(),
      }
    );

    const normalizedMaxPages =

      normalizeMaxPages(

        maxPages

      );

    /* =====================================*

*       1. PREFLIGHT COMPLETO*

*    ===================================== */

    const preflightStartedAt =
      Date.now();

    const preflight =

      await previewTaxDocumentRelbaseEmissionPreflight({

        taxDocumentId,

        maxPages:

          normalizedMaxPages,

      });

    const preflightCompletedAt =
      Date.now();

    const timings = {
      preflight_ms:
        preflightCompletedAt -
        preflightStartedAt,

      reconciliation_pages_scanned:
        Number(
          preflight
            ?.reconciliation
            ?.pages_scanned ||
          0
        ),

      claim_ms:
        0,

      request_snapshot_ms:
        0,

      relbase_post_ms:
        0,

      persistence_ms:
        0,

      total_ms:
        0,
    };

    console.log(
      "[RELBASE DTE PERF] PREFLIGHT COMPLETADO",
      {
        tax_document_id:
          taxDocumentId,
        preflight_ms:
          timings.preflight_ms,
        reconciliation_pages_scanned:
          timings.reconciliation_pages_scanned,
        ready_for_emission:
          preflight?.ready_for_emission === true,
      }
    );

    if (

      preflight

        ?.ready_for_emission !==

      true

    ) {

      throw createServiceError(

        "El documento no superó el preflight de emisión Relbase",

        409,

        "RELBASE_DTE_PREFLIGHT_BLOCKED",

        {

          blocking_issues:

            preflight

              ?.blocking_issues ||

            [],

        }

      );

    }

    const payload =

      preflight

        ?.payload_preview

        ?.payload;

    if (

      !payload ||

      typeof payload !==

        "object" ||

      Array.isArray(payload)

    ) {

      throw createServiceError(

        "El preflight no entregó un payload Relbase válido",

        409,

        "RELBASE_DTE_PAYLOAD_MISSING"

      );

    }

    /* =====================================*

*       2. KILL SWITCH*

*       ESTE RETURN ES EL QUE NOS PROTEGE*

*       DURANTE LAS PRIMERAS PRUEBAS.*

*       NO CLAIM.*

*       NO POST.*

*       NO DB WRITE.*

*    ===================================== */

    const emissionEnabled =

      getEnvBoolean(

        "RELBASE_DTE_EMISSION_ENABLED",

        false

      );

    if (!emissionEnabled) {

      const dryRunTimings = {
        ...timings,
        total_ms:
          Date.now() -
          totalStartedAt,
      };

      console.log(
        "[RELBASE DTE PERF] ===== FIN DRY RUN =====",
        {
          tax_document_id:
            taxDocumentId,
          emission_enabled:
            false,
          ...dryRunTimings,
          finished_at:
            new Date().toISOString(),
        }
      );

      return {

        success: true,

        mode:

          "DRY_RUN",

        emission_enabled:

          false,

        ready_for_emission:

          true,

        claim_executed:

          false,

        database_write_executed:

          false,

        relbase_post_executed:

          false,

        emission_executed:

          false,

        timings:
          dryRunTimings,

        message:

          "El documento está listo para emisión real, pero RELBASE_DTE_EMISSION_ENABLED está deshabilitado.",

        next_action:

          "ENABLE_CONTROLLED_REAL_EMISSION",

        preflight,

      };

    }

    /* =====================================*

*       3. CLAIM ATÓMICO*

*       PENDING -> PROCESSING*

*    ===================================== */

    const claimStartedAt =
      Date.now();

    const claim =

      await claimTaxDocumentForEmission({

        taxDocumentId,

      });

    timings.claim_ms =
      Date.now() -
      claimStartedAt;

    console.log(
      "[RELBASE DTE PERF] CLAIM COMPLETADO",
      {
        tax_document_id:
          taxDocumentId,
        claim_ms:
          timings.claim_ms,
      }
    );

    let postStarted =

      false;

    let postSucceeded =

      false;

    try {

      /* ===================================*

*         4. SNAPSHOT REQUEST*

*      =================================== */

      const requestSnapshotStartedAt =
        Date.now();

      await persistRequestPayload({

        taxDocumentId,

        payload,

      });

      timings.request_snapshot_ms =
        Date.now() -
        requestSnapshotStartedAt;

      console.log(
        "[RELBASE DTE PERF] REQUEST SNAPSHOT COMPLETADO",
        {
          tax_document_id:
            taxDocumentId,
          request_snapshot_ms:
            timings.request_snapshot_ms,
        }
      );

      /* ===================================*

*         5. POST REAL RELBASE*

*         DESDE AQUÍ PUEDE EXISTIR*

*         UN DTE REAL.*

*      =================================== */

      postStarted =

        true;

      const relbasePostStartedAt =
        Date.now();

      const response =

        await relbaseRequest(

          "/api/v2/dtes",

          {

            method:

              "POST",

            headers: {

              "Content-Type":

                "application/json",

              /**

*               * Relbase documenta*

*               * X-Request-Id para*

*               * trazabilidad.*

*               **

*               * taxDocumentId ya es UUID.*

*               */

              "X-Request-Id":

                taxDocumentId,

            },

            body:

              JSON.stringify(

                payload

              ),

          }

        );

      timings.relbase_post_ms =
        Date.now() -
        relbasePostStartedAt;

      console.log(
        "[RELBASE DTE PERF] POST RELBASE COMPLETADO",
        {
          tax_document_id:
            taxDocumentId,
          relbase_post_ms:
            timings.relbase_post_ms,
          rate_limit:
            response?.rateLimit || null,
        }
      );

      postSucceeded =

        true;

      /* ===================================*

*         6. EXTRAER DTE*

*      =================================== */

      const relbaseDte =

        extractRelbaseDte(

          response

        );

      /* ===================================*

*         7. PERSISTIR RESULTADO*

*         Guarda:*

*         - relbase_document_id*

*         - folio*

*         - track_id*

*         - estados*

*         - issued_at*

*         - response_payload*

*         - pdf/xml si existen*

*      =================================== */

      const persistenceStartedAt =
        Date.now();

      const persisted =

        await persistRelbaseDteResult({

          taxDocumentId,

          relbaseDte,

          issuedBy,

        });

      timings.persistence_ms =
        Date.now() -
        persistenceStartedAt;

      timings.total_ms =
        Date.now() -
        totalStartedAt;

      console.log(
        "[RELBASE DTE PERF] ===== FIN EMISIÓN REAL =====",
        {
          tax_document_id:
            taxDocumentId,
          relbase_document_id:
            persisted?.relbase_document_id || null,
          folio:
            persisted?.folio || null,
          status:
            persisted?.status || null,
          ...timings,
          finished_at:
            new Date().toISOString(),
        }
      );

      return {

        success: true,

        mode:

          "REAL_EMISSION",

        emission_enabled:

          true,

        claim_executed:

          true,

        relbase_post_executed:

          true,

        emission_executed:

          true,

        timings,

        endpoint:

          "POST /api/v2/dtes",

        request_id:

          taxDocumentId,

        claim,

        relbase: {

          rate_limit:

            response

              ?.rateLimit ||

            null,

        },

        result:

          persisted,

      };

    } catch (error) {

      timings.total_ms =
        Date.now() -
        totalStartedAt;

      console.error(
        "[RELBASE DTE PERF] ===== ERROR =====",
        {
          tax_document_id:
            taxDocumentId,
          post_started:
            postStarted,
          post_succeeded:
            postSucceeded,
          ...timings,
          error_code:
            error?.code || null,
          error_status:
            error?.status || null,
          error_message:
            getSafeErrorMessage(error),
          finished_at:
            new Date().toISOString(),
        }
      );

      /**

*       * Si todavía NO alcanzamos el POST,*

*       * sabemos con certeza que Relbase*

*       * no pudo crear ningún DTE.*

*       */

      if (!postStarted) {

        try {

          await markTaxDocumentEmissionError({

            taxDocumentId,

            errorMessage:

              getSafeErrorMessage(

                error

              ),

            errorCode:

              error?.code ||

              "RELBASE_DTE_PRE_POST_ERROR",

          });

        } catch {

          // No ocultamos el error original.*

        }

        throw error;

      }

      /**

*       * El POST fue enviado, pero Relbase*

*       * respondió con un rechazo HTTP que*

*       * consideramos definitivo.*

*       */

      if (

        !postSucceeded &&

        isDefinitiveRelbaseRejection(

          error

        )

      ) {

        try {

          await markTaxDocumentEmissionError({

            taxDocumentId,

            errorMessage:

              getSafeErrorMessage(

                error

              ),

            errorCode:

              error?.code ||

              `RELBASE_HTTP_${error?.status || "ERROR"}`,

          });

        } catch {

          // No ocultamos el error original.*

        }

        throw error;

      }

      /**

*       * CASO CRÍTICO:*

*       **

*       * - timeout*

*       * - error de red*

*       * - 5xx*

*       * - 409*

*       * - 429*

*       * - POST exitoso pero falló*

*       *   la persistencia local*

*       **

*       * No sabemos con certeza si Relbase*

*       * ya creó el documento.*

*       **

*       * Dejamos PROCESSING y exigiremos*

*       * reconciliación antes de cualquier*

*       * nuevo intento.*

*       */

      try {

        await markEmissionAsUncertain({

          taxDocumentId,

          error,

        });

      } catch {

        // No ocultamos el error original.*

      }

      if (postSucceeded) {

        throw createServiceError(

          "Relbase respondió al POST, pero Laminatiword no pudo completar la persistencia local. No reintentar la emisión sin reconciliar primero.",

          502,

          "RELBASE_DTE_POST_SUCCEEDED_PERSISTENCE_UNCERTAIN",

          {

            original_message:

              getSafeErrorMessage(

                error

              ),

          }

        );

      }

      throw createServiceError(

        "El resultado de la emisión hacia Relbase es incierto. No reintentar hasta ejecutar reconciliación.",

        502,

        "RELBASE_DTE_EMISSION_UNCERTAIN",

        {

          original_status:

            error?.status ||

            null,

          original_message:

            getSafeErrorMessage(

              error

            ),

        }

      );

    }

  };