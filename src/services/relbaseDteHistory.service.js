import pool from "../config/database.js";

import {
  relbaseRequest,
} from "./relbase.service.js";

const SUPPORTED_TYPES = {
  33: "FACTURA",
  39: "BOLETA",
};

const RATE_LIMIT_SAFETY_REMAINING = 10;

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

const toOptionalString = (value) => {
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

const toOptionalNumber = (value) => {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
};

const resolveAmount = (
  record,
  realKey,
  baseKey
) => {
  const realValue =
    toOptionalNumber(
      record?.[realKey]
    );

  if (realValue !== null) {
    return realValue;
  }

  return toOptionalNumber(
    record?.[baseKey]
  );
};

const extractOrderNumber = (comment) => {
  const normalized =
    toOptionalString(comment);

  if (!normalized) {
    return null;
  }

  const match = normalized.match(
    /\bLMT-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/i
  );

  return match?.[0]
    ? match[0].toUpperCase()
    : null;
};

const parseDteListPayload = (
  payload,
  typeDocument,
  page
) => {
  const dataContainer =
    payload?.data || null;

  let collectionPath = null;
  let records = [];

  if (Array.isArray(dataContainer)) {
    collectionPath = "data";
    records = dataContainer;
  } else if (
    Array.isArray(
      dataContainer?.dtes
    )
  ) {
    collectionPath = "data.dtes";
    records = dataContainer.dtes;
  } else if (
    Array.isArray(
      dataContainer?.documents
    )
  ) {
    collectionPath =
      "data.documents";
    records =
      dataContainer.documents;
  } else if (
    Array.isArray(
      dataContainer?.resources
    )
  ) {
    collectionPath =
      "data.resources";
    records =
      dataContainer.resources;
  } else {
    throw createServiceError(
      "Relbase respondió con una estructura DTE v2 no reconocida",
      502,
      "RELBASE_DTE_HISTORY_LIST_INVALID"
    );
  }

  return {
    records,
    collectionPath,
    meta: payload?.meta || null,
    typeDocument,
    page,
  };
};

const loadLocalMatches = async ({
  typeDocument,
  records,
}) => {
  const relbaseIds = [
    ...new Set(
      records
        .map((record) =>
          toOptionalString(
            record?.id
          )
        )
        .filter(Boolean)
    ),
  ];

  const orderNumbers = [
    ...new Set(
      records
        .map((record) =>
          extractOrderNumber(
            record?.comment
          )
        )
        .filter(Boolean)
    ),
  ];

  const byRelbaseId = new Map();
  const byOrderNumber = new Map();

  if (relbaseIds.length > 0) {
    const result = await pool.query(
      `
        SELECT
          td.id AS laminatiword_tax_document_id,
          td.order_id,
          td.relbase_document_id,
          td.document_type AS local_document_type,
          td.folio AS local_folio,
          td.status AS local_status,
          o.order_number
        FROM tax_documents td
        LEFT JOIN orders o
          ON o.id = td.order_id
        WHERE td.relbase_document_id = ANY($1::text[])
      `,
      [relbaseIds]
    );

    for (const row of result.rows) {
      const key = toOptionalString(
        row.relbase_document_id
      );

      if (key) {
        byRelbaseId.set(
          key,
          row
        );
      }
    }
  }

  if (orderNumbers.length > 0) {
    const documentType =
      SUPPORTED_TYPES[typeDocument];

    const result = await pool.query(
      `
        SELECT
          o.id AS order_id,
          o.order_number,
          td.id AS laminatiword_tax_document_id,
          td.relbase_document_id,
          td.document_type AS local_document_type,
          td.folio AS local_folio,
          td.status AS local_status
        FROM orders o
        LEFT JOIN tax_documents td
          ON td.order_id = o.id
          AND td.document_type = $2
        WHERE UPPER(o.order_number) = ANY($1::text[])
      `,
      [
        orderNumbers,
        documentType,
      ]
    );

    for (const row of result.rows) {
      const key = toOptionalString(
        row.order_number
      )?.toUpperCase();

      if (key) {
        byOrderNumber.set(
          key,
          row
        );
      }
    }
  }

  return {
    byRelbaseId,
    byOrderNumber,
  };
};

const normalizeHistoryRecord = ({
  record,
  typeDocument,
  localMatches,
}) => {
  const relbaseDocumentId =
    toOptionalString(record?.id);

  if (!relbaseDocumentId) {
    return null;
  }

  const comment =
    toOptionalString(
      record?.comment
    );

  const markerOrderNumber =
    extractOrderNumber(comment);

  const localById =
    localMatches.byRelbaseId.get(
      relbaseDocumentId
    ) || null;

  const localByMarker =
    !localById && markerOrderNumber
      ? localMatches.byOrderNumber.get(
          markerOrderNumber
        ) || null
      : null;

  let sourceSystem = "RELBASE";
  let sourceDetection =
    "EXTERNAL_ONLY";
  let localDocument = null;

  if (localById) {
    sourceSystem = "LAMINATIWORD";
    sourceDetection =
      "LOCAL_RELBASE_DOCUMENT_ID";
    localDocument = localById;
  } else if (markerOrderNumber) {
    sourceSystem = "LAMINATIWORD";

    if (localByMarker) {
      sourceDetection =
        "COMMENT_MARKER_ORDER_MATCH";
      localDocument = localByMarker;
    } else {
      sourceDetection =
        "COMMENT_MARKER";
    }
  }

  return {
    relbase_document_id:
      relbaseDocumentId,
    laminatiword_tax_document_id:
      localDocument
        ?.laminatiword_tax_document_id ||
      null,
    order_id:
      localDocument?.order_id || null,
    source_system:
      sourceSystem,
    source_detection:
      sourceDetection,
    document_type:
      SUPPORTED_TYPES[typeDocument],
    sii_code:
      typeDocument,
    folio:
      toOptionalString(
        record?.folio
      ),
    relbase_customer_id:
      toOptionalString(
        record?.customer_id
      ),
    track_id:
      toOptionalString(
        record?.track_id
      ),
    net_amount:
      resolveAmount(
        record,
        "real_amount_neto",
        "amount_neto"
      ),
    exempt_amount:
      resolveAmount(
        record,
        "real_amount_exempt",
        "amount_exempt"
      ),
    tax_amount:
      resolveAmount(
        record,
        "real_amount_iva",
        "amount_iva"
      ),
    total_amount:
      resolveAmount(
        record,
        "real_amount_total",
        "amount_total"
      ),
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
    comment,
    issued_at:
      toOptionalString(
        record?.created_at ||
          record?.start_date
      ),
    order_number:
      localDocument?.order_number ||
      markerOrderNumber ||
      null,
  };
};

const persistHistoryPage = async ({
  typeDocument,
  records,
}) => {
  const localMatches =
    await loadLocalMatches({
      typeDocument,
      records,
    });

  const documents = records
    .map((record) =>
      normalizeHistoryRecord({
        record,
        typeDocument,
        localMatches,
      })
    )
    .filter(Boolean);

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    for (const document of documents) {
      await client.query(
        `
          INSERT INTO relbase_dte_history (
            relbase_document_id,
            laminatiword_tax_document_id,
            order_id,
            source_system,
            document_type,
            sii_code,
            folio,
            customer_name,
            customer_rut,
            net_amount,
            exempt_amount,
            tax_amount,
            total_amount,
            relbase_status,
            sii_status,
            sii_status_name,
            comment,
            issued_at,
            relbase_customer_id,
            track_id,
            source_detection,
            first_seen_at,
            last_synced_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            NULL, NULL,
            $8, $9, $10, $11, $12, $13, $14,
            $15, $16, $17, $18, $19,
            NOW(), NOW()
          )
          ON CONFLICT (relbase_document_id)
          DO UPDATE SET
            laminatiword_tax_document_id =
              EXCLUDED.laminatiword_tax_document_id,
            order_id = EXCLUDED.order_id,
            source_system = EXCLUDED.source_system,
            document_type = EXCLUDED.document_type,
            sii_code = EXCLUDED.sii_code,
            folio = EXCLUDED.folio,
            net_amount = EXCLUDED.net_amount,
            exempt_amount = EXCLUDED.exempt_amount,
            tax_amount = EXCLUDED.tax_amount,
            total_amount = EXCLUDED.total_amount,
            relbase_status = EXCLUDED.relbase_status,
            sii_status = EXCLUDED.sii_status,
            sii_status_name = EXCLUDED.sii_status_name,
            comment = EXCLUDED.comment,
            issued_at = EXCLUDED.issued_at,
            relbase_customer_id = EXCLUDED.relbase_customer_id,
            track_id = EXCLUDED.track_id,
            source_detection = EXCLUDED.source_detection,
            last_synced_at = NOW()
        `,
        [
          document.relbase_document_id,
          document.laminatiword_tax_document_id,
          document.order_id,
          document.source_system,
          document.document_type,
          document.sii_code,
          document.folio,
          document.net_amount,
          document.exempt_amount,
          document.tax_amount,
          document.total_amount,
          document.relbase_status,
          document.sii_status,
          document.sii_status_name,
          document.comment,
          document.issued_at,
          document.relbase_customer_id,
          document.track_id,
          document.source_detection,
        ]
      );
    }

    await client.query("COMMIT");

    return documents;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const ensureSyncState = async (
  typeDocument
) => {
  await pool.query(
    `
      INSERT INTO relbase_dte_sync_state (
        document_type,
        next_page
      )
      VALUES ($1, 1)
      ON CONFLICT (document_type)
      DO NOTHING
    `,
    [typeDocument]
  );
};

const readSyncState = async (
  typeDocument
) => {
  const result = await pool.query(
    `
      SELECT
        document_type,
        next_page,
        total_pages,
        total_count,
        completed_at,
        last_started_at,
        last_success_at,
        last_error,
        updated_at
      FROM relbase_dte_sync_state
      WHERE document_type = $1
      LIMIT 1
    `,
    [typeDocument]
  );

  return result.rows[0] || null;
};

const markSyncStart = async (
  typeDocument
) => {
  await pool.query(
    `
      UPDATE relbase_dte_sync_state
      SET
        last_started_at = NOW(),
        last_error = NULL,
        updated_at = NOW()
      WHERE document_type = $1
    `,
    [typeDocument]
  );
};

const markSyncPageSuccess = async ({
  typeDocument,
  nextPage,
  totalPages,
  totalCount,
  completed,
}) => {
  await pool.query(
    `
      UPDATE relbase_dte_sync_state
      SET
        next_page = $2,
        total_pages = $3,
        total_count = $4,
        completed_at =
          CASE
            WHEN $5::boolean
              THEN COALESCE(completed_at, NOW())
            ELSE NULL
          END,
        last_success_at = NOW(),
        last_error = NULL,
        updated_at = NOW()
      WHERE document_type = $1
    `,
    [
      typeDocument,
      nextPage,
      totalPages,
      totalCount,
      completed,
    ]
  );
};

const markSyncError = async (
  typeDocument,
  error
) => {
  await pool.query(
    `
      UPDATE relbase_dte_sync_state
      SET
        last_error = $2,
        updated_at = NOW()
      WHERE document_type = $1
    `,
    [
      typeDocument,
      String(
        error?.message ||
          "Error desconocido"
      ).slice(0, 4000),
    ]
  );
};

export const getRelbaseDteHistorySyncState =
  async () => {
    const result = await pool.query(
      `
        SELECT
          document_type,
          next_page,
          total_pages,
          total_count,
          completed_at,
          last_started_at,
          last_success_at,
          last_error,
          updated_at
        FROM relbase_dte_sync_state
        ORDER BY document_type
      `
    );

    return result.rows;
  };

export const syncRelbaseDteHistory =
  async ({
    typeDocument,
    maxPages = 25,
  }) => {
    const normalizedType =
      Number(typeDocument);

    if (
      !Object.prototype.hasOwnProperty.call(
        SUPPORTED_TYPES,
        normalizedType
      )
    ) {
      throw createServiceError(
        "type_document debe ser 33 (FACTURA) o 39 (BOLETA)",
        400,
        "INVALID_DTE_HISTORY_SYNC_TYPE"
      );
    }

    const normalizedMaxPages =
      Number(maxPages);

    if (
      !Number.isInteger(
        normalizedMaxPages
      ) ||
      normalizedMaxPages < 1 ||
      normalizedMaxPages > 100
    ) {
      throw createServiceError(
        "max_pages debe ser un entero entre 1 y 100",
        400,
        "INVALID_DTE_HISTORY_SYNC_MAX_PAGES"
      );
    }

    await ensureSyncState(
      normalizedType
    );

    let state =
      await readSyncState(
        normalizedType
      );

    if (state?.completed_at) {
      return {
        already_completed: true,
        type_document:
          normalizedType,
        document_type:
          SUPPORTED_TYPES[
            normalizedType
          ],
        pages_processed: 0,
        documents_persisted: 0,
        relbase_requests: 0,
        rate_limit_stop: false,
        state,
      };
    }

    await markSyncStart(
      normalizedType
    );

    const startedPage =
      Number(state?.next_page || 1);

    let currentPage = startedPage;
    let pagesProcessed = 0;
    let documentsPersisted = 0;
    let laminatiwordCount = 0;
    let relbaseCount = 0;
    let lastRateLimit = null;
    let rateLimitStop = false;
    const pageResults = [];

    try {
      while (
        pagesProcessed <
        normalizedMaxPages
      ) {
        const endpoint =
          `/api/v2/dtes?type_document=${encodeURIComponent(
            normalizedType
          )}&page=${encodeURIComponent(
            currentPage
          )}`;

        const result = await relbaseRequest(
          endpoint,
          {
            method: "GET",
          }
        );

        lastRateLimit =
          result?.rateLimit || null;

        const parsed =
          parseDteListPayload(
            result?.data || null,
            normalizedType,
            currentPage
          );

        const meta = parsed.meta || {};

        const totalPages =
          Number(meta.total_pages) ||
          state?.total_pages ||
          currentPage;

        const totalCount =
          Number(meta.total_count) ||
          state?.total_count ||
          null;

        const persistedDocuments =
          await persistHistoryPage({
            typeDocument:
              normalizedType,
            records: parsed.records,
          });

        documentsPersisted +=
          persistedDocuments.length;

        laminatiwordCount +=
          persistedDocuments.filter(
            (item) =>
              item.source_system ===
              "LAMINATIWORD"
          ).length;

        relbaseCount +=
          persistedDocuments.filter(
            (item) =>
              item.source_system ===
              "RELBASE"
          ).length;

        pagesProcessed += 1;

        const completed =
          currentPage >= totalPages ||
          parsed.records.length === 0;

        const nextPage =
          completed
            ? Math.max(
                currentPage + 1,
                totalPages + 1
              )
            : currentPage + 1;

        await markSyncPageSuccess({
          typeDocument:
            normalizedType,
          nextPage,
          totalPages,
          totalCount,
          completed,
        });

        pageResults.push({
          page: currentPage,
          records:
            parsed.records.length,
          persisted:
            persistedDocuments.length,
          total_pages:
            totalPages,
          total_count:
            totalCount,
          collection_path:
            parsed.collectionPath,
        });

        state =
          await readSyncState(
            normalizedType
          );

        if (completed) {
          break;
        }

        const remaining = Number(
          lastRateLimit?.remaining
        );

        if (
          Number.isFinite(remaining) &&
          remaining <=
            RATE_LIMIT_SAFETY_REMAINING
        ) {
          rateLimitStop = true;
          break;
        }

        currentPage = nextPage;
      }

      return {
        already_completed: false,
        type_document:
          normalizedType,
        document_type:
          SUPPORTED_TYPES[
            normalizedType
          ],
        started_page:
          startedPage,
        pages_processed:
          pagesProcessed,
        documents_persisted:
          documentsPersisted,
        laminatiword:
          laminatiwordCount,
        relbase:
          relbaseCount,
        relbase_requests:
          pagesProcessed,
        rate_limit_stop:
          rateLimitStop,
        last_rate_limit:
          lastRateLimit,
        pages:
          pageResults,
        state:
          await readSyncState(
            normalizedType
          ),
      };
    } catch (error) {
      await markSyncError(
        normalizedType,
        error
      );

      throw error;
    }
  };



/* =========================================
   ENRIQUECIMIENTO CLIENTES HISTÓRICO DTE
   FASE 5.1

   Objetivo:
   - Leer clientes desde Relbase con GET.
   - Vincular por relbase_customer_id.
   - Completar customer_name / customer_rut
     sólo cuando estén vacíos.
   - Mantener checkpoint independiente.
   - NO emite DTE.
   - NO escribe en Relbase.
========================================= */

const ensureCustomerHistorySyncState = async () => {
  await pool.query(
    `
      INSERT INTO relbase_customer_sync_state (
        id,
        next_page
      )
      VALUES (1, 1)
      ON CONFLICT (id)
      DO NOTHING
    `
  );
};

const readCustomerHistorySyncState = async () => {
  const result = await pool.query(
    `
      SELECT
        id,
        next_page,
        total_pages,
        total_count,
        completed_at,
        last_started_at,
        last_success_at,
        last_error,
        updated_at
      FROM relbase_customer_sync_state
      WHERE id = 1
      LIMIT 1
    `
  );

  return result.rows[0] || null;
};

const markCustomerHistorySyncStart = async () => {
  await pool.query(
    `
      UPDATE relbase_customer_sync_state
      SET
        last_started_at = NOW(),
        last_error = NULL,
        updated_at = NOW()
      WHERE id = 1
    `
  );
};

const markCustomerHistorySyncPageSuccess = async ({
  nextPage,
  totalPages,
  totalCount,
  completed,
}) => {
  await pool.query(
    `
      UPDATE relbase_customer_sync_state
      SET
        next_page = $1,
        total_pages = $2,
        total_count = $3,
        completed_at = CASE
          WHEN $4::boolean THEN COALESCE(completed_at, NOW())
          ELSE NULL
        END,
        last_success_at = NOW(),
        last_error = NULL,
        updated_at = NOW()
      WHERE id = 1
    `,
    [
      nextPage,
      totalPages,
      totalCount,
      completed,
    ]
  );
};

const markCustomerHistorySyncError = async (error) => {
  await pool.query(
    `
      UPDATE relbase_customer_sync_state
      SET
        last_error = $1,
        updated_at = NOW()
      WHERE id = 1
    `,
    [
      String(
        error?.message ||
          "Error desconocido"
      ).slice(0, 4000),
    ]
  );
};

const parseRelbaseCustomersPayload = (
  payload,
  page
) => {
  const customers =
    payload?.data?.customers;

  if (!Array.isArray(customers)) {
    throw createServiceError(
      `Relbase respondió un formato de clientes inesperado en página ${page}`,
      502,
      "RELBASE_CUSTOMER_HISTORY_PAYLOAD_INVALID"
    );
  }

  return {
    customers,
    meta: payload?.meta || {},
  };
};

const enrichHistoryWithCustomerPage = async (
  customers
) => {
  const client = await pool.connect();

  let customersMatched = 0;
  let documentsEnriched = 0;

  try {
    await client.query("BEGIN");

    for (const customer of customers) {
      const customerId =
        toOptionalString(customer?.id);

      if (!customerId) {
        continue;
      }

      const customerName =
        toOptionalString(customer?.name);

      const customerRut =
        toOptionalString(customer?.rut);

      if (!customerName && !customerRut) {
        continue;
      }

      const result = await client.query(
        `
          UPDATE relbase_dte_history
          SET
            customer_name = CASE
              WHEN NULLIF(BTRIM(customer_name), '') IS NULL
                THEN $2
              ELSE customer_name
            END,
            customer_rut = CASE
              WHEN NULLIF(BTRIM(customer_rut), '') IS NULL
                THEN $3
              ELSE customer_rut
            END
          WHERE
            relbase_customer_id = $1
            AND (
              NULLIF(BTRIM(customer_name), '') IS NULL
              OR NULLIF(BTRIM(customer_rut), '') IS NULL
            )
          RETURNING id
        `,
        [
          customerId,
          customerName,
          customerRut,
        ]
      );

      if (result.rowCount > 0) {
        customersMatched += 1;
        documentsEnriched +=
          result.rowCount;
      }
    }

    await client.query("COMMIT");

    return {
      customers_matched:
        customersMatched,
      documents_enriched:
        documentsEnriched,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getRelbaseDteHistoryCustomerSyncState =
  async () => {
    await ensureCustomerHistorySyncState();
    return readCustomerHistorySyncState();
  };

export const syncRelbaseDteHistoryCustomers =
  async ({ maxPages = 25 } = {}) => {
    const normalizedMaxPages =
      Number(maxPages);

    if (
      !Number.isInteger(normalizedMaxPages) ||
      normalizedMaxPages < 1 ||
      normalizedMaxPages > 50
    ) {
      throw createServiceError(
        "max_pages debe ser un entero entre 1 y 50",
        400,
        "INVALID_RELBASE_CUSTOMER_HISTORY_MAX_PAGES"
      );
    }

    await ensureCustomerHistorySyncState();

    let state =
      await readCustomerHistorySyncState();

    if (state?.completed_at) {
      return {
        already_completed: true,
        started_page:
          Number(state.next_page || 1),
        pages_processed: 0,
        customers_seen: 0,
        customers_matched: 0,
        documents_enriched: 0,
        relbase_requests: 0,
        rate_limit_stop: false,
        state,
      };
    }

    await markCustomerHistorySyncStart();

    const startedPage =
      Number(state?.next_page || 1);

    let currentPage = startedPage;
    let pagesProcessed = 0;
    let customersSeen = 0;
    let customersMatched = 0;
    let documentsEnriched = 0;
    let lastRateLimit = null;
    let rateLimitStop = false;
    const pageResults = [];

    try {
      while (
        pagesProcessed < normalizedMaxPages
      ) {
        const params = new URLSearchParams({
          page: String(currentPage),
          per_page: "100",
          customer_status_query: "all",
        });

        const result = await relbaseRequest(
          `/api/v2/clientes?${params.toString()}`,
          {
            method: "GET",
          }
        );

        lastRateLimit =
          result?.rateLimit || null;

        const parsed =
          parseRelbaseCustomersPayload(
            result?.data || null,
            currentPage
          );

        const meta = parsed.meta || {};

        const totalPages =
          Number(meta.total_pages) ||
          state?.total_pages ||
          currentPage;

        const totalCount =
          Number(meta.total_count) ||
          state?.total_count ||
          null;

        const enrichment =
          await enrichHistoryWithCustomerPage(
            parsed.customers
          );

        pagesProcessed += 1;
        customersSeen +=
          parsed.customers.length;
        customersMatched +=
          enrichment.customers_matched;
        documentsEnriched +=
          enrichment.documents_enriched;

        const completed =
          currentPage >= totalPages ||
          parsed.customers.length === 0;

        const nextPage =
          completed
            ? Math.max(
                currentPage + 1,
                totalPages + 1
              )
            : currentPage + 1;

        await markCustomerHistorySyncPageSuccess({
          nextPage,
          totalPages,
          totalCount,
          completed,
        });

        pageResults.push({
          page: currentPage,
          customers:
            parsed.customers.length,
          customers_matched:
            enrichment.customers_matched,
          documents_enriched:
            enrichment.documents_enriched,
          total_pages:
            totalPages,
          total_count:
            totalCount,
        });

        state =
          await readCustomerHistorySyncState();

        if (completed) {
          break;
        }

        const remaining = Number(
          lastRateLimit?.remaining
        );

        if (
          Number.isFinite(remaining) &&
          remaining <=
            RATE_LIMIT_SAFETY_REMAINING
        ) {
          rateLimitStop = true;
          break;
        }

        currentPage = nextPage;
      }

      return {
        already_completed: false,
        started_page:
          startedPage,
        pages_processed:
          pagesProcessed,
        customers_seen:
          customersSeen,
        customers_matched:
          customersMatched,
        documents_enriched:
          documentsEnriched,
        relbase_requests:
          pagesProcessed,
        rate_limit_stop:
          rateLimitStop,
        last_rate_limit:
          lastRateLimit,
        pages:
          pageResults,
        state:
          await readCustomerHistorySyncState(),
      };
    } catch (error) {
      await markCustomerHistorySyncError(
        error
      );
      throw error;
    }
  };


/* =========================================
   CONSULTA HISTÓRICA DTE - FASE 4

   Estas funciones leen exclusivamente desde
   PostgreSQL. No realizan solicitudes hacia
   Relbase y no modifican la emisión DTE.
========================================= */

const HISTORY_DOCUMENT_TYPES = new Set([
  "FACTURA",
  "BOLETA",
]);

const HISTORY_SOURCE_SYSTEMS = new Set([
  "LAMINATIWORD",
  "RELBASE",
]);

const toHistoryMoney = (value) => {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const normalized = Number(value);

  return Number.isFinite(normalized)
    ? normalized
    : null;
};

const normalizeHistoryDate = (
  value,
  fieldName
) => {
  const normalized =
    toOptionalString(value);

  if (!normalized) {
    return null;
  }

  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})$/
  );

  if (!match) {
    throw createServiceError(
      `${fieldName} debe usar formato YYYY-MM-DD`,
      400,
      "INVALID_DTE_HISTORY_DATE"
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(
    Date.UTC(year, month - 1, day)
  );

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw createServiceError(
      `${fieldName} no contiene una fecha válida`,
      400,
      "INVALID_DTE_HISTORY_DATE"
    );
  }

  return normalized;
};

const normalizeHistoryFilters = ({
  documentType,
  sourceSystem,
  siiStatus,
  relbaseStatus,
  from,
  to,
  search,
} = {}) => {
  const normalizedDocumentType =
    toOptionalString(documentType)
      ?.toUpperCase() || null;

  if (
    normalizedDocumentType &&
    !HISTORY_DOCUMENT_TYPES.has(
      normalizedDocumentType
    )
  ) {
    throw createServiceError(
      "document_type debe ser FACTURA o BOLETA",
      400,
      "INVALID_DTE_HISTORY_DOCUMENT_TYPE"
    );
  }

  const normalizedSourceSystem =
    toOptionalString(sourceSystem)
      ?.toUpperCase() || null;

  if (
    normalizedSourceSystem &&
    !HISTORY_SOURCE_SYSTEMS.has(
      normalizedSourceSystem
    )
  ) {
    throw createServiceError(
      "source_system debe ser LAMINATIWORD o RELBASE",
      400,
      "INVALID_DTE_HISTORY_SOURCE_SYSTEM"
    );
  }

  const normalizedSearch =
    toOptionalString(search);

  if (
    normalizedSearch &&
    normalizedSearch.length > 120
  ) {
    throw createServiceError(
      "search no puede superar 120 caracteres",
      400,
      "INVALID_DTE_HISTORY_SEARCH"
    );
  }

  const normalizedFrom =
    normalizeHistoryDate(
      from,
      "from"
    );

  const normalizedTo =
    normalizeHistoryDate(
      to,
      "to"
    );

  if (
    normalizedFrom &&
    normalizedTo &&
    normalizedFrom > normalizedTo
  ) {
    throw createServiceError(
      "from no puede ser posterior a to",
      400,
      "INVALID_DTE_HISTORY_DATE_RANGE"
    );
  }

  return {
    documentType:
      normalizedDocumentType,
    sourceSystem:
      normalizedSourceSystem,
    siiStatus:
      toOptionalString(siiStatus),
    relbaseStatus:
      toOptionalString(relbaseStatus),
    from:
      normalizedFrom,
    to:
      normalizedTo,
    search:
      normalizedSearch,
  };
};

const buildHistoryWhere = (
  filters,
  startIndex = 1
) => {
  const clauses = [];
  const values = [];

  const addValue = (value) => {
    values.push(value);
    return `$${startIndex + values.length - 1}`;
  };

  if (filters.documentType) {
    const placeholder = addValue(
      filters.documentType
    );
    clauses.push(
      `h.document_type = ${placeholder}`
    );
  }

  if (filters.sourceSystem) {
    const placeholder = addValue(
      filters.sourceSystem
    );
    clauses.push(
      `h.source_system = ${placeholder}`
    );
  }

  if (filters.siiStatus) {
    const placeholder = addValue(
      filters.siiStatus
    );
    clauses.push(
      `LOWER(COALESCE(h.sii_status, '')) = LOWER(${placeholder})`
    );
  }

  if (filters.relbaseStatus) {
    const placeholder = addValue(
      filters.relbaseStatus
    );
    clauses.push(
      `LOWER(COALESCE(h.relbase_status, '')) = LOWER(${placeholder})`
    );
  }

  if (filters.from) {
    const placeholder = addValue(
      filters.from
    );
    clauses.push(
      `h.issued_at >= ${placeholder}::date`
    );
  }

  if (filters.to) {
    const placeholder = addValue(
      filters.to
    );
    clauses.push(
      `h.issued_at < (${placeholder}::date + INTERVAL '1 day')`
    );
  }

  if (filters.search) {
    const placeholder = addValue(
      `%${filters.search}%`
    );

    const normalizedRutSearch =
      String(filters.search)
        .toUpperCase()
        .replace(/[^0-9K]/g, "");

    let normalizedRutClause = "";

    if (
      /^[0-9]{7,8}[0-9K]$/.test(
        normalizedRutSearch
      )
    ) {
      const rutPlaceholder = addValue(
        `%${normalizedRutSearch}%`
      );

      normalizedRutClause = `
        OR REGEXP_REPLACE(
          UPPER(COALESCE(h.customer_rut, '')),
          '[^0-9K]',
          '',
          'g'
        ) LIKE ${rutPlaceholder}
        OR REGEXP_REPLACE(
          UPPER(COALESCE(obd.rut, '')),
          '[^0-9K]',
          '',
          'g'
        ) LIKE ${rutPlaceholder}
      `;
    }

    /*
     * Buscador administrativo orientado a datos visibles:
     * folio, cliente, RUT y número de orden Laminatiword.
     *
     * El RUT también se compara normalizado, por lo que:
     * 22.211.294-K / 22211294-K / 22211294K son equivalentes.
     *
     * No incluimos IDs técnicos de Relbase, track_id ni comment.
     */
    clauses.push(`(
      COALESCE(h.folio, '') ILIKE ${placeholder}
      OR COALESCE(h.customer_name, '') ILIKE ${placeholder}
      OR COALESCE(h.customer_rut, '') ILIKE ${placeholder}
      OR COALESCE(obd.legal_name, '') ILIKE ${placeholder}
      OR COALESCE(obd.trade_name, '') ILIKE ${placeholder}
      OR COALESCE(obd.rut, '') ILIKE ${placeholder}
      OR COALESCE(o.order_number, '') ILIKE ${placeholder}
      ${normalizedRutClause}
    )`);
  }

  return {
    sql:
      clauses.length > 0
        ? `WHERE ${clauses.join(" AND ")}`
        : "",
    values,
  };
};

const HISTORY_SELECT = `
  SELECT
    h.id,
    h.relbase_document_id,
    h.laminatiword_tax_document_id,
    h.order_id,
    h.source_system,
    h.source_detection,
    h.document_type,
    h.sii_code,
    h.folio,
    h.relbase_customer_id,
    COALESCE(
      NULLIF(h.customer_name, ''),
      NULLIF(obd.legal_name, ''),
      NULLIF(obd.trade_name, '')
    ) AS customer_name,
    COALESCE(
      NULLIF(h.customer_rut, ''),
      NULLIF(obd.rut, '')
    ) AS customer_rut,
    h.net_amount,
    h.exempt_amount,
    h.tax_amount,
    h.total_amount,
    h.relbase_status,
    h.sii_status,
    h.sii_status_name,
    h.comment,
    h.track_id,
    h.issued_at,
    h.first_seen_at,
    h.last_synced_at,
    o.order_number,
    td.status AS local_tax_document_status,
    td.folio AS local_tax_document_folio
  FROM relbase_dte_history h
  LEFT JOIN orders o
    ON o.id = h.order_id
  LEFT JOIN tax_documents td
    ON td.id = h.laminatiword_tax_document_id
  LEFT JOIN order_billing_data obd
    ON obd.order_id = h.order_id
`;

const serializeHistoryRow = (row) => ({
  id: row.id,
  relbase_document_id:
    row.relbase_document_id,
  laminatiword_tax_document_id:
    row.laminatiword_tax_document_id,
  order_id: row.order_id,
  order_number:
    row.order_number || null,
  source_system:
    row.source_system,
  source_detection:
    row.source_detection || null,
  document_type:
    row.document_type,
  sii_code:
    row.sii_code === null ||
    row.sii_code === undefined
      ? null
      : Number(row.sii_code),
  folio: row.folio,
  relbase_customer_id:
    row.relbase_customer_id || null,
  customer_name:
    row.customer_name || null,
  customer_rut:
    row.customer_rut || null,
  net_amount:
    toHistoryMoney(row.net_amount),
  exempt_amount:
    toHistoryMoney(row.exempt_amount),
  tax_amount:
    toHistoryMoney(row.tax_amount),
  total_amount:
    toHistoryMoney(row.total_amount),
  relbase_status:
    row.relbase_status || null,
  sii_status:
    row.sii_status || null,
  sii_status_name:
    row.sii_status_name || null,
  comment:
    row.comment || null,
  track_id:
    row.track_id || null,
  issued_at:
    row.issued_at || null,
  first_seen_at:
    row.first_seen_at || null,
  last_synced_at:
    row.last_synced_at || null,
  local_tax_document_status:
    row.local_tax_document_status || null,
  local_tax_document_folio:
    row.local_tax_document_folio || null,
});

export const listRelbaseDteHistory =
  async ({
    page = 1,
    limit = 50,
    documentType = null,
    sourceSystem = null,
    siiStatus = null,
    relbaseStatus = null,
    from = null,
    to = null,
    search = null,
  } = {}) => {
    const normalizedPage = Number(page);
    const normalizedLimit = Number(limit);

    if (
      !Number.isInteger(normalizedPage) ||
      normalizedPage < 1
    ) {
      throw createServiceError(
        "page debe ser un entero mayor o igual a 1",
        400,
        "INVALID_DTE_HISTORY_PAGE"
      );
    }

    if (
      !Number.isInteger(normalizedLimit) ||
      normalizedLimit < 1 ||
      normalizedLimit > 100
    ) {
      throw createServiceError(
        "limit debe ser un entero entre 1 y 100",
        400,
        "INVALID_DTE_HISTORY_LIMIT"
      );
    }

    const filters =
      normalizeHistoryFilters({
        documentType,
        sourceSystem,
        siiStatus,
        relbaseStatus,
        from,
        to,
        search,
      });

    const where =
      buildHistoryWhere(filters);

    const countResult =
      await pool.query(
        `
          SELECT COUNT(*)::integer AS total
          FROM relbase_dte_history h
          LEFT JOIN orders o
            ON o.id = h.order_id
          LEFT JOIN order_billing_data obd
            ON obd.order_id = h.order_id
          ${where.sql}
        `,
        where.values
      );

    const total = Number(
      countResult.rows[0]?.total || 0
    );

    const limitPlaceholder =
      `$${where.values.length + 1}`;
    const offsetPlaceholder =
      `$${where.values.length + 2}`;

    const offset =
      (normalizedPage - 1) *
      normalizedLimit;

    const result = await pool.query(
      `
        ${HISTORY_SELECT}
        ${where.sql}
        ORDER BY
          h.issued_at DESC NULLS LAST,
          h.first_seen_at DESC NULLS LAST,
          h.id DESC
        LIMIT ${limitPlaceholder}
        OFFSET ${offsetPlaceholder}
      `,
      [
        ...where.values,
        normalizedLimit,
        offset,
      ]
    );

    return {
      documents:
        result.rows.map(
          serializeHistoryRow
        ),
      pagination: {
        page: normalizedPage,
        limit: normalizedLimit,
        total,
        total_pages:
          total === 0
            ? 0
            : Math.ceil(
                total /
                  normalizedLimit
              ),
      },
      filters: {
        document_type:
          filters.documentType,
        source_system:
          filters.sourceSystem,
        sii_status:
          filters.siiStatus,
        relbase_status:
          filters.relbaseStatus,
        from: filters.from,
        to: filters.to,
        search: filters.search,
      },
    };
  };

export const getRelbaseDteHistorySummary =
  async ({
    documentType = null,
    sourceSystem = null,
    siiStatus = null,
    relbaseStatus = null,
    from = null,
    to = null,
    search = null,
  } = {}) => {
    const filters =
      normalizeHistoryFilters({
        documentType,
        sourceSystem,
        siiStatus,
        relbaseStatus,
        from,
        to,
        search,
      });

    const where =
      buildHistoryWhere(filters);

    const result = await pool.query(
      `
        SELECT
          COUNT(*)::integer AS total_documents,
          COUNT(*) FILTER (
            WHERE h.document_type = 'FACTURA'
          )::integer AS facturas,
          COUNT(*) FILTER (
            WHERE h.document_type = 'BOLETA'
          )::integer AS boletas,
          COUNT(*) FILTER (
            WHERE h.source_system = 'LAMINATIWORD'
          )::integer AS laminatiword,
          COUNT(*) FILTER (
            WHERE h.source_system = 'RELBASE'
          )::integer AS relbase,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(h.sii_status, '')) = 'accepted'
          )::integer AS sii_accepted,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(h.sii_status, '')) IN ('cancel', 'cancelled')
          )::integer AS sii_cancelled,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(h.sii_status, '')) = 'rejected'
          )::integer AS sii_rejected,
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(h.sii_status, '')) = 'pending'
          )::integer AS sii_pending,
          COALESCE(SUM(h.net_amount), 0) AS net_amount,
          COALESCE(SUM(h.exempt_amount), 0) AS exempt_amount,
          COALESCE(SUM(h.tax_amount), 0) AS tax_amount,
          COALESCE(SUM(h.total_amount), 0) AS total_amount,
          MIN(h.issued_at) AS first_issued_at,
          MAX(h.issued_at) AS last_issued_at
        FROM relbase_dte_history h
        LEFT JOIN orders o
          ON o.id = h.order_id
        LEFT JOIN order_billing_data obd
          ON obd.order_id = h.order_id
        ${where.sql}
      `,
      where.values
    );

    const row = result.rows[0] || {};

    return {
      total_documents:
        Number(row.total_documents || 0),
      facturas:
        Number(row.facturas || 0),
      boletas:
        Number(row.boletas || 0),
      laminatiword:
        Number(row.laminatiword || 0),
      relbase:
        Number(row.relbase || 0),
      sii: {
        accepted:
          Number(row.sii_accepted || 0),
        cancelled:
          Number(row.sii_cancelled || 0),
        rejected:
          Number(row.sii_rejected || 0),
        pending:
          Number(row.sii_pending || 0),
      },
      amounts: {
        net:
          toHistoryMoney(
            row.net_amount
          ) || 0,
        exempt:
          toHistoryMoney(
            row.exempt_amount
          ) || 0,
        tax:
          toHistoryMoney(
            row.tax_amount
          ) || 0,
        total:
          toHistoryMoney(
            row.total_amount
          ) || 0,
      },
      first_issued_at:
        row.first_issued_at || null,
      last_issued_at:
        row.last_issued_at || null,
      filters: {
        document_type:
          filters.documentType,
        source_system:
          filters.sourceSystem,
        sii_status:
          filters.siiStatus,
        relbase_status:
          filters.relbaseStatus,
        from: filters.from,
        to: filters.to,
        search: filters.search,
      },
    };
  };

export const getRelbaseDteHistoryDetail =
  async (id) => {
    const normalizedId =
      toOptionalString(id);

    if (!normalizedId) {
      throw createServiceError(
        "Se requiere el identificador del documento histórico",
        400,
        "DTE_HISTORY_ID_REQUIRED"
      );
    }

    if (normalizedId.length > 120) {
      throw createServiceError(
        "El identificador del documento histórico no es válido",
        400,
        "INVALID_DTE_HISTORY_ID"
      );
    }

    const result = await pool.query(
      `
        ${HISTORY_SELECT}
        WHERE
          h.id::text = $1
          OR h.relbase_document_id = $1
        LIMIT 1
      `,
      [normalizedId]
    );

    if (result.rowCount === 0) {
      throw createServiceError(
        "Documento tributario histórico no encontrado",
        404,
        "DTE_HISTORY_NOT_FOUND"
      );
    }

    return serializeHistoryRow(
      result.rows[0]
    );
  };
