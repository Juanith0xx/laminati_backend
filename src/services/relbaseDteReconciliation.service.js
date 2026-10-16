import pool from "../config/database.js";

import {

  relbaseRequest,

} from "./relbase.service.js";

import {

  buildRelbaseDtePreview,

} from "./relbaseDteAdapter.service.js";

const TRUSTED_FIRST_ATTEMPT_FLOW_VERSION =
  2;

/**
 * Relbase redondea los montos tributarios CLP a pesos enteros.
 * Permitimos hasta $2 CLP de diferencia al identificar el mismo
 * DTE durante una reconciliación.
 *
 * Importante:
 * - Esta tolerancia sólo aplica al match Laminatiword ↔ Relbase.
 * - No modifica montos de la orden, pago ni tax_document.
 */
const RELBASE_DTE_RECONCILIATION_TOTAL_TOLERANCE_CLP =
  2;



/* =========================================*

*   ERROR CONTROLADO*

*========================================= */

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



/* =========================================*

*   STRING OPCIONAL*

*========================================= */

const toOptionalString = (

  value

) => {

  if (

    value === undefined ||

    value === null

  ) {

    return null;

  }

  const normalized =

    String(value).trim();

  return normalized || null;

};



/* =========================================*

*   NÚMERO / MONEDA*

*========================================= */

const roundMoney = (

  value

) => {

  if (

    value === undefined ||

    value === null ||

    value === ""

  ) {

    return null;

  }

  const number =

    Number(value);

  if (!Number.isFinite(number)) {

    return null;

  }

  return (

    Math.round(

      (

        number +

        Number.EPSILON

      ) * 100

    ) / 100

  );

};



/* =========================================*

*   TOTAL RELBASE*

*========================================= */

const resolveRelbaseTotal = (

  record

) => {

  const realTotal =

    roundMoney(

      record?.real_amount_total

    );

  if (realTotal !== null) {

    return realTotal;

  }

  return roundMoney(

    record?.amount_total

  );

};



/* =========================================*

*   CANDIDATO SANITIZADO*

*   No devolvemos receptor, dirección ni*

*   información personal.*

*========================================= */

const buildCandidatePreview = (

  record

) => {

  return {

    relbase_document_id:

      toOptionalString(

        record?.id

      ),

    folio:

      toOptionalString(

        record?.folio

      ),

    track_id:

      toOptionalString(

        record?.track_id

      ),

    type_document:

      Number.isFinite(

        Number(

          record?.type_document

        )

      )

        ? Number(

            record.type_document

          )

        : null,

    relbase_status:

      toOptionalString(

        record?.status

      ),

    sii_status:

      toOptionalString(

        record?.sii_status

      ),

    sii_status_name:

      toOptionalString(

        record?.sii_status_name

      ),

    total:

      resolveRelbaseTotal(

        record

      ),

    comment:

      toOptionalString(

        record?.comment

      ),

    label_value:

      toOptionalString(

        record?.label_value

      ),

    created_at:

      toOptionalString(

        record?.created_at

      ),

    updated_at:

      toOptionalString(

        record?.updated_at

      ),

  };

};



/* =========================================*

*   ESTADO SII NORMALIZADO*

*========================================= */

const normalizeSiiStatus = (

  value

) => {

  return String(

    value || ""

  )

    .trim()

    .toLowerCase();

};



const isSiiAccepted = (

  value

) => {

  return [

    "accepted",

    "aceptado",

  ].includes(

    normalizeSiiStatus(

      value

    )

  );

};



const isSiiRejected = (

  value

) => {

  return [

    "rejected",

    "rechazado",

  ].includes(

    normalizeSiiStatus(

      value

    )

  );

};



/* =========================================*

*   HIJO DTE SANITIZADO*

*========================================= */

const buildDteChildPreview = (

  child

) => {

  return {

    relbase_document_id:

      toOptionalString(

        child?.id

      ),

    folio:

      toOptionalString(

        child?.folio

      ),

    type_document:

      Number.isFinite(

        Number(

          child?.type_document

        )

      )

        ? Number(

            child.type_document

          )

        : null,

    type_document_name:

      toOptionalString(

        child?.type_document_name

      ),

  };

};



/* =========================================*

*   NOTA DE CRÉDITO SANITIZADA*

*========================================= */

const buildCreditNotePreview = (

  record,

  detail = null

) => {

  const children =

    Array.isArray(

      detail?.dte_children

    )

      ? detail.dte_children

          .map(

            buildDteChildPreview

          )

          .filter(

            (

              child

            ) =>

              Boolean(

                child.relbase_document_id

              )

          )

      : [];

  return {

    ...buildCandidatePreview(

      detail || record

    ),

    type_document_name:

      toOptionalString(

        (

          detail || record

        )?.type_document_name

      ),

    dte_children:

      children,

  };

};



/* =========================================*

*   DETALLE DTE RELBASE - SOLO GET*

*========================================= */

const getRelbaseDteDetail =

  async (

    relbaseDocumentId

  ) => {

    const normalizedId =

      toOptionalString(

        relbaseDocumentId

      );

    if (!normalizedId) {

      throw createServiceError(

        "Se requiere relbaseDocumentId para consultar el detalle DTE",

        400,

        "RELBASE_DTE_ID_REQUIRED"

      );

    }

    const endpoint =

      `/api/v2/dtes/${encodeURIComponent(

        normalizedId

      )}`;

    const result =

      await relbaseRequest(

        endpoint,

        {

          method:

            "GET",

        }

      );

    const payload =

      result?.data ||

      null;

    const detail =

      payload?.data;

    if (

      !detail ||

      typeof detail !==

        "object" ||

      Array.isArray(

        detail

      )

    ) {

      throw createServiceError(

        "Relbase respondió con un detalle DTE v2 no reconocido",

        502,

        "RELBASE_DTE_DETAIL_INVALID"

      );

    }

    return detail;

  };



/* =========================================*

*   VALIDAR ANULACIÓN MEDIANTE NOTA DE CRÉDITO*

*   Evidencia exigida:*

*   - DTE tipo 61.*

*   - GET detalle de la Nota de Crédito.*

*   - dte_children contiene EXACTAMENTE el ID*

*     del DTE que queremos considerar anulado.*

*   - El monto de la NC cubre el total completo*

*     del DTE original (tolerancia 1 CLP).*

*   - La NC debe estar ACCEPTED/ACEPTADO en SII*

*     para considerar la anulación confirmada.*

*   El comment/monto sólo se usan para reducir*

*   consultas de detalle. Nunca prueban por sí*

*   solos que una NC anule un DTE.*

*   SOLO LECTURA:*

*   - GET lista tipo 61.*

*   - GET detalle tipo 61.*

*   - NO POST.*

*   - NO persiste.*

*========================================= */

const inspectRelbaseCancellation =

  async ({

    originalRecord,

    expectedMarker,

    maxPages,

  }) => {

    const originalId =

      toOptionalString(

        originalRecord?.id

      );

    const originalTotal =

      resolveRelbaseTotal(

        originalRecord

      );

    if (!originalId) {

      return {

        status:

          "CANCELLATION_NOT_VERIFIABLE",

        verified:

          false,

        safe_to_ignore_original:

          false,

        reason:

          "ORIGINAL_RELBASE_ID_MISSING",

        pages_scanned:

          0,

        scan_complete:

          false,

        detail_gets:

          0,

        credit_note:

          null,

      };

    }

    let page = 1;

    let pagesScanned = 0;

    let scanComplete =

      false;

    let detailGets = 0;

    let lastMeta =

      null;

    let pending =

      null;

    let rejected =

      null;

    let partial =

      null;

    while (

      page <=

        maxPages

    ) {

      const endpoint =

        `/api/v2/dtes?type_document=61&page=${encodeURIComponent(

          page

        )}`;

      const result =

        await relbaseRequest(

          endpoint,

          {

            method:

              "GET",

          }

        );

      const payload =

        result?.data ||

        null;

      const records =

        payload?.data?.dtes;

      const meta =

        payload?.meta ||

        {};

      if (

        !Array.isArray(

          records

        )

      ) {

        throw createServiceError(

          "Relbase respondió con una estructura de Notas de Crédito v2 no reconocida",

          502,

          "RELBASE_CREDIT_NOTE_LIST_INVALID"

        );

      }

      pagesScanned +=

        1;

      lastMeta =

        meta;

      for (

        const creditNote

        of records

      ) {

        const creditNoteId =

          toOptionalString(

            creditNote?.id

          );

        const creditNoteType =

          Number(

            creditNote?.type_document

          );

        if (

          !creditNoteId ||

          creditNoteType !== 61

        ) {

          continue;

        }

        const creditNoteComment =

          toOptionalString(

            creditNote?.comment

          );

        const creditNoteTotal =

          resolveRelbaseTotal(

            creditNote

          );

        const markerMatches =

          creditNoteComment ===

            expectedMarker;

        const amountLooksRelated =

          originalTotal !==

            null &&

          creditNoteTotal !==

            null &&

          Math.abs(

            originalTotal -

            creditNoteTotal

          ) <= 1;

        /**

*         * Pre-filtro de costo.*

*         **

*         * La relación definitiva NO depende de*

*         * este filtro: siempre se confirma por*

*         * dte_children en el detalle de la NC.*

*         */

        if (

          !markerMatches &&

          !amountLooksRelated

        ) {

          continue;

        }

        const detail =

          await getRelbaseDteDetail(

            creditNoteId

          );

        detailGets +=

          1;

        const detailType =

          Number(

            detail?.type_document

          );

        if (

          detailType !== 61

        ) {

          continue;

        }

        const children =

          Array.isArray(

            detail?.dte_children

          )

            ? detail.dte_children

            : [];

        const linkedChild =

          children.find(

            (

              child

            ) =>

              toOptionalString(

                child?.id

              ) ===

              originalId

          ) ||

          null;

        if (!linkedChild) {

          continue;

        }

        const detailTotal =

          resolveRelbaseTotal(

            detail

          );

        const fullAmountMatches =

          originalTotal !==

            null &&

          detailTotal !==

            null &&

          Math.abs(

            originalTotal -

            detailTotal

          ) <= 1;

        const evidence = {

          verified_relation:

            true,

          original: {

            relbase_document_id:

              originalId,

            folio:

              toOptionalString(

                originalRecord?.folio

              ),

            type_document:

              Number.isFinite(

                Number(

                  originalRecord?.type_document

                )

              )

                ? Number(

                    originalRecord.type_document

                  )

                : null,

            total:

              originalTotal,

          },

          linked_child:

            buildDteChildPreview(

              linkedChild

            ),

          credit_note:

            buildCreditNotePreview(

              creditNote,

              detail

            ),

          amount_matches_original:

            fullAmountMatches,

          tolerance_clp:

            1,

        };

        if (!fullAmountMatches) {

          if (!partial) {

            partial =

              evidence;

          }

          continue;

        }

        if (

          isSiiAccepted(

            detail?.sii_status

          )

        ) {

          return {

            status:

              "CANCELLED_BY_ACCEPTED_CREDIT_NOTE",

            verified:

              true,

            safe_to_ignore_original:

              true,

            reason:

              "FULL_CREDIT_NOTE_ACCEPTED_BY_SII",

            pages_scanned:

              pagesScanned,

            scan_complete:

              false,

            verification_complete:

              true,

            detail_gets:

              detailGets,

            pagination: {

              current_page:

                lastMeta?.current_page ??

                null,

              next_page:

                lastMeta?.next_page ??

                null,

              total_pages:

                lastMeta?.total_pages ??

                null,

              total_count:

                lastMeta?.total_count ??

                null,

            },

            ...evidence,

          };

        }

        if (

          isSiiRejected(

            detail?.sii_status

          )

        ) {

          if (!rejected) {

            rejected =

              evidence;

          }

          continue;

        }

        if (!pending) {

          pending =

            evidence;

        }

      }

      const nextPageRaw =

        meta?.next_page;

      const nextPage =

        Number(

          nextPageRaw

        );

      const totalPages =

        Number(

          meta?.total_pages

        );

      if (

        Number.isFinite(

          nextPage

        ) &&

        nextPage > page

      ) {

        page =

          nextPage;

        continue;

      }

      if (

        nextPageRaw ===

          -1 ||

        nextPageRaw ===

          "-1"

      ) {

        scanComplete =

          true;

        break;

      }

      if (

        Number.isFinite(

          totalPages

        )

      ) {

        if (

          page >=

          totalPages

        ) {

          scanComplete =

            true;

          break;

        }

        page +=

          1;

        continue;

      }

      if (

        records.length ===

        0

      ) {

        scanComplete =

          true;

        break;

      }

      break;

    }

    const common = {

      pages_scanned:

        pagesScanned,

      scan_complete:

        scanComplete,

      verification_complete:

        scanComplete,

      detail_gets:

        detailGets,

      pagination: {

        current_page:

          lastMeta?.current_page ??

          null,

        next_page:

          lastMeta?.next_page ??

          null,

        total_pages:

          lastMeta?.total_pages ??

          null,

        total_count:

          lastMeta?.total_count ??

          null,

      },

    };

    if (pending) {

      return {

        status:

          "CANCELLATION_PENDING",

        verified:

          true,

        safe_to_ignore_original:

          false,

        reason:

          "FULL_CREDIT_NOTE_NOT_ACCEPTED_BY_SII_YET",

        ...common,

        ...pending,

      };

    }

    if (partial) {

      return {

        status:

          "PARTIAL_CREDIT_NOTE_FOUND",

        verified:

          true,

        safe_to_ignore_original:

          false,

        reason:

          "CREDIT_NOTE_DOES_NOT_COVER_FULL_ORIGINAL_TOTAL",

        ...common,

        ...partial,

      };

    }

    if (rejected) {

      return {

        status:

          "CANCELLATION_REJECTED",

        verified:

          true,

        safe_to_ignore_original:

          false,

        reason:

          "CREDIT_NOTE_REJECTED_BY_SII",

        ...common,

        ...rejected,

      };

    }

    return {

      status:

        scanComplete

          ? "NO_CANCELLATION_FOUND"

          : "CANCELLATION_SCAN_INCOMPLETE",

      verified:

        false,

      safe_to_ignore_original:

        false,

      reason:

        scanComplete

          ? "NO_LINKED_CREDIT_NOTE_FOUND"

          : "CREDIT_NOTE_SCAN_NOT_COMPLETE",

      ...common,

      credit_note:

        null,

    };

  };



/* =========================================*

*   PREVIEW RECONCILIACIÓN PRE-EMISIÓN*

*   OBJETIVO:*

*   Antes de permitir una futura emisión/retry,*

*   buscar si Relbase ya posee un DTE generado*

*   para la orden aunque Laminatiword todavía*

*   no tenga relbase_document_id.*

*   MARCADOR:*

*     comment = "Laminatiword \<order_number>"*

*   MEJORA ANULACIONES:*

*   Un DTE previo con el mismo marcador no se*

*   considera automáticamente conflicto si una*

*   Nota de Crédito tipo 61 lo anuló.*

*   Para ignorar ese DTE histórico exigimos:*

*   - NC tipo 61.*

*   - relación exacta por dte_children[].id.*

*   - mismo total completo (±1 CLP).*

*   - NC ACCEPTED/ACEPTADO por SII.*

*   Una NC sent_sii/Enviado NO libera emisión:*

*   devuelve CANCELLATION_PENDING.*

*   SEGURIDAD:*

*   - Sólo GET hacia Relbase.*

*   - NO INSERT.*

*   - NO UPDATE.*

*   - NO DELETE.*

*   - NO POST.*

*   - NO emite documentos.*

*========================================= */

export const previewTaxDocumentRelbaseReconciliation =

  async ({

    taxDocumentId,

    maxPages = 20,

  }) => {

    if (!taxDocumentId) {

      throw createServiceError(

        "Se requiere taxDocumentId",

        400,

        "TAX_DOCUMENT_ID_REQUIRED"

      );

    }

    const normalizedMaxPages =

      Math.min(

        Math.max(

          Number(

            maxPages

          ) || 20,

          1

        ),

        500

      );

    /* =====================================*

*       1. CARGAR DOCUMENTO LOCAL + ORDEN*

*    ===================================== */

    const localResult =

      await pool.query(

        `

          SELECT

            td.id,

            td.order_id,

            td.idempotency_key,

            td.document_type,

            td.sii_code,

            td.status,

            td.relbase_document_id,

            td.folio,

            td.track_id,

            td.net_amount,

            td.exempt_amount,

            td.tax_amount,

            td.total_amount,

            td.issued_by,

            td.issued_at,

            o.order_number,

            o.source,

            o.payment_status,

            o.total AS order_total,

            o.currency,

            o.created_at AS order_created_at

          FROM tax_documents td

          INNER JOIN orders o

            ON o.id = td.order_id

          WHERE td.id = $1

          LIMIT 1

        `,

        [

          taxDocumentId,

        ]

      );

    if (

      localResult.rowCount ===

      0

    ) {

      throw createServiceError(

        "El documento tributario local no existe",

        404,

        "TAX_DOCUMENT_NOT_FOUND"

      );

    }

    const local =

      localResult.rows[0];

    const typeDocument =

      Number(

        local.sii_code

      );

    if (

      ![

        33,

        39,

      ].includes(

        typeDocument

      )

    ) {

      throw createServiceError(

        "El documento local no corresponde a FACTURA 33 o BOLETA 39",

        409,

        "TAX_DOCUMENT_TYPE_NOT_RECONCILIABLE"

      );

    }

    const expectedMarker =

      `Laminatiword ${local.order_number}`;

    const expectedLabelValue =

      toOptionalString(

        local.order_number

      );

    const localTotal =

      roundMoney(

        local.total_amount

      );

    /**

*     * Si ya existe identidad externa, no*

*     * necesitamos buscar un posible huérfano.*

*     */

    if (

      local.relbase_document_id

    ) {

      return {

        read_only:

          true,

        reconciliation_policy:

          "CREDIT_NOTE_AWARE_V1",

        reconciliation_status:

          "ALREADY_LINKED",

        safe_to_continue:

          false,

        scan_complete:

          true,

        pages_scanned:

          0,

        max_pages:

          normalizedMaxPages,

        marker:

          expectedMarker,

        local: {

          tax_document_id:

            local.id,

          order_id:

            local.order_id,

          order_number:

            local.order_number,

          status:

            local.status,

          type_document:

            typeDocument,

          payment_status:

            local.payment_status,

          total:

            localTotal,

          currency:

            local.currency,

          relbase_document_id:

            local.relbase_document_id,

          folio:

            local.folio ||

            null,

          track_id:

            local.track_id ||

            null,

        },

        candidate:

          null,

        conflict:

          null,

        cancellation_pending:

          null,

        historical_cancelled_documents:

          [],

        pagination: {

          current_page:

            null,

          next_page:

            null,

          total_pages:

            null,

          total_count:

            null,

        },

      };

    }

    let page = 1;

    let pagesScanned = 0;

    let scanComplete =

      false;

    let candidate =

      null;

    let conflict =

      null;

    let cancellationPending =

      null;

    let lastMeta =

      null;

    const historicalCancelledDocuments =

      [];

    /* =====================================*

*       2. RECORRER DTEs RELBASE*

*       Para cada documento con nuestro marcador:*

*       - Si tipo + total coinciden => MATCH_FOUND.*

*       - Si existe diferencia => buscamos una NC.*

*       - NC aceptada y vinculada => histórico; se*

*         continúa buscando otro DTE vigente.*

*       - NC pendiente => bloquea reemisión.*

*       - Sin NC verificable => conflicto.*

*    ===================================== */

    while (

      page <=

        normalizedMaxPages

    ) {

      const endpoint =

        `/api/v2/dtes?type_document=${encodeURIComponent(

          typeDocument

        )}&page=${encodeURIComponent(

          page

        )}`;

      const result =

        await relbaseRequest(

          endpoint,

          {

            method:

              "GET",

          }

        );

      const payload =

        result?.data ||

        null;

      const records =

        payload?.data?.dtes;

      const meta =

        payload?.meta ||

        {};

      if (

        !Array.isArray(

          records

        )

      ) {

        throw createServiceError(

          "Relbase respondió con una estructura DTE v2 no reconocida",

          502,

          "RELBASE_DTE_LIST_INVALID"

        );

      }

      pagesScanned +=

        1;

      lastMeta =

        meta;

      for (

        const record

        of records

      ) {

        const recordComment =

          toOptionalString(

            record?.comment

          );

        const recordLabelValue =

          toOptionalString(

            record?.label_value

          );

        const markerMatches =

          recordLabelValue ===

            expectedLabelValue ||

          recordComment ===

            expectedMarker;

        if (!markerMatches) {

          continue;

        }

        const recordType =

          Number(

            record?.type_document

          );

        const recordTotal =

          resolveRelbaseTotal(

            record

          );

        const typeMatches =

          Number.isFinite(

            recordType

          ) &&

          recordType ===

            typeDocument;

        const totalMatches =

          localTotal !==

            null &&

          recordTotal !==

            null &&

          Math.abs(

            localTotal -

            recordTotal

          ) <=

            RELBASE_DTE_RECONCILIATION_TOTAL_TOLERANCE_CLP;

        const preview =

          buildCandidatePreview(

            record

          );

        if (

          typeMatches &&

          totalMatches

        ) {

          candidate =

            preview;

          break;

        }

        const conflictReason =

          !typeMatches

            ? "TYPE_MISMATCH"

            : "TOTAL_MISMATCH";

        const cancellation =

          await inspectRelbaseCancellation({

            originalRecord:

              record,

            expectedMarker,

            maxPages:

              normalizedMaxPages,

          });

        if (

          cancellation

            .safe_to_ignore_original ===

          true

        ) {

          historicalCancelledDocuments

            .push({

              reason:

                conflictReason,

              original:

                preview,

              cancellation,

            });

          /**

*           * Documento histórico correctamente*

*           * anulado. No es un DTE vigente y no*

*           * bloquea por sí mismo, pero seguimos*

*           * recorriendo para descartar otra boleta/*

*           * factura activa con el mismo marcador.*

*           */

          continue;

        }

        if (

          cancellation.status ===

          "CANCELLATION_PENDING"

        ) {

          if (!cancellationPending) {

            cancellationPending = {

              reason:

                conflictReason,

              original:

                preview,

              cancellation,

            };

          }

          /**

*           * Seguimos buscando por seguridad:*

*           * podría existir además otro DTE vigente.*

*           */

          continue;

        }

        if (!conflict) {

          conflict = {

            reason:

              conflictReason,

            candidate:

              preview,

            cancellation,

          };

        }

        /**

*         * No cortamos: si existe otro DTE correcto*

*         * con el mismo marcador, MATCH_FOUND debe*

*         * tener prioridad sobre el conflicto previo.*

*         */

      }

      if (candidate) {

        break;

      }

      const nextPageRaw =

        meta?.next_page;

      const nextPage =

        Number(

          nextPageRaw

        );

      const totalPages =

        Number(

          meta?.total_pages

        );

      if (

        Number.isFinite(

          nextPage

        ) &&

        nextPage > page

      ) {

        page =

          nextPage;

        continue;

      }

      if (

        nextPageRaw ===

          -1 ||

        nextPageRaw ===

          "-1"

      ) {

        scanComplete =

          true;

        break;

      }

      if (

        Number.isFinite(

          totalPages

        )

      ) {

        if (

          page >=

          totalPages

        ) {

          scanComplete =

            true;

          break;

        }

        page +=

          1;

        continue;

      }

      if (

        records.length ===

        0

      ) {

        scanComplete =

          true;

        break;

      }

      break;

    }

    /* =====================================*

*       3. RESULTADO RECONCILIACIÓN*

*    ===================================== */

    let reconciliationStatus =

      "SCAN_INCOMPLETE";

    let safeToContinue =

      false;

    if (candidate) {

      reconciliationStatus =

        "MATCH_FOUND";

    } else if (conflict) {

      reconciliationStatus =

        "MATCH_CONFLICT";

    } else if (cancellationPending) {

      reconciliationStatus =

        "CANCELLATION_PENDING";

    } else if (

      scanComplete &&

      historicalCancelledDocuments

        .length > 0

    ) {

      reconciliationStatus =

        "NO_ACTIVE_MATCH_AFTER_CANCELLATION";

      safeToContinue =

        true;

    } else if (scanComplete) {

      reconciliationStatus =

        "NO_MATCH_FOUND";

      safeToContinue =

        true;

    }

    return {

      read_only:

        true,

      reconciliation_policy:

        "CREDIT_NOTE_AWARE_V1",

      reconciliation_status:

        reconciliationStatus,

      safe_to_continue:

        safeToContinue,

      scan_complete:

        scanComplete,

      pages_scanned:

        pagesScanned,

      max_pages:

        normalizedMaxPages,

      marker:

        expectedMarker,

      local: {

        tax_document_id:

          local.id,

        order_id:

          local.order_id,

        order_number:

          local.order_number,

        status:

          local.status,

        type_document:

          typeDocument,

        payment_status:

          local.payment_status,

        total:

          localTotal,

        currency:

          local.currency,

        relbase_document_id:

          local.relbase_document_id ||

          null,

        folio:

          local.folio ||

          null,

        track_id:

          local.track_id ||

          null,

      },

      candidate,

      conflict,

      cancellation_pending:

        cancellationPending,

      historical_cancelled_documents:

        historicalCancelledDocuments,

      pagination: {

        current_page:

          lastMeta?.current_page ??

          null,

        next_page:

          lastMeta?.next_page ??

          null,

        total_pages:

          lastMeta?.total_pages ??

          null,

        total_count:

          lastMeta?.total_count ??

          null,

      },

    };

  };



/* =========================================*

*   PREFLIGHT COMPLETO DE EMISIÓN DTE*

*   PASO 84.6.6*

*   SOLO LECTURA:*

*   - SELECT local.*

*   - Construcción de preview local.*

*   - GET de reconciliación hacia Relbase.*

*   - NO claim.*

*   - NO INSERT / UPDATE / DELETE.*

*   - NO POST hacia Relbase.*

*   - NO emite documentos.*

*========================================= */

export const previewTaxDocumentRelbaseEmissionPreflight =

  async ({

    taxDocumentId,

    maxPages = 100,

  }) => {

    if (!taxDocumentId) {

      throw createServiceError(

        "Se requiere taxDocumentId",

        400,

        "TAX_DOCUMENT_ID_REQUIRED"

      );

    }

    const normalizedMaxPages =

      Math.min(

        Math.max(

          Number(maxPages) || 100,

          1

        ),

        500

      );

    const localResult =

      await pool.query(

        `

          SELECT

            td.id AS tax_document_id,

            td.order_id,

            td.idempotency_key,

            td.emission_flow_version,

            td.document_type,

            td.sii_code,

            td.status AS tax_document_status,

            td.relbase_document_id,

            td.folio,

            td.track_id,

            td.total_amount,

            td.issued_by,

            td.issued_at,

            td.error_message,

            td.request_payload,

            o.order_number,

            o.source,

            o.status AS order_status,

            o.payment_status AS order_payment_status,

            o.total AS order_total,

            o.currency AS order_currency,

            p.id AS payment_id,

            p.status AS payment_status,

            p.amount AS payment_amount,

            p.currency AS payment_currency,

            p.confirmed_at AS payment_confirmed_at

          FROM tax_documents td

          INNER JOIN orders o

            ON o.id = td.order_id

          LEFT JOIN payments p

            ON p.order_id = o.id

          WHERE td.id = $1

          LIMIT 1

        `,

        [

          taxDocumentId,

        ]

      );

    if (

      localResult.rowCount ===

      0

    ) {

      throw createServiceError(

        "El documento tributario local no existe",

        404,

        "TAX_DOCUMENT_NOT_FOUND"

      );

    }

    const local =

      localResult.rows[0];

    const checks = [];

    const operationalIssues = [];

    const contractIssues = [];

    const addOperationalCheck = ({

      code,

      label,

      passed,

      details = null,

    }) => {

      const ok =

        Boolean(passed);

      checks.push({

        code,

        label,

        passed:

          ok,

        category:

          "OPERATIONAL",

        blocker:

          true,

        details,

      });

      if (!ok) {

        operationalIssues.push({

          code,

          message:

            label,

          details,

        });

      }

      return ok;

    };

    const taxDocumentStatus =

      String(

        local.tax_document_status ||

        ""

      )

        .trim()

        .toUpperCase();

    const orderStatus =

      String(

        local.order_status ||

        ""

      )

        .trim()

        .toUpperCase();

    const orderPaymentStatus =

      String(

        local.order_payment_status ||

        ""

      )

        .trim()

        .toUpperCase();

    const paymentStatus =

      String(

        local.payment_status ||

        ""

      )

        .trim()

        .toUpperCase();

    const documentType =

      String(

        local.document_type ||

        ""

      )

        .trim()

        .toUpperCase();

    const siiCode =

      Number(

        local.sii_code

      );

    const expectedSiiCode =

      documentType === "BOLETA"

        ? 39

        : documentType === "FACTURA"

          ? 33

          : null;

    const orderTotal =

      roundMoney(

        local.order_total

      );

    const paymentAmount =

      roundMoney(

        local.payment_amount

      );

    const documentTotal =

      roundMoney(

        local.total_amount

      );

    addOperationalCheck({

      code:

        "TAX_DOCUMENT_STATUS_PENDING",

      label:

        "El tax_document debe estar en PENDING",

      passed:

        taxDocumentStatus ===

        "PENDING",

      details: {

        current_status:

          taxDocumentStatus ||

          null,

      },

    });

    addOperationalCheck({

      code:

        "TAX_DOCUMENT_TYPE_SUPPORTED",

      label:

        "El documento debe ser BOLETA 39 o FACTURA 33",

      passed:

        expectedSiiCode !==

          null &&

        siiCode ===

          expectedSiiCode,

      details: {

        document_type:

          documentType ||

          null,

        sii_code:

          Number.isFinite(

            siiCode

          )

            ? siiCode

            : null,

        expected_sii_code:

          expectedSiiCode,

      },

    });

    const idempotencyKeyPresent =

      Boolean(

        String(

          local.idempotency_key ||

          ""

        ).trim()

      );

    addOperationalCheck({

      code:

        "TAX_DOCUMENT_IDEMPOTENCY_KEY_PRESENT",

      label:

        "El documento debe poseer idempotency_key",

      passed:

        idempotencyKeyPresent,

      details: {

        present:

          idempotencyKeyPresent,

      },

    });

    addOperationalCheck({

      code:

        "TAX_DOCUMENT_EXTERNAL_IDENTITY_EMPTY",

      label:

        "El documento no debe poseer identidad externa previa de Relbase",

      passed:

        !local.relbase_document_id &&

        !local.folio &&

        !local.track_id,

      details: {

        relbase_document_id:

          local.relbase_document_id ||

          null,

        folio:

          local.folio ||

          null,

        track_id:

          local.track_id ||

          null,

      },

    });

    addOperationalCheck({

      code:

        "TAX_DOCUMENT_NOT_PREVIOUSLY_ISSUED",

      label:

        "El documento no debe poseer issued_by ni issued_at antes de emitir",

      passed:

        !local.issued_by &&

        !local.issued_at,

      details: {

        issued_by:

          local.issued_by ||

          null,

        issued_at:

          local.issued_at ||

          null,

      },

    });

    addOperationalCheck({

      code:

        "TAX_DOCUMENT_NO_PENDING_ERROR",

      label:

        "El documento no debe conservar un error previo",

      passed:

        !local.error_message,

      details: {

        error_message:

          local.error_message ||

          null,

      },

    });

    addOperationalCheck({

      code:

        "TAX_DOCUMENT_NO_PREVIOUS_REQUEST_SNAPSHOT",

      label:

        "No debe existir un request_payload previo sin identidad Relbase",

      passed:

        !local.request_payload,

      details: {

        request_payload_present:

          Boolean(

            local.request_payload

          ),

      },

    });

    addOperationalCheck({

      code:

        "ORDER_NOT_CANCELLED",

      label:

        "La orden no debe estar cancelada",

      passed:

        orderStatus !==

        "CANCELLED",

      details: {

        order_status:

          orderStatus ||

          null,

      },

    });

    addOperationalCheck({

      code:

        "ORDER_PAYMENT_STATUS_PAID",

      label:

        "orders.payment_status debe estar en PAID",

      passed:

        orderPaymentStatus ===

        "PAID",

      details: {

        payment_status:

          orderPaymentStatus ||

          null,

      },

    });

    addOperationalCheck({

      code:

        "PAYMENT_RECORD_EXISTS",

      label:

        "La orden debe poseer un registro payments",

      passed:

        Boolean(

          local.payment_id

        ),

      details: {

        payment_id:

          local.payment_id ||

          null,

      },

    });

    addOperationalCheck({

      code:

        "PAYMENT_RECORD_PAID",

      label:

        "El registro payments debe estar en PAID",

      passed:

        Boolean(

          local.payment_id

        ) &&

        paymentStatus ===

          "PAID",

      details: {

        payment_status:

          paymentStatus ||

          null,

      },

    });

    addOperationalCheck({

      code:

        "PAYMENT_CONFIRMED",

      label:

        "El pago PAID debe poseer confirmed_at",

      passed:

        Boolean(

          local.payment_id

        ) &&

        Boolean(

          local.payment_confirmed_at

        ),

      details: {

        confirmed_at:

          local.payment_confirmed_at ||

          null,

      },

    });

    addOperationalCheck({

      code:

        "ORDER_PAYMENT_AMOUNT_MATCH",

      label:

        "El monto del pago debe coincidir con el total de la orden",

      passed:

        orderTotal !==

          null &&

        paymentAmount !==

          null &&

        Math.abs(

          orderTotal -

          paymentAmount

        ) <= 1,

      details: {

        order_total:

          orderTotal,

        payment_amount:

          paymentAmount,

        tolerance_clp:

          1,

      },

    });

    addOperationalCheck({

      code:

        "ORDER_TAX_DOCUMENT_AMOUNT_MATCH",

      label:

        "El total tributario debe coincidir con el total de la orden",

      passed:

        orderTotal !==

          null &&

        documentTotal !==

          null &&

        Math.abs(

          orderTotal -

          documentTotal

        ) <= 1,

      details: {

        order_total:

          orderTotal,

        tax_document_total:

          documentTotal,

        tolerance_clp:

          1,

      },

    });

    addOperationalCheck({

      code:

        "CURRENCY_MATCH",

      label:

        "La moneda de la orden y del pago debe coincidir",

      passed:

        Boolean(

          local.order_currency

        ) &&

        Boolean(

          local.payment_currency

        ) &&

        String(

          local.order_currency

        )

          .trim()

          .toUpperCase() ===

        String(

          local.payment_currency

        )

          .trim()

          .toUpperCase(),

      details: {

        order_currency:

          local.order_currency ||

          null,

        payment_currency:

          local.payment_currency ||

          null,

      },

    });

    /* =====================================*

*       PAYLOAD LOCAL*

*    ===================================== */

    let payloadPreview =

      null;

    let payloadPreviewError =

      null;

    try {

      payloadPreview =

        await buildRelbaseDtePreview(

          local.order_id

        );

    } catch (error) {

      payloadPreviewError = {

        code:

          error.code ||

          "RELBASE_DTE_PREVIEW_FAILED",

        message:

          error.message ||

          "No fue posible construir el payload Relbase",

      };

    }

    const payloadReady =

      Boolean(

        payloadPreview &&

        payloadPreview.payload_ready ===

          true &&

        Array.isArray(

          payloadPreview.blocking_issues

        ) &&

        payloadPreview

          .blocking_issues

          .length === 0

      );

    addOperationalCheck({

      code:

        "RELBASE_PAYLOAD_READY",

      label:

        "El payload Relbase debe estar válido y sin bloqueos",

      passed:

        payloadReady,

      details:

        payloadPreviewError ||

        {

          schema:

            payloadPreview?.schema ||

            null,

          payload_ready:

            payloadPreview

              ?.payload_ready ??

            false,

          blocking_issues:

            payloadPreview

              ?.blocking_issues ||

            [],

          warnings:

            payloadPreview

              ?.warnings ||

            [],

        },

    });

    /* =====================================*

*       RECONCILIACIÓN READ-ONLY*

*       OPTIMIZACIÓN FIRST ATTEMPT CLEAN V1*

*

*       IMPORTANTE:*

*       La reconciliación exhaustiva sigue intacta*

*       en previewTaxDocumentRelbaseReconciliation().*

*

*       En el preflight de una PRIMERA emisión*

*       podemos omitir el barrido externo sólo si*

*       el estado local demuestra que este flujo*

*       nunca alcanzó un POST previo:*

*

*       - emission_flow_version = 2.*

*       - tax_document PENDING.*

*       - idempotency_key presente.*

*       - sin identidad Relbase.*

*       - sin issued_by / issued_at.*

*       - sin error previo.*

*       - sin request_payload previo.*

*

*       request_payload se persiste ANTES del POST*

*       en relbaseDteEmission.service.js. Por eso,*

*       si existe request_payload, este fast-path*

*       jamás se utiliza.*

*

*       El fast-path queda además protegido por:*

*       - provenance/versionado local (= 2).*

*       - ENV para habilitarlo de forma controlada.*

*

*       IMPORTANTE: documentos legacy con versión*

*       NULL o distinta de 2 siempre caen a la*

*       reconciliación completa.*

*    ===================================== */

    let reconciliation =

      null;

    let reconciliationExecuted =

      false;

    let relbaseGetExecuted =

      false;

    let reconciliationMode =

      "NOT_EXECUTED";

    const firstAttemptFastPathEnabled =

      [

        "true",

        "1",

        "yes",

        "si",

        "sí",

      ].includes(

        String(

          process.env

            .RELBASE_DTE_FIRST_ATTEMPT_FAST_PATH_ENABLED ||

          "false"

        )

          .trim()

          .toLowerCase()

      );

    const emissionFlowVersion =

      Number(

        local.emission_flow_version

      );

    const trustedEmissionFlow =

      Number.isInteger(

        emissionFlowVersion

      ) &&

      emissionFlowVersion ===

        TRUSTED_FIRST_ATTEMPT_FLOW_VERSION;

    const firstAttemptClean =

      trustedEmissionFlow ===

        true &&

      taxDocumentStatus ===

        "PENDING" &&

      idempotencyKeyPresent ===

        true &&

      !local.relbase_document_id &&

      !local.folio &&

      !local.track_id &&

      !local.issued_by &&

      !local.issued_at &&

      !local.error_message &&

      !local.request_payload;

    if (

      operationalIssues.length ===

      0

    ) {

      if (

        firstAttemptFastPathEnabled &&

        firstAttemptClean

      ) {

        reconciliationMode =

          "FIRST_ATTEMPT_CLEAN";

        reconciliationExecuted =

          true;

        relbaseGetExecuted =

          false;

        reconciliation = {

          read_only:

            true,

          reconciliation_policy:

            "FIRST_ATTEMPT_CLEAN_V1",

          reconciliation_mode:

            reconciliationMode,

          reconciliation_status:

            "FIRST_ATTEMPT_CLEAN",

          safe_to_continue:

            true,

          scan_complete:

            false,

          scan_skipped:

            true,

          pages_scanned:

            0,

          max_pages:

            normalizedMaxPages,

          marker:

            `Laminatiword ${local.order_number}`,

          reason:

            "TRUSTED_FLOW_V2_AND_LOCAL_STATE_PROVE_NO_PREVIOUS_RELBASE_POST",

          local: {

            tax_document_id:

              local.tax_document_id,

            order_id:

              local.order_id,

            order_number:

              local.order_number,

            emission_flow_version:

              emissionFlowVersion,

            trusted_emission_flow:

              trustedEmissionFlow,

            status:

              taxDocumentStatus,

            type_document:

              siiCode,

            payment_status:

              paymentStatus,

            total:

              documentTotal,

            currency:

              local.order_currency,

            relbase_document_id:

              null,

            folio:

              null,

            track_id:

              null,

            request_payload_present:

              false,

          },

          candidate:

            null,

          conflict:

            null,

          cancellation_pending:

            null,

          historical_cancelled_documents:

            [],

          pagination: {

            current_page:

              null,

            next_page:

              null,

            total_pages:

              null,

            total_count:

              null,

          },

        };

      } else {

        reconciliationMode =

          "FULL_RECONCILIATION";

        reconciliation =

          await previewTaxDocumentRelbaseReconciliation({

            taxDocumentId,

            maxPages:

              normalizedMaxPages,

          });

        reconciliation = {

          ...reconciliation,

          reconciliation_mode:

            reconciliationMode,

          scan_skipped:

            false,

          relbase_get_executed:

            true,

        };

        reconciliationExecuted =

          true;

        relbaseGetExecuted =

          true;

      }

    }

    const reconciliationSafeStatuses =

      [

        "FIRST_ATTEMPT_CLEAN",

        "NO_MATCH_FOUND",

        "NO_ACTIVE_MATCH_AFTER_CANCELLATION",

      ];

    const firstAttemptCleanAccepted =

      reconciliation

        ?.reconciliation_status ===

      "FIRST_ATTEMPT_CLEAN";

    const reconciliationEvidenceComplete =

      firstAttemptCleanAccepted

        ? (

            reconciliation

              ?.scan_skipped ===

              true &&

            relbaseGetExecuted ===

              false

          )

        : reconciliation

            ?.scan_complete ===

          true;

    const reconciliationSafe =

      Boolean(

        reconciliationExecuted &&

        reconciliationSafeStatuses

          .includes(

            reconciliation

              ?.reconciliation_status

          ) &&

        reconciliation

          ?.safe_to_continue ===

          true &&

        reconciliationEvidenceComplete

      );

    addOperationalCheck({

      code:

        "RELBASE_RECONCILIATION_SAFE",

      label:

        "Debe existir evidencia segura para continuar: primer intento limpio o reconciliación completa sin DTE activo",

      passed:

        reconciliationSafe,

      details: {

        executed:

          reconciliationExecuted,

        mode:

          reconciliationMode,

        first_attempt_fast_path_enabled:

          firstAttemptFastPathEnabled,

        required_emission_flow_version:

          TRUSTED_FIRST_ATTEMPT_FLOW_VERSION,

        emission_flow_version:

          Number.isFinite(

            emissionFlowVersion

          )

            ? emissionFlowVersion

            : null,

        trusted_emission_flow:

          trustedEmissionFlow,

        first_attempt_clean:

          firstAttemptClean,

        relbase_get_executed:

          relbaseGetExecuted,

        scan_skipped:

          reconciliation

            ?.scan_skipped ??

          false,

        status:

          reconciliation

            ?.reconciliation_status ||

          null,

        accepted_safe_statuses:

          reconciliationSafeStatuses,

        safe_to_continue:

          reconciliation

            ?.safe_to_continue ??

          false,

        scan_complete:

          reconciliation

            ?.scan_complete ??

          false,

        pages_scanned:

          reconciliation

            ?.pages_scanned ??

          0,

        max_pages:

          normalizedMaxPages,

      },

    });

    /* =====================================*

*       CONTRATO POST V2*

*    ===================================== */

    const apiV2WriteContractConfirmed =

      payloadPreview

        ?.contract_validation

        ?.api_v2_write_contract_confirmed ===

      true;

    checks.push({

      code:

        "RELBASE_V2_WRITE_CONTRACT_CONFIRMED",

      label:

        "El contrato POST DTE v2 debe estar confirmado antes de habilitar emisión",

      passed:

        apiV2WriteContractConfirmed,

      category:

        "CONTRACT",

      blocker:

        true,

      details: {

        confirmed:

          apiV2WriteContractConfirmed,

      },

    });

    if (

      !apiV2WriteContractConfirmed

    ) {

      contractIssues.push({

        code:

          "RELBASE_V2_WRITE_CONTRACT_NOT_CONFIRMED",

        message:

          "El payload operativo está preparado, pero el contrato exacto POST DTE v2 todavía no está confirmado.",

      });

    }

    const operationalChecksPassed =

      operationalIssues.length ===

      0;

    const contractChecksPassed =

      contractIssues.length ===

      0;

    const readyForEmission =

      operationalChecksPassed &&

      contractChecksPassed;

    return {

      schema:

        "LAMINATIWORD_RELBASE_DTE_PREFLIGHT_V1",

      reconciliation_policy:

        "CREDIT_NOTE_AWARE_V1",

      generated_at:

        new Date()

          .toISOString(),

      read_only:

        true,

      database_write_executed:

        false,

      claim_executed:

        false,

      reconciliation_executed:

        reconciliationExecuted,

      reconciliation_mode:

        reconciliationMode,

      relbase_get_executed:

        relbaseGetExecuted,

      relbase_post_executed:

        false,

      emission_executed:

        false,

      emission_enabled:

        false,

      operational_checks_passed:

        operationalChecksPassed,

      contract_checks_passed:

        contractChecksPassed,

      ready_for_emission:

        readyForEmission,

      expected_current_result:

        operationalChecksPassed &&

        !contractChecksPassed

          ? "OPERATIONALLY_READY_WAITING_V2_CONTRACT"

          : readyForEmission

            ? "READY_AFTER_CONTRACT_CONFIRMATION"

            : "BLOCKED",

      blocking_issues: [

        ...operationalIssues,

        ...contractIssues,

      ],

      checks,

      local: {

        tax_document_id:

          local.tax_document_id,

        order_id:

          local.order_id,

        order_number:

          local.order_number,

        document_type:

          documentType,

        sii_code:

          Number.isFinite(

            siiCode

          )

            ? siiCode

            : null,

        tax_document_status:

          taxDocumentStatus,

        idempotency_key_present:

          idempotencyKeyPresent,

        emission_flow_version:

          Number.isFinite(

            emissionFlowVersion

          )

            ? emissionFlowVersion

            : null,

        trusted_emission_flow:

          trustedEmissionFlow,

        relbase_document_id:

          local.relbase_document_id ||

          null,

        folio:

          local.folio ||

          null,

        track_id:

          local.track_id ||

          null,

        order_status:

          orderStatus ||

          null,

        order_payment_status:

          orderPaymentStatus ||

          null,

        payment: {

          id:

            local.payment_id ||

            null,

          status:

            paymentStatus ||

            null,

          confirmed_at:

            local.payment_confirmed_at ||

            null,

          amount:

            paymentAmount,

          currency:

            local.payment_currency ||

            null,

        },

        totals: {

          order:

            orderTotal,

          tax_document:

            documentTotal,

        },

      },

      payload_preview:

        payloadPreview

          ? {

              schema:

                payloadPreview.schema,

              payload_ready:

                payloadPreview

                  .payload_ready,

              blocking_issues:

                payloadPreview

                  .blocking_issues,

              warnings:

                payloadPreview

                  .warnings,

              contract_validation:

                payloadPreview

                  .contract_validation,

              payload:

                payloadPreview

                  .payload,

            }

          : {

              payload_ready:

                false,

              error:

                payloadPreviewError,

            },

      reconciliation,

    };

  };