import crypto from "crypto";

import pool from "../config/database.js";

import {
  relbaseRequest,
} from "./relbase.service.js";

import {
  normalizeRelbaseDteRecord,
  normalizeRelbaseHttpUrl,
  isRelbaseHttpUrlUsable,
  persistRelbaseDteResult,
} from "./relbaseDteSync.service.js";

import {
  buildRelbaseDteLetterPdfBuffer,
} from "./relbaseDteLetterPdf.service.js";

const DOCUMENT_ACCESS_PREFIX =
  "LWDT1_";

const DEFAULT_TTL_DAYS =
  90;

const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 365;

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

const resolveRequestedDocumentFormat = ({
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
        "La representación Carta / A4 sólo está disponible para facturas",
        409,
        "CUSTOMER_DOCUMENT_FORMAT_NOT_ALLOWED"
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
    "CUSTOMER_DOCUMENT_FORMAT_INVALID"
  );
};

const getDocumentAccessSecret =
  () => {
    const secret =
      cleanText(
        process.env
          .CUSTOMER_DOCUMENT_ACCESS_SECRET
      );

    if (
      secret.length < 32
    ) {
      throw createServiceError(
        "CUSTOMER_DOCUMENT_ACCESS_SECRET no se encuentra configurado correctamente",
        500,
        "CUSTOMER_DOCUMENT_ACCESS_SECRET_NOT_CONFIGURED"
      );
    }

    return secret;
  };

const resolveTtlDays = () => {
  const parsed =
    Number(
      process.env
        .CUSTOMER_DOCUMENT_ACCESS_TTL_DAYS ||
        DEFAULT_TTL_DAYS
    );

  if (
    !Number.isFinite(
      parsed
    )
  ) {
    return DEFAULT_TTL_DAYS;
  }

  return Math.min(
    Math.max(
      Math.trunc(parsed),
      MIN_TTL_DAYS
    ),
    MAX_TTL_DAYS
  );
};

const buildExpiryDate = () =>
  new Date(
    Date.now() +
      resolveTtlDays() *
        24 *
        60 *
        60 *
        1000
  );

const hashCredential = (
  credential
) =>
  crypto
    .createHash("sha256")
    .update(
      String(
        credential || ""
      ),
      "utf8"
    )
    .digest("hex");

const safeHexHashMatches = (
  expectedHash,
  candidateHash
) => {
  const expected =
    cleanText(
      expectedHash
    ).toLowerCase();

  const candidate =
    cleanText(
      candidateHash
    ).toLowerCase();

  if (
    expected.length !== 64 ||
    candidate.length !== 64
  ) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(
        expected,
        "hex"
      ),
      Buffer.from(
        candidate,
        "hex"
      )
    );
  } catch {
    return false;
  }
};

const buildSignedCredential = (
  accessId,
  createdAt
) => {
  const normalizedAccessId =
    cleanText(
      accessId
    );

  const date =
    createdAt instanceof Date
      ? createdAt
      : new Date(
          createdAt
        );

  if (
    !normalizedAccessId ||
    Number.isNaN(
      date.getTime()
    )
  ) {
    throw createServiceError(
      "No fue posible construir la credencial de acceso al documento",
      500,
      "CUSTOMER_DOCUMENT_ACCESS_CREDENTIAL_BUILD_ERROR"
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
        getDocumentAccessSecret()
      )
      .update(
        `laminatiword:document-access:v1:${normalizedAccessId}:${timestamp}`,
        "utf8"
      )
      .digest("base64url");

  return (
    `${DOCUMENT_ACCESS_PREFIX}` +
    `${normalizedAccessId}.` +
    `${timestampPart}.` +
    `${signature}`
  );
};

export const buildCustomerDocumentAccessCredential = (
  accessRow
) => {
  if (
    !accessRow?.id ||
    !accessRow?.created_at
  ) {
    throw createServiceError(
      "No fue posible reconstruir la credencial de acceso al documento",
      500,
      "CUSTOMER_DOCUMENT_ACCESS_ROW_INVALID"
    );
  }

  return buildSignedCredential(
    accessRow.id,
    accessRow.created_at
  );
};

const normalizeCredential = (
  value
) => {
  const credential =
    cleanText(
      value
    );

  if (
    !credential ||
    credential.length > 220 ||
    !credential.startsWith(
      DOCUMENT_ACCESS_PREFIX
    )
  ) {
    throw createServiceError(
      "El enlace del documento tributario no es válido",
      400,
      "CUSTOMER_DOCUMENT_ACCESS_TOKEN_INVALID"
    );
  }

  return credential;
};

const resolveRelbaseDteDetailRecord = (
  payload
) => {
  const data =
    payload?.data ??
    payload ??
    null;

  if (
    !data ||
    typeof data !==
      "object" ||
    Array.isArray(data)
  ) {
    return null;
  }

  if (
    data.dte &&
    typeof data.dte ===
      "object" &&
    !Array.isArray(
      data.dte
    )
  ) {
    return data.dte;
  }

  if (
    data.document &&
    typeof data.document ===
      "object" &&
    !Array.isArray(
      data.document
    )
  ) {
    return data.document;
  }

  return data;
};

const assertAcceptedDocument = (
  row
) => {
  const orderPaymentStatus =
    cleanText(
      row.order_payment_status
    ).toUpperCase();

  const paymentStatus =
    cleanText(
      row.payment_status
    ).toUpperCase();

  const documentStatus =
    cleanText(
      row.tax_document_status
    ).toUpperCase();

  const siiStatus =
    cleanText(
      row.sii_status
    ).toLowerCase();

  if (
    orderPaymentStatus !==
      "PAID" ||
    paymentStatus !==
      "PAID"
  ) {
    throw createServiceError(
      "El pedido no se encuentra pagado",
      409,
      "CUSTOMER_DOCUMENT_ORDER_NOT_PAID"
    );
  }

  if (
    documentStatus !==
      "ACCEPTED" ||
    ![
      "accepted",
      "aceptado",
    ].includes(
      siiStatus
    )
  ) {
    throw createServiceError(
      "El documento tributario todavía no está aceptado por el SII",
      409,
      "CUSTOMER_DOCUMENT_NOT_ACCEPTED"
    );
  }

  if (
    ![
      "BOLETA",
      "FACTURA",
    ].includes(
      cleanText(
        row.document_type
      ).toUpperCase()
    )
  ) {
    throw createServiceError(
      "El tipo de documento tributario no está soportado",
      409,
      "CUSTOMER_DOCUMENT_TYPE_NOT_SUPPORTED"
    );
  }

  if (
    !cleanText(
      row.relbase_document_id
    )
  ) {
    throw createServiceError(
      "El documento tributario no posee identidad externa de Relbase",
      409,
      "CUSTOMER_DOCUMENT_RELBASE_ID_MISSING"
    );
  }
};

export const ensureCustomerDocumentAccessForAcceptedDte =
  async (
    dbClient,
    taxDocumentId
  ) => {
    const db =
      dbClient ||
      pool;

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
        "CUSTOMER_DOCUMENT_TAX_DOCUMENT_ID_REQUIRED"
      );
    }

    getDocumentAccessSecret();

    const dteResult =
      await db.query(
        `
          SELECT
            td.id,
            td.order_id,
            td.document_type,
            td.status,
            td.sii_status,
            td.relbase_document_id,
            td.folio,
            td.total_amount,
            o.order_number,
            o.email,
            o.customer_name,
            o.payment_status AS order_payment_status,
            p.status AS payment_status
          FROM tax_documents td
          INNER JOIN orders o
            ON o.id = td.order_id
          INNER JOIN payments p
            ON p.order_id = o.id
          WHERE td.id = $1
          LIMIT 1
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

    assertAcceptedDocument(
      {
        ...dte,
        tax_document_status:
          dte.status,
      }
    );

    let accessResult =
      await db.query(
        `
          SELECT
            id,
            order_id,
            tax_document_id,
            token_hash,
            expires_at,
            revoked_at,
            last_used_at,
            created_at
          FROM customer_document_access_tokens
          WHERE tax_document_id = $1
            AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        `,
        [
          normalizedTaxDocumentId,
        ]
      );

    let created =
      false;

    if (
      accessResult.rowCount ===
      0
    ) {
      const accessId =
        crypto.randomUUID();

      const createdAt =
        new Date();

      const credential =
        buildSignedCredential(
          accessId,
          createdAt
        );

      const tokenHash =
        hashCredential(
          credential
        );

      const expiresAt =
        buildExpiryDate();

      const insertResult =
        await db.query(
          `
            INSERT INTO customer_document_access_tokens (
              id,
              order_id,
              tax_document_id,
              token_hash,
              expires_at,
              revoked_at,
              last_used_at,
              created_at
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              NULL,
              NULL,
              $6
            )
            ON CONFLICT DO NOTHING
            RETURNING
              id,
              order_id,
              tax_document_id,
              token_hash,
              expires_at,
              revoked_at,
              last_used_at,
              created_at
          `,
          [
            accessId,
            dte.order_id,
            normalizedTaxDocumentId,
            tokenHash,
            expiresAt,
            createdAt,
          ]
        );

      if (
        insertResult.rowCount ===
        1
      ) {
        accessResult =
          insertResult;

        created =
          true;
      } else {
        accessResult =
          await db.query(
            `
              SELECT
                id,
                order_id,
                tax_document_id,
                token_hash,
                expires_at,
                revoked_at,
                last_used_at,
                created_at
              FROM customer_document_access_tokens
              WHERE tax_document_id = $1
                AND revoked_at IS NULL
              ORDER BY created_at DESC
              LIMIT 1
              FOR UPDATE
            `,
            [
              normalizedTaxDocumentId,
            ]
          );
      }
    }

    if (
      accessResult.rowCount ===
      0
    ) {
      throw createServiceError(
        "No fue posible asegurar el acceso al documento tributario",
        500,
        "CUSTOMER_DOCUMENT_ACCESS_CREATE_FAILED"
      );
    }

    const access =
      accessResult.rows[0];

    const expiresAt =
      new Date(
        access.expires_at
      );

    if (
      Number.isNaN(
        expiresAt.getTime()
      ) ||
      expiresAt.getTime() <=
        Date.now()
    ) {
      const renewedExpiry =
        buildExpiryDate();

      const renewedResult =
        await db.query(
          `
            UPDATE customer_document_access_tokens
            SET expires_at = $2
            WHERE id = $1
            RETURNING
              id,
              order_id,
              tax_document_id,
              token_hash,
              expires_at,
              revoked_at,
              last_used_at,
              created_at
          `,
          [
            access.id,
            renewedExpiry,
          ]
        );

      accessResult =
        renewedResult;
    }

    const finalAccess =
      accessResult.rows[0];

    const credential =
      buildCustomerDocumentAccessCredential(
        finalAccess
      );

    const candidateHash =
      hashCredential(
        credential
      );

    if (
      !safeHexHashMatches(
        finalAccess.token_hash,
        candidateHash
      )
    ) {
      throw createServiceError(
        "La credencial de acceso al documento no coincide con su hash almacenado",
        500,
        "CUSTOMER_DOCUMENT_ACCESS_HASH_MISMATCH"
      );
    }

    return {
      created,
      credential,
      access: {
        id:
          finalAccess.id,
        order_id:
          finalAccess.order_id,
        tax_document_id:
          finalAccess.tax_document_id,
        expires_at:
          finalAccess.expires_at,
        revoked_at:
          finalAccess.revoked_at,
        last_used_at:
          finalAccess.last_used_at,
        created_at:
          finalAccess.created_at,
      },
      dte,
      security: {
        stored_plaintext_token:
          false,
        stored_hash_algorithm:
          "SHA-256",
        signed_with_hmac:
          true,
        contains_personal_data:
          false,
      },
    };
  };

const getAccessSnapshotByCredential =
  async (
    credential
  ) => {
    const normalizedCredential =
      normalizeCredential(
        credential
      );

    const tokenHash =
      hashCredential(
        normalizedCredential
      );

    const result =
      await pool.query(
        `
          SELECT
            cdat.id AS access_id,
            cdat.order_id,
            cdat.tax_document_id,
            cdat.token_hash,
            cdat.expires_at,
            cdat.revoked_at,
            cdat.last_used_at,
            cdat.created_at AS access_created_at,

            o.order_number,
            o.payment_status AS order_payment_status,
            o.status AS order_status,
            o.total AS order_total,
            o.currency,

            p.status AS payment_status,

            td.document_type,
            td.sii_code,
            td.status AS tax_document_status,
            td.relbase_document_id,
            td.folio,
            td.track_id,
            td.sii_status,
            td.sii_status_name,
            td.total_amount,
            td.pdf_url

          FROM customer_document_access_tokens cdat

          INNER JOIN orders o
            ON o.id = cdat.order_id

          INNER JOIN payments p
            ON p.order_id = o.id

          INNER JOIN tax_documents td
            ON td.id = cdat.tax_document_id

          WHERE cdat.token_hash = $1

          LIMIT 1
        `,
        [
          tokenHash,
        ]
      );

    if (
      result.rowCount ===
      0
    ) {
      throw createServiceError(
        "El enlace del documento tributario no es válido o ya no existe",
        404,
        "CUSTOMER_DOCUMENT_ACCESS_NOT_FOUND"
      );
    }

    const row =
      result.rows[0];

    const rebuiltCredential =
      buildSignedCredential(
        row.access_id,
        row.access_created_at
      );

    if (
      rebuiltCredential !==
        normalizedCredential ||
      !safeHexHashMatches(
        row.token_hash,
        tokenHash
      )
    ) {
      throw createServiceError(
        "El enlace del documento tributario no es válido",
        403,
        "CUSTOMER_DOCUMENT_ACCESS_SIGNATURE_INVALID"
      );
    }

    if (
      row.revoked_at
    ) {
      throw createServiceError(
        "El enlace del documento tributario fue revocado",
        410,
        "CUSTOMER_DOCUMENT_ACCESS_REVOKED"
      );
    }

    const expiresAt =
      new Date(
        row.expires_at
      );

    if (
      Number.isNaN(
        expiresAt.getTime()
      ) ||
      expiresAt.getTime() <=
        Date.now()
    ) {
      throw createServiceError(
        "El enlace del documento tributario expiró",
        410,
        "CUSTOMER_DOCUMENT_ACCESS_EXPIRED"
      );
    }

    if (
      cleanText(
        row.order_status
      ).toUpperCase() ===
      "CANCELLED"
    ) {
      throw createServiceError(
        "El pedido asociado al documento se encuentra cancelado",
        409,
        "CUSTOMER_DOCUMENT_ORDER_CANCELLED"
      );
    }

    assertAcceptedDocument(
      row
    );

    return row;
  };

const validateExternalDteIdentity = (
  row,
  record,
  normalized
) => {
  if (
    cleanText(
      normalized.relbase_document_id
    ) !==
    cleanText(
      row.relbase_document_id
    )
  ) {
    throw createServiceError(
      "El documento obtenido desde Relbase no coincide con el documento autorizado",
      409,
      "CUSTOMER_DOCUMENT_RELBASE_ID_MISMATCH"
    );
  }

  if (
    normalized.type_document !==
      null &&
    Number(
      normalized.type_document
    ) !==
      Number(
        row.sii_code
      )
  ) {
    throw createServiceError(
      "El tipo del documento obtenido desde Relbase no coincide",
      409,
      "CUSTOMER_DOCUMENT_RELBASE_TYPE_MISMATCH"
    );
  }

  if (
    row.folio &&
    normalized.folio &&
    cleanText(
      row.folio
    ) !==
      cleanText(
        normalized.folio
      )
  ) {
    throw createServiceError(
      "El folio del documento obtenido desde Relbase no coincide",
      409,
      "CUSTOMER_DOCUMENT_RELBASE_FOLIO_MISMATCH"
    );
  }

  const localTotal =
    Number(
      row.total_amount
    );

  const externalTotal =
    Number(
      normalized?.amounts?.total
    );

  if (
    Number.isFinite(
      localTotal
    ) &&
    Number.isFinite(
      externalTotal
    ) &&
    Math.abs(
      localTotal -
        externalTotal
    ) > 1
  ) {
    throw createServiceError(
      "El total del documento obtenido desde Relbase no coincide",
      409,
      "CUSTOMER_DOCUMENT_RELBASE_TOTAL_MISMATCH"
    );
  }

  const expectedMarker =
    `Laminatiword ${cleanText(
      row.order_number
    )}`;

  const markers =
    [
      record?.comment,
      record?.label_value,
    ]
      .map(
        (value) =>
          cleanText(
            value
          )
      )
      .filter(Boolean);

  if (
    expectedMarker &&
    markers.length > 0 &&
    !markers.includes(
      expectedMarker
    )
  ) {
    throw createServiceError(
      "El documento obtenido desde Relbase no conserva el marcador esperado de la orden",
      409,
      "CUSTOMER_DOCUMENT_RELBASE_MARKER_MISMATCH"
    );
  }
};

export const resolveCustomerDocumentPdfByCredential =
  async (
    credential,
    {
      format = "",
    } = {}
  ) => {
    const row =
      await getAccessSnapshotByCredential(
        credential
      );

    const resolvedFormat =
      resolveRequestedDocumentFormat({
        value:
          format,
        documentType:
          row.document_type,
      });

    /*
     * CARTA / A4:
     * genera una representación de Laminatiword usando
     * el contrato oficial de impresión de Relbase.
     * No modifica ni reemite el DTE.
     */
    if (
      resolvedFormat ===
      "letter"
    ) {
      const relbaseDocumentId =
        cleanText(
          row.relbase_document_id
        );

      const printEndpoint =
        `/api/v2/dtes/${encodeURIComponent(
          relbaseDocumentId
        )}/imprimir`;

      const printResult =
        await relbaseRequest(
          printEndpoint,
          {
            method:
              "GET",
          }
        );

      const pdfBuffer =
        await buildRelbaseDteLetterPdfBuffer({
          taxDocumentId:
            row.tax_document_id,
          localDocument: {
            id:
              row.tax_document_id,
            order_id:
              row.order_id,
            document_type:
              row.document_type,
            status:
              row.tax_document_status,
            folio:
              row.folio,
            track_id:
              row.track_id,
            sii_status:
              row.sii_status,
            sii_status_name:
              row.sii_status_name,
            relbase_document_id:
              row.relbase_document_id,
            total_amount:
              row.total_amount,
          },
          printPayload:
            printResult?.data ??
            null,
        });

      await pool.query(
        `
          UPDATE customer_document_access_tokens
          SET last_used_at = NOW()
          WHERE id = $1
        `,
        [
          row.access_id,
        ]
      );

      return {
        kind:
          "buffer",
        format:
          "letter",
        source:
          "LAMINATIWORD_DTE_A4",
        relbase_get_executed:
          true,
        persistence_executed:
          false,
        pdf_buffer:
          pdfBuffer,
        filename:
          `factura-${cleanText(
            row.folio
          ) || cleanText(
            row.relbase_document_id
          ) || "dte"}-a4.pdf`,
        document: {
          order_number:
            row.order_number,
          document_type:
            row.document_type,
          folio:
            row.folio,
          status:
            row.tax_document_status,
          sii_status:
            row.sii_status,
          sii_status_name:
            row.sii_status_name,
        },
      };
    }

    const localPdfUrl =
      normalizeRelbaseHttpUrl(
        row.pdf_url
      );

    if (
      localPdfUrl &&
      isRelbaseHttpUrlUsable(
        localPdfUrl
      )
    ) {
      await pool.query(
        `
          UPDATE customer_document_access_tokens
          SET last_used_at = NOW()
          WHERE id = $1
        `,
        [
          row.access_id,
        ]
      );

      return {
        kind:
          "url",
        format:
          "original",
        source:
          "LOCAL_PDF_URL",
        relbase_get_executed:
          false,
        persistence_executed:
          false,
        pdf_url:
          localPdfUrl,
        document: {
          order_number:
            row.order_number,
          document_type:
            row.document_type,
          folio:
            row.folio,
          status:
            row.tax_document_status,
          sii_status:
            row.sii_status,
          sii_status_name:
            row.sii_status_name,
        },
      };
    }

    const relbaseDocumentId =
      cleanText(
        row.relbase_document_id
      );

    const endpoint =
      `/api/v2/dtes/${encodeURIComponent(
        relbaseDocumentId
      )}`;

    const detailResult =
      await relbaseRequest(
        endpoint,
        {
          method:
            "GET",
        }
      );

    const record =
      resolveRelbaseDteDetailRecord(
        detailResult?.data
      );

    if (
      !record
    ) {
      throw createServiceError(
        "Relbase respondió sin el detalle del documento tributario",
        502,
        "CUSTOMER_DOCUMENT_RELBASE_DETAIL_INVALID"
      );
    }

    const normalized =
      normalizeRelbaseDteRecord(
        record
      );

    validateExternalDteIdentity(
      row,
      record,
      normalized
    );

    const persisted =
      await persistRelbaseDteResult({
        taxDocumentId:
          row.tax_document_id,
        relbaseDte:
          record,
        issuedBy:
          null,
      });

    const freshPdfUrl =
      normalizeRelbaseHttpUrl(
        persisted?.tax_document
          ?.pdf_url ||
          normalized.pdf_url ||
          record.pdf_file
      );

    if (
      !freshPdfUrl ||
      !isRelbaseHttpUrlUsable(
        freshPdfUrl
      )
    ) {
      throw createServiceError(
        "El PDF del documento tributario todavía no está disponible",
        409,
        "CUSTOMER_DOCUMENT_PDF_NOT_AVAILABLE"
      );
    }

    await pool.query(
      `
        UPDATE customer_document_access_tokens
        SET last_used_at = NOW()
        WHERE id = $1
      `,
      [
        row.access_id,
      ]
    );

    return {
      kind:
        "url",
      format:
        "original",
      source:
        "RELBASE_DTE_DETAIL",
      relbase_get_executed:
        true,
      persistence_executed:
        true,
      pdf_url:
        freshPdfUrl,
      document: {
        order_number:
          row.order_number,
        document_type:
          row.document_type,
        folio:
          persisted?.tax_document
            ?.folio ||
            normalized.folio ||
            row.folio,
        status:
          persisted?.tax_document
            ?.status ||
            row.tax_document_status,
        sii_status:
          persisted?.tax_document
            ?.sii_status ||
            normalized.sii_status ||
            row.sii_status,
        sii_status_name:
          persisted?.tax_document
            ?.sii_status_name ||
            normalized.sii_status_name ||
            row.sii_status_name,
      },
    };
  };
