import pool from "../config/database.js";

/**
 * Relbase/SII expresa los montos tributarios CLP en pesos enteros.
 * Laminatiword conserva precisión decimal durante el cálculo previo.
 *
 * Para persistir un DTE ya aceptado por Relbase permitimos una
 * diferencia máxima de $2 CLP por componente tributario.
 *
 * Esta tolerancia NO altera montos locales ni permite diferencias
 * mayores: sólo evita bloquear la persistencia por redondeo CLP.
 */
const RELBASE_DTE_PERSISTENCE_MONEY_TOLERANCE_CLP =
  2;

/* =========================================*

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

/* =========================================*

   STRING OPCIONAL

========================================= */

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

   NÚMERO OPCIONAL

========================================= */

const toOptionalNumber = (

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

  return Number.isFinite(number)

    ? number

    : null;

};

/* =========================================*

   REDONDEAR MONEDA

========================================= */

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

   COMPARAR MONTO SI RELBASE LO ENTREGÓ

   Permitimos diferencia máxima de $2 CLP

   por redondeo tributario de Relbase/SII.

========================================= */

const assertOptionalMoneyMatches = (

  localValue,

  relbaseValue,

  message,

  code

) => {

  const normalizedRelbase =

    roundMoney(

      relbaseValue

    );

  if (normalizedRelbase === null) {

    return;

  }

  const normalizedLocal =

    roundMoney(

      localValue

    );

  if (normalizedLocal === null) {

    throw createServiceError(

      `${message}: el monto local no es válido`,

      409,

      code

    );

  }

  const difference =

    Math.abs(

      normalizedLocal -

      normalizedRelbase

    );

  if (
    difference >
      RELBASE_DTE_PERSISTENCE_MONEY_TOLERANCE_CLP
  ) {

    throw createServiceError(

      `${message}. Local: ${normalizedLocal}, Relbase: ${normalizedRelbase}`,

      409,

      code

    );

  }

};

/* =========================================*

   MONTO RELBASE FINAL

   Preferimos real_amount_* cuando existe.

   Si no existe, usamos amount_*.

========================================= */

const resolveRelbaseAmount = (

  record,

  realField,

  normalField

) => {

  const realValue =

    toOptionalNumber(

      record?.[realField]

    );

  if (realValue !== null) {

    return realValue;

  }

  return toOptionalNumber(

    record?.[normalField]

  );

};

/* =========================================*

   URL HTTP DTE + VIGENCIA URL FIRMADA

   Objetivo:
   - Validar URLs http/https.
   - Detectar expiración de URLs AWS S3
     prefirmadas mediante X-Amz-Date y
     X-Amz-Expires.
   - Soportar también Expires epoch cuando
     exista en una URL firmada.
   - No realiza red ni modifica datos.

========================================= */

export const normalizeRelbaseHttpUrl = (

  value

) => {

  const raw =

    String(

      value ||

      ""

    ).trim();

  if (!raw) {

    return null;

  }

  try {

    const parsed =

      new URL(raw);

    if (

      ![

        "http:",

        "https:",

      ].includes(

        parsed.protocol

      )

    ) {

      return null;

    }

    return parsed.toString();

  } catch {

    return null;

  }

};

const getUrlSearchParamCaseInsensitive = (

  searchParams,

  expectedName

) => {

  const target =

    String(

      expectedName ||

      ""

    ).toLowerCase();

  for (

    const [

      key,

      value,

    ] of searchParams.entries()

  ) {

    if (

      String(key).toLowerCase() ===

      target

    ) {

      return value;

    }

  }

  return null;

};

const parseAwsAmzDate = (

  value

) => {

  const raw =

    String(

      value ||

      ""

    ).trim();

  const match =

    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(

      raw

    );

  if (!match) {

    return null;

  }

  const timestamp =

    Date.UTC(

      Number(match[1]),

      Number(match[2]) - 1,

      Number(match[3]),

      Number(match[4]),

      Number(match[5]),

      Number(match[6])

    );

  return Number.isFinite(

    timestamp

  )

    ? timestamp

    : null;

};

export const isRelbasePresignedUrlExpiredOrNearExpiry = (

  value,

  skewSeconds = 60

) => {

  const normalizedUrl =

    normalizeRelbaseHttpUrl(

      value

    );

  if (!normalizedUrl) {

    return true;

  }

  let parsed;

  try {

    parsed =

      new URL(

        normalizedUrl

      );

  } catch {

    return true;

  }

  const safeSkewMs =

    Math.max(

      0,

      Number(

        skewSeconds

      ) || 0

    ) * 1000;

  const amzDate =

    getUrlSearchParamCaseInsensitive(

      parsed.searchParams,

      "X-Amz-Date"

    );

  const amzExpires =

    getUrlSearchParamCaseInsensitive(

      parsed.searchParams,

      "X-Amz-Expires"

    );

  if (

    amzDate !== null ||

    amzExpires !== null

  ) {

    const signedAt =

      parseAwsAmzDate(

        amzDate

      );

    const lifetimeSeconds =

      Number(

        amzExpires

      );

    if (

      signedAt === null ||

      !Number.isFinite(

        lifetimeSeconds

      ) ||

      lifetimeSeconds <= 0

    ) {

      /*
       * La URL parece prefirmada pero no podemos
       * demostrar su vigencia: forzamos refresco.
       */

      return true;

    }

    const expiresAt =

      signedAt +

      lifetimeSeconds *

        1000;

    return (

      Date.now() +

        safeSkewMs >=

      expiresAt

    );

  }

  const expiresEpoch =

    getUrlSearchParamCaseInsensitive(

      parsed.searchParams,

      "Expires"

    );

  const hasSignature =

    Boolean(

      getUrlSearchParamCaseInsensitive(

        parsed.searchParams,

        "Signature"

      ) ||

      getUrlSearchParamCaseInsensitive(

        parsed.searchParams,

        "X-Amz-Signature"

      )

    );

  if (

    expiresEpoch !== null &&

    hasSignature

  ) {

    const expiresAt =

      Number(

        expiresEpoch

      ) * 1000;

    if (

      !Number.isFinite(

        expiresAt

      ) ||

      expiresAt <= 0

    ) {

      return true;

    }

    return (

      Date.now() +

        safeSkewMs >=

      expiresAt

    );

  }

  /*
   * URL HTTP válida sin evidencia de expiración.
   * Se considera utilizable.
   */

  return false;

};

export const isRelbaseHttpUrlUsable = (

  value,

  skewSeconds = 60

) => {

  const normalizedUrl =

    normalizeRelbaseHttpUrl(

      value

    );

  return Boolean(

    normalizedUrl

  ) &&

    !isRelbasePresignedUrlExpiredOrNearExpiry(

      normalizedUrl,

      skewSeconds

    );

};

/* =========================================*

   URL DESDE OBJETO RELBASE

========================================= */

const resolveFileUrl = (

  value

) => {

  if (

    !value ||

    typeof value !== "object" ||

    Array.isArray(value)

  ) {

    return null;

  }

  return toOptionalString(

    value.url

  );

};

/* =========================================*

   NORMALIZAR ESTADO EXTERNO

========================================= */

const normalizeExternalStatus = (

  value

) => {

  const normalized =

    toOptionalString(value);

  return normalized

    ? normalized.toLowerCase()

    : null;

};

/* =========================================*

   ESTADO INTERNO LAMINATIWORD

   IMPORTANTE:

   - status=paid de Relbase no significa

     automáticamente DTE aceptado.

   - ACCEPTED/REJECTED se resuelven desde

     sii_status.

   - Con id Relbase y sin estado SII final,

     el documento queda ISSUED.

========================================= */

const resolveLocalStatus = ({

  currentStatus,

  relbaseDocumentId,

  siiStatus,

}) => {

  const normalizedSii =

    normalizeExternalStatus(

      siiStatus

    );

  if (

    [

      "accepted",

      "aceptado",

    ].includes(

      normalizedSii

    )

  ) {

    return "ACCEPTED";

  }

  if (

    [

      "rejected",

      "rechazado",

    ].includes(

      normalizedSii

    )

  ) {

    return "REJECTED";

  }

  const current =

    String(

      currentStatus ||

      "PENDING"

    )

      .trim()

      .toUpperCase();

  /**

   * No degradamos estados terminales

   * por una respuesta parcial posterior.

   */

  if (

    [

      "ACCEPTED",

      "REJECTED",

      "CANCELLED",

    ].includes(current)

  ) {

    return current;

  }

  if (relbaseDocumentId) {

    return "ISSUED";

  }

  return current;

};

/* =========================================*

   SNAPSHOT SANITIZADO DE RELBASE

   No guardamos dirección, contacto ni

   otros datos personales del receptor.

========================================= */

const buildSafeRelbaseSnapshot = (

  record,

  normalized

) => {

  return {

    id:

      normalized.relbase_document_id,

    folio:

      normalized.folio,

    track_id:

      normalized.track_id,

    type_document:

      normalized.type_document,

    type_document_name:

      toOptionalString(

        record?.type_document_name

      ),

    status:

      normalized.relbase_status,

    sii_status:

      normalized.sii_status,

    sii_status_name:

      normalized.sii_status_name,

    start_date:

      toOptionalString(

        record?.start_date

      ),

    end_date:

      toOptionalString(

        record?.end_date

      ),

    customer_id:

      normalized.relbase_customer_id,

    channel_id:

      toOptionalNumber(

        record?.channel_id

      ),

    type_payment_id:

      toOptionalNumber(

        record?.type_payment_id

      ),

    seller_id:

      toOptionalNumber(

        record?.seller_id

      ),

    amounts: {

      net:

        normalized.amounts.net,

      exempt:

        normalized.amounts.exempt,

      tax:

        normalized.amounts.tax,

      total:

        normalized.amounts.total,

    },

    mnt_bruto:

      typeof record?.mnt_bruto ===

        "boolean"

        ? record.mnt_bruto

        : null,

    pdf_file:

      normalized.pdf_url

        ? {

            url:

              normalized.pdf_url,

          }

        : null,

    xml_inter_file:

      normalized.xml_url

        ? {

            url:

              normalized.xml_url,

          }

        : null,

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

   NORMALIZAR REGISTRO DTE RELBASE V2

========================================= */

export const normalizeRelbaseDteRecord = (

  record

) => {

  if (

    !record ||

    typeof record !== "object" ||

    Array.isArray(record)

  ) {

    throw createServiceError(

      "La respuesta DTE de Relbase no es válida",

      502,

      "RELBASE_DTE_RESPONSE_INVALID"

    );

  }

  const relbaseDocumentId =

    toOptionalString(

      record.id

    );

  if (!relbaseDocumentId) {

    throw createServiceError(

      "Relbase no devolvió el identificador del DTE",

      502,

      "RELBASE_DTE_ID_MISSING"

    );

  }

  const normalized = {

    relbase_document_id:

      relbaseDocumentId,

    relbase_customer_id:

      toOptionalString(

        record.customer_id

      ),

    folio:

      toOptionalString(

        record.folio

      ),

    track_id:

      toOptionalString(

        record.track_id

      ),

    type_document:

      toOptionalNumber(

        record.type_document

      ),

    relbase_status:

      normalizeExternalStatus(

        record.status

      ),

    sii_status:

      normalizeExternalStatus(

        record.sii_status

      ),

    sii_status_name:

      toOptionalString(

        record.sii_status_name

      ),

    pdf_url:

      resolveFileUrl(

        record.pdf_file

      ),

    xml_url:

      resolveFileUrl(

        record.xml_inter_file

      ),

    amounts: {

      net:

        resolveRelbaseAmount(

          record,

          "real_amount_neto",

          "amount_neto"

        ),

      exempt:

        resolveRelbaseAmount(

          record,

          "real_amount_exempt",

          "amount_exempt"

        ),

      tax:

        resolveRelbaseAmount(

          record,

          "real_amount_iva",

          "amount_iva"

        ),

      total:

        resolveRelbaseAmount(

          record,

          "real_amount_total",

          "amount_total"

        ),

    },

  };

  return {

    ...normalized,

    safe_snapshot:

      buildSafeRelbaseSnapshot(

        record,

        normalized

      ),

  };

};



/* =========================================*

   RESERVAR DOCUMENTO PARA EMISIÓN

   IMPORTANTE:

   - Este servicio NO llama a Relbase.

   - Este servicio NO emite DTE.

   - Sólo reclama de forma atómica un

     documento PENDING para que una única

     ejecución pueda continuar a emisión.

   - Mantiene la protección:

       status = PENDING

       relbase_document_id IS NULL

========================================= */

export const claimTaxDocumentForEmission =

  async ({

    taxDocumentId,

  }) => {

    if (!taxDocumentId) {

      throw createServiceError(

        "Se requiere taxDocumentId",

        400,

        "TAX_DOCUMENT_ID_REQUIRED"

      );

    }

    const client =

      await pool.connect();

    try {

      await client.query(

        "BEGIN"

      );

      /* =====================================*

         1. LOCALIZAR DOCUMENTO

         Esta primera lectura sólo permite

         conocer order_id. La validación real

         se vuelve a ejecutar con FOR UPDATE.

      ===================================== */

      const locatorResult =

        await client.query(

          `

            SELECT

              id,

              order_id

            FROM tax_documents

            WHERE id = $1

            LIMIT 1

          `,

          [

            taxDocumentId,

          ]

        );

      if (

        locatorResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El documento tributario local no existe",

          404,

          "TAX_DOCUMENT_NOT_FOUND"

        );

      }

      const orderId =

        locatorResult.rows[0]

          .order_id;

      /* =====================================*

         2. BLOQUEAR Y REVALIDAR ORDEN

         Conservamos el mismo orden de

         bloqueo utilizado por la preparación:

         primero orders y luego tax_documents.

      ===================================== */

      const orderResult =

        await client.query(

          `

            SELECT

              id,

              order_number,

              status,

              payment_status,

              total,

              currency,

              created_at,

              updated_at

            FROM orders

            WHERE id = $1

            LIMIT 1

            FOR UPDATE

          `,

          [

            orderId,

          ]

        );

      if (

        orderResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "La orden asociada al documento tributario no existe",

          409,

          "TAX_DOCUMENT_ORDER_NOT_FOUND"

        );

      }

      const order =

        orderResult.rows[0];

      if (

        String(

          order.status ||

          ""

        )

          .trim()

          .toUpperCase() ===

        "CANCELLED"

      ) {

        throw createServiceError(

          "No se puede emitir un documento tributario para una orden cancelada",

          409,

          "ORDER_CANCELLED"

        );

      }

      if (

        String(

          order.payment_status ||

          ""

        )

          .trim()

          .toUpperCase() !==

        "PAID"

      ) {

        throw createServiceError(

          "La orden debe encontrarse pagada antes de iniciar la emisión tributaria",

          409,

          "ORDER_NOT_PAID"

        );

      }

      /* =====================================*

         3. BLOQUEAR DOCUMENTO TRIBUTARIO

      ===================================== */

      const currentResult =

        await client.query(

          `

            SELECT

              id,

              order_id,

              parent_document_id,

              idempotency_key,

              document_type,

              sii_code,

              relbase_document_id,

              relbase_customer_id,

              folio,

              track_id,

              status,

              external_status,

              relbase_status,

              sii_status,

              sii_status_name,

              net_amount,

              exempt_amount,

              tax_amount,

              total_amount,

              issued_by,

              issued_at,

              last_status_sync_at,

              error_message,

              request_payload,

              response_payload,

              pdf_url,

              xml_url,

              created_at,

              updated_at

            FROM tax_documents

            WHERE id = $1

            LIMIT 1

            FOR UPDATE

          `,

          [

            taxDocumentId,

          ]

        );

      if (

        currentResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El documento tributario local no existe",

          404,

          "TAX_DOCUMENT_NOT_FOUND"

        );

      }

      const current =

        currentResult.rows[0];

      /* =====================================*

         4. VALIDAR TIPO EMITIBLE ACTUAL

         Notas de crédito/débito se

         implementarán en su flujo propio.

      ===================================== */

      if (

        ![

          "BOLETA",

          "FACTURA",

        ].includes(

          String(

            current.document_type ||

            ""

          )

            .trim()

            .toUpperCase()

        )

      ) {

        throw createServiceError(

          "El tipo de documento todavía no está habilitado para emisión",

          409,

          "TAX_DOCUMENT_TYPE_NOT_EMITTABLE"

        );

      }

      /* =====================================*

         5. IDENTIDAD EXTERNA

         Si ya existe relbase_document_id,

         nunca volvemos a iniciar emisión.

      ===================================== */

      if (

        current.relbase_document_id

      ) {

        throw createServiceError(

          "El documento tributario ya está asociado a un DTE de Relbase",

          409,

          "TAX_DOCUMENT_ALREADY_HAS_RELBASE_ID"

        );

      }

      /* =====================================*

         6. ESTADO ACTUAL

      ===================================== */

      const currentStatus =

        String(

          current.status ||

          ""

        )

          .trim()

          .toUpperCase();

      if (

        currentStatus ===

        "PROCESSING"

      ) {

        throw createServiceError(

          "La emisión del documento tributario ya se encuentra en proceso",

          409,

          "TAX_DOCUMENT_EMISSION_IN_PROGRESS"

        );

      }

      if (

        [

          "ISSUED",

          "ACCEPTED",

        ].includes(

          currentStatus

        )

      ) {

        throw createServiceError(

          "El documento tributario ya fue emitido",

          409,

          "TAX_DOCUMENT_ALREADY_ISSUED"

        );

      }

      if (

        currentStatus ===

        "REJECTED"

      ) {

        throw createServiceError(

          "El documento tributario fue rechazado y requiere revisión antes de cualquier nuevo intento",

          409,

          "TAX_DOCUMENT_REJECTED_REVIEW_REQUIRED"

        );

      }

      if (

        currentStatus ===

        "ERROR"

      ) {

        throw createServiceError(

          "El documento tributario está en ERROR y requiere un reinicio explícito antes de reintentar",

          409,

          "TAX_DOCUMENT_ERROR_RETRY_REQUIRES_RESET"

        );

      }

      if (

        currentStatus ===

        "CANCELLED"

      ) {

        throw createServiceError(

          "El documento tributario está cancelado",

          409,

          "TAX_DOCUMENT_CANCELLED"

        );

      }

      if (

        currentStatus !==

        "PENDING"

      ) {

        throw createServiceError(

          `El estado ${currentStatus || "DESCONOCIDO"} no permite iniciar la emisión`,

          409,

          "TAX_DOCUMENT_STATUS_NOT_EMITTABLE"

        );

      }

      /* =====================================*

         7. REVALIDAR PAGO REAL

         No basta con orders.payment_status.

         El registro de payments también debe

         seguir confirmado como PAID.

      ===================================== */

      const paymentResult =

        await client.query(

          `

            SELECT

              id,

              order_id,

              amount,

              currency,

              status,

              confirmed_at,

              confirmed_by,

              created_at,

              updated_at

            FROM payments

            WHERE order_id = $1

            LIMIT 1

            FOR UPDATE

          `,

          [

            orderId,

          ]

        );

      if (

        paymentResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "La orden no posee un pago asociado",

          409,

          "PAYMENT_NOT_FOUND"

        );

      }

      const payment =

        paymentResult.rows[0];

      if (

        String(

          payment.status ||

          ""

        )

          .trim()

          .toUpperCase() !==

        "PAID"

      ) {

        throw createServiceError(

          "El pago asociado a la orden ya no se encuentra confirmado",

          409,

          "PAYMENT_NOT_PAID"

        );

      }

      const orderTotal =

        roundMoney(

          order.total

        );

      const paymentAmount =

        roundMoney(

          payment.amount

        );

      if (

        orderTotal === null ||

        paymentAmount === null ||

        Math.abs(

          orderTotal -

          paymentAmount

        ) > 1

      ) {

        throw createServiceError(

          "El monto pagado no coincide con el total de la orden",

          409,

          "PAYMENT_AMOUNT_MISMATCH"

        );

      }

      /* =====================================*

         8. CLAIM ATÓMICO

         Aunque tenemos FOR UPDATE, mantenemos

         las condiciones en el UPDATE como

         segunda barrera de seguridad.

      ===================================== */

      const claimResult =

        await client.query(

          `

            UPDATE tax_documents

            SET

              status = 'PROCESSING',

              error_message = NULL

            WHERE

              id = $1

              AND status = 'PENDING'

              AND relbase_document_id

                  IS NULL

            RETURNING

              id,

              order_id,

              parent_document_id,

              idempotency_key,

              document_type,

              sii_code,

              relbase_document_id,

              relbase_customer_id,

              folio,

              track_id,

              status,

              external_status,

              relbase_status,

              sii_status,

              sii_status_name,

              net_amount,

              exempt_amount,

              tax_amount,

              total_amount,

              issued_by,

              issued_at,

              last_status_sync_at,

              error_message,

              request_payload,

              response_payload,

              pdf_url,

              xml_url,

              created_at,

              updated_at

          `,

          [

            taxDocumentId,

          ]

        );

      if (

        claimResult.rowCount !==

        1

      ) {

        throw createServiceError(

          "No fue posible reservar el documento para emisión; su estado cambió durante la operación",

          409,

          "TAX_DOCUMENT_CLAIM_CONFLICT"

        );

      }

      await client.query(

        "COMMIT"

      );

      return {

        claimed: true,

        previous_status:

          currentStatus,

        order: {

          id:

            order.id,

          order_number:

            order.order_number,

          payment_status:

            order.payment_status,

          total:

            roundMoney(

              order.total

            ),

          currency:

            order.currency,

        },

        payment: {

          id:

            payment.id,

          status:

            payment.status,

          amount:

            roundMoney(

              payment.amount

            ),

          currency:

            payment.currency,

          confirmed_at:

            payment.confirmed_at,

        },

        tax_document:

          claimResult.rows[0],

      };

    } catch (error) {

      try {

        await client.query(

          "ROLLBACK"

        );

      } catch {

        // La transacción puede haber terminado.

      }

      throw error;

    } finally {

      client.release();

    }

  };

/* =========================================*

   SANITIZAR ERROR DE EMISIÓN

   IMPORTANTE:

   - Nunca persistimos stack traces.

   - Nunca persistimos tokens OAuth.

   - Nunca persistimos client_secret.

   - Limitamos el texto guardado para evitar

     almacenar respuestas externas completas.

========================================= */

const sanitizeEmissionErrorMessage = (

  value

) => {

  let message =

    value instanceof Error

      ? value.message

      : value;

  message =

    toOptionalString(

      message

    ) ||

    "La emisión tributaria falló sin un mensaje de error disponible";

  message =

    message

      .replace(

        /Bearer\s+[-A-Za-z0-9._~+/=]+/gi,

        "Bearer [REDACTED]"

      )

      .replace(

        /\b(access_token|refresh_token|client_secret)\b\s*[:=]\s*["']?[^,\s"']+/gi,

        "$1=[REDACTED]"

      )

      .replace(

        /\s+/g,

        " "

      )

      .trim();

  return message.slice(

    0,

    1000

  );

};



/* =========================================*

   MARCAR ERROR DE EMISIÓN

   TRANSICIÓN PERMITIDA:

     PROCESSING -> ERROR

   IMPORTANTE:

   - Este servicio NO llama a Relbase.

   - Este servicio NO emite DTE.

   - Sólo debe utilizarse cuando la ejecución

     que ya reclamó el documento determina que

     la emisión no puede continuar.

   - Si existe relbase_document_id, NO marcamos

     ERROR porque ya existe identidad externa.

   - ERROR nunca se reintenta automáticamente.

   - issued_by / issued_at no se modifican.

========================================= */

export const markTaxDocumentEmissionError =

  async ({

    taxDocumentId,

    errorMessage,

    errorCode = null,

  }) => {

    if (!taxDocumentId) {

      throw createServiceError(

        "Se requiere taxDocumentId",

        400,

        "TAX_DOCUMENT_ID_REQUIRED"

      );

    }

    const sanitizedMessage =

      sanitizeEmissionErrorMessage(

        errorMessage

      );

    const sanitizedCode =

      toOptionalString(

        errorCode

      )

        ?.replace(

          /[^A-Za-z0-9_.:-]/g,

          "_"

        )

        .slice(

          0,

          120

        ) ||

      null;

    const storedErrorMessage =

      sanitizedCode

        ? `[${sanitizedCode}] ${sanitizedMessage}`

        : sanitizedMessage;

    const client =

      await pool.connect();

    try {

      await client.query(

        "BEGIN"

      );

      const currentResult =

        await client.query(

          `

            SELECT

              id,

              order_id,

              parent_document_id,

              idempotency_key,

              document_type,

              sii_code,

              relbase_document_id,

              relbase_customer_id,

              folio,

              track_id,

              status,

              external_status,

              relbase_status,

              sii_status,

              sii_status_name,

              net_amount,

              exempt_amount,

              tax_amount,

              total_amount,

              issued_by,

              issued_at,

              last_status_sync_at,

              error_message,

              request_payload,

              response_payload,

              pdf_url,

              xml_url,

              created_at,

              updated_at

            FROM tax_documents

            WHERE id = $1

            LIMIT 1

            FOR UPDATE

          `,

          [

            taxDocumentId,

          ]

        );

      if (

        currentResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El documento tributario local no existe",

          404,

          "TAX_DOCUMENT_NOT_FOUND"

        );

      }

      const current =

        currentResult.rows[0];

      /**

       * Si ya existe identidad externa, no

       * debemos convertir el documento a ERROR.

       *

       * En un futuro fallo de red posterior al

       * POST, primero habrá que reconciliar con

       * Relbase antes de decidir cualquier

       * reintento.

       */

      if (

        current.relbase_document_id

      ) {

        throw createServiceError(

          "El documento ya posee un DTE de Relbase y no puede marcarse como error de emisión local",

          409,

          "TAX_DOCUMENT_ERROR_ALREADY_HAS_RELBASE_ID"

        );

      }

      const currentStatus =

        String(

          current.status ||

          ""

        )

          .trim()

          .toUpperCase();

      /**

       * Repetir la misma operación sobre un

       * documento que ya quedó en ERROR es

       * idempotente: no volvemos a escribir.

       */

      if (

        currentStatus ===

        "ERROR"

      ) {

        await client.query(

          "COMMIT"

        );

        return {

          marked: false,

          already_error: true,

          previous_status:

            currentStatus,

          tax_document:

            current,

        };

      }

      if (

        currentStatus !==

        "PROCESSING"

      ) {

        throw createServiceError(

          `El documento debe estar en PROCESSING para registrar un error de emisión. Estado actual: ${currentStatus || "DESCONOCIDO"}`,

          409,

          "TAX_DOCUMENT_NOT_PROCESSING"

        );

      }

      const updateResult =

        await client.query(

          `

            UPDATE tax_documents

            SET

              status = 'ERROR',

              error_message = $2

            WHERE

              id = $1

              AND status = 'PROCESSING'

              AND relbase_document_id

                  IS NULL

            RETURNING

              id,

              order_id,

              parent_document_id,

              idempotency_key,

              document_type,

              sii_code,

              relbase_document_id,

              relbase_customer_id,

              folio,

              track_id,

              status,

              external_status,

              relbase_status,

              sii_status,

              sii_status_name,

              net_amount,

              exempt_amount,

              tax_amount,

              total_amount,

              issued_by,

              issued_at,

              last_status_sync_at,

              error_message,

              request_payload,

              response_payload,

              pdf_url,

              xml_url,

              created_at,

              updated_at

          `,

          [

            taxDocumentId,

            storedErrorMessage,

          ]

        );

      if (

        updateResult.rowCount !==

        1

      ) {

        throw createServiceError(

          "No fue posible registrar el error de emisión; el documento cambió de estado durante la operación",

          409,

          "TAX_DOCUMENT_ERROR_MARK_CONFLICT"

        );

      }

      await client.query(

        "COMMIT"

      );

      return {

        marked: true,

        already_error:

          false,

        previous_status:

          currentStatus,

        error: {

          code:

            sanitizedCode,

          message:

            sanitizedMessage,

        },

        tax_document:

          updateResult.rows[0],

      };

    } catch (error) {

      try {

        await client.query(

          "ROLLBACK"

        );

      } catch {

        // La transacción puede haber terminado.

      }

      throw error;

    } finally {

      client.release();

    }

  };



/* =========================================*

   REINICIAR ERROR SIMULADO DE EMISIÓN

   PASO 84.5.8

   TRANSICIÓN PERMITIDA:

     ERROR -> PENDING

   IMPORTANTE:

   - Sólo para el error de prueba

     SIMULATED_RELBASE_ERROR.

   - NO sirve como retry genérico de producción.

   - NO llama a Relbase.

   - NO emite DTE.

   - Exige que nunca haya existido identidad

     externa ni emisión confirmada.

========================================= */

export const resetSimulatedTaxDocumentEmissionError =

  async ({

    taxDocumentId,

  }) => {

    if (!taxDocumentId) {

      throw createServiceError(

        "Se requiere taxDocumentId",

        400,

        "TAX_DOCUMENT_ID_REQUIRED"

      );

    }

    const client =

      await pool.connect();

    try {

      await client.query(

        "BEGIN"

      );

      const currentResult =

        await client.query(

          `

            SELECT

              id,

              order_id,

              parent_document_id,

              idempotency_key,

              document_type,

              sii_code,

              relbase_document_id,

              relbase_customer_id,

              folio,

              track_id,

              status,

              external_status,

              relbase_status,

              sii_status,

              sii_status_name,

              net_amount,

              exempt_amount,

              tax_amount,

              total_amount,

              issued_by,

              issued_at,

              last_status_sync_at,

              error_message,

              request_payload,

              response_payload,

              pdf_url,

              xml_url,

              created_at,

              updated_at

            FROM tax_documents

            WHERE id = $1

            LIMIT 1

            FOR UPDATE

          `,

          [

            taxDocumentId,

          ]

        );

      if (

        currentResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El documento tributario local no existe",

          404,

          "TAX_DOCUMENT_NOT_FOUND"

        );

      }

      const current =

        currentResult.rows[0];

      const currentStatus =

        String(

          current.status ||

          ""

        )

          .trim()

          .toUpperCase();

      if (

        currentStatus !==

        "ERROR"

      ) {

        throw createServiceError(

          `El documento debe estar en ERROR para reiniciar la prueba. Estado actual: ${currentStatus || "DESCONOCIDO"}`,

          409,

          "TAX_DOCUMENT_NOT_IN_ERROR"

        );

      }

      if (

        current.relbase_document_id ||

        current.folio ||

        current.track_id ||

        current.issued_at ||

        current.issued_by

      ) {

        throw createServiceError(

          "El documento posee datos de emisión y no puede volver a PENDING mediante el reset de prueba",

          409,

          "TAX_DOCUMENT_RESET_UNSAFE_EXTERNAL_STATE"

        );

      }

      const currentError =

        toOptionalString(

          current.error_message

        ) ||

        "";

      if (

        !currentError.startsWith(

          "[SIMULATED_RELBASE_ERROR]"

        )

      ) {

        throw createServiceError(

          "El documento no posee un error simulado autorizado para este reset",

          409,

          "TAX_DOCUMENT_RESET_ERROR_NOT_SIMULATED"

        );

      }

      const updateResult =

        await client.query(

          `

            UPDATE tax_documents

            SET

              status = 'PENDING',

              error_message = NULL

            WHERE

              id = $1

              AND status = 'ERROR'

              AND relbase_document_id

                  IS NULL

              AND folio

                  IS NULL

              AND track_id

                  IS NULL

              AND issued_by

                  IS NULL

              AND issued_at

                  IS NULL

              AND error_message

                  LIKE '[SIMULATED_RELBASE_ERROR]%'

            RETURNING

              id,

              order_id,

              parent_document_id,

              idempotency_key,

              document_type,

              sii_code,

              relbase_document_id,

              relbase_customer_id,

              folio,

              track_id,

              status,

              external_status,

              relbase_status,

              sii_status,

              sii_status_name,

              net_amount,

              exempt_amount,

              tax_amount,

              total_amount,

              issued_by,

              issued_at,

              last_status_sync_at,

              error_message,

              request_payload,

              response_payload,

              pdf_url,

              xml_url,

              created_at,

              updated_at

          `,

          [

            taxDocumentId,

          ]

        );

      if (

        updateResult.rowCount !==

        1

      ) {

        throw createServiceError(

          "No fue posible reiniciar el documento; su estado cambió durante la operación",

          409,

          "TAX_DOCUMENT_RESET_CONFLICT"

        );

      }

      await client.query(

        "COMMIT"

      );

      return {

        reset: true,

        previous_status:

          currentStatus,

        tax_document:

          updateResult.rows[0],

      };

    } catch (error) {

      try {

        await client.query(

          "ROLLBACK"

        );

      } catch {

        // La transacción puede haber terminado.

      }

      throw error;

    } finally {

      client.release();

    }

  };



/* =========================================*

   PERSISTIR / SINCRONIZAR DTE RELBASE

   Este servicio NO emite documentos.

   Recibe un DTE ya existente/devuelto por

   Relbase y actualiza tax_documents.

========================================= */

export const persistRelbaseDteResult =

  async ({

    taxDocumentId,

    relbaseDte,

    issuedBy = null,

  }) => {

    if (!taxDocumentId) {

      throw createServiceError(

        "Se requiere taxDocumentId",

        400,

        "TAX_DOCUMENT_ID_REQUIRED"

      );

    }

    const normalized =

      normalizeRelbaseDteRecord(

        relbaseDte

      );

    const client =

      await pool.connect();

    try {

      await client.query(

        "BEGIN"

      );

      const currentResult =

        await client.query(

          `

            SELECT

              id,

              order_id,

              document_type,

              sii_code,

              relbase_document_id,

              relbase_customer_id,

              folio,

              track_id,

              status,

              external_status,

              relbase_status,

              sii_status,

              sii_status_name,

              net_amount,

              exempt_amount,

              tax_amount,

              total_amount,

              issued_by,

              issued_at,

              last_status_sync_at,

              error_message,

              request_payload,

              response_payload,

              pdf_url,

              xml_url,

              created_at,

              updated_at

            FROM tax_documents

            WHERE id = $1

            LIMIT 1

            FOR UPDATE

          `,

          [

            taxDocumentId,

          ]

        );

      if (

        currentResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El documento tributario local no existe",

          404,

          "TAX_DOCUMENT_NOT_FOUND"

        );

      }

      const current =

        currentResult.rows[0];

      /* =====================================*

         IDEMPOTENCIA / IDENTIDAD EXTERNA

      ===================================== */

      if (

        current.relbase_document_id &&

        String(

          current.relbase_document_id

        ) !==

          normalized.relbase_document_id

      ) {

        throw createServiceError(

          "El documento local ya está asociado a otro DTE de Relbase",

          409,

          "RELBASE_DTE_ID_CONFLICT"

        );

      }

      /* =====================================*

         VALIDAR TIPO DE DOCUMENTO

      ===================================== */

      if (

        normalized.type_document !==

          null &&

        current.sii_code !== null &&

        Number(current.sii_code) !==

          Number(

            normalized.type_document

          )

      ) {

        throw createServiceError(

          `El tipo de documento Relbase (${normalized.type_document}) no coincide con el sii_code local (${current.sii_code})`,

          409,

          "RELBASE_DTE_TYPE_MISMATCH"

        );

      }

      /* =====================================*

         VALIDAR MONTOS

      ===================================== */

      assertOptionalMoneyMatches(

        current.net_amount,

        normalized.amounts.net,

        "El neto de Relbase no coincide con el documento local",

        "RELBASE_DTE_NET_MISMATCH"

      );

      assertOptionalMoneyMatches(

        current.exempt_amount,

        normalized.amounts.exempt,

        "El monto exento de Relbase no coincide con el documento local",

        "RELBASE_DTE_EXEMPT_MISMATCH"

      );

      assertOptionalMoneyMatches(

        current.tax_amount,

        normalized.amounts.tax,

        "El IVA de Relbase no coincide con el documento local",

        "RELBASE_DTE_TAX_MISMATCH"

      );

      assertOptionalMoneyMatches(

        current.total_amount,

        normalized.amounts.total,

        "El total de Relbase no coincide con el documento local",

        "RELBASE_DTE_TOTAL_MISMATCH"

      );

      /* =====================================*

         ESTADO LOCAL

      ===================================== */

      const localStatus =

        resolveLocalStatus({

          currentStatus:

            current.status,

          relbaseDocumentId:

            normalized.relbase_document_id,

          siiStatus:

            normalized.sii_status,

        });

      const externalStatus =

        normalized.sii_status ||

        normalized.relbase_status ||

        current.external_status ||

        null;

      /* =====================================*

         ACTUALIZAR SNAPSHOT LOCAL

      ===================================== */

      const updateResult =

        await client.query(

          `

            UPDATE tax_documents

            SET

              relbase_document_id = $2,

              relbase_customer_id =

                COALESCE(

                  relbase_customer_id,

                  $3

                ),

              folio =

                COALESCE(

                  $4,

                  folio

                ),

              track_id =

                COALESCE(

                  $5,

                  track_id

                ),

              status = $6,

              external_status =

                COALESCE(

                  $7,

                  external_status

                ),

              relbase_status =

                COALESCE(

                  $8,

                  relbase_status

                ),

              sii_status =

                COALESCE(

                  $9,

                  sii_status

                ),

              sii_status_name =

                COALESCE(

                  $10,

                  sii_status_name

                ),

              issued_by =

                COALESCE(

                  issued_by,

                  $11

                ),

              issued_at =

                COALESCE(

                  issued_at,

                  NOW()

                ),

              last_status_sync_at =

                NOW(),

              response_payload =

                $12::jsonb,

              pdf_url =

                COALESCE(

                  $13,

                  pdf_url

                ),

              xml_url =

                COALESCE(

                  $14,

                  xml_url

                ),

              error_message =

                CASE

                  WHEN $15::boolean

                    THEN NULL

                  ELSE error_message

                END

            WHERE id = $1

            RETURNING

              id,

              order_id,

              parent_document_id,

              idempotency_key,

              document_type,

              sii_code,

              relbase_document_id,

              relbase_customer_id,

              folio,

              track_id,

              status,

              external_status,

              relbase_status,

              sii_status,

              sii_status_name,

              net_amount,

              exempt_amount,

              tax_amount,

              total_amount,

              issued_by,

              issued_at,

              last_status_sync_at,

              error_message,

              request_payload,

              response_payload,

              pdf_url,

              xml_url,

              created_at,

              updated_at

          `,

          [

            taxDocumentId,

            normalized.relbase_document_id,

            normalized.relbase_customer_id,

            normalized.folio,

            normalized.track_id,

            localStatus,

            externalStatus,

            normalized.relbase_status,

            normalized.sii_status,

            normalized.sii_status_name,

            issuedBy,

            JSON.stringify(

              normalized.safe_snapshot

            ),

            normalized.pdf_url,

            normalized.xml_url,

            [

              "ISSUED",

              "ACCEPTED",

            ].includes(

              localStatus

            ),

          ]

        );

      await client.query(

        "COMMIT"

      );

      return {

        normalized,

        tax_document:

          updateResult.rows[0],

      };

    } catch (error) {

      try {

        await client.query(

          "ROLLBACK"

        );

      } catch {

        // La transacción puede haber terminado.

      }

      throw error;

    } finally {

      client.release();

    }

  };
