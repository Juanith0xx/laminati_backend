import crypto from "crypto";

import pool from "../config/database.js";

import {

  ensureStorePickupForPaidOrder,

} from "./pickup.service.js";

/* =========================================

 * ERROR CONTROLADO

 * ========================================= */

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

 * MONEDA

 * ========================================= */

const roundMoney = (value) => {

  if (

    value === undefined ||

    value === null ||

    value === ""

  ) {

    return null;

  }

  const number = Number(value);

  if (!Number.isFinite(number)) {

    return null;

  }

  return (

    Math.round(

      (number + Number.EPSILON) * 100

    ) / 100

  );

};





const moneyMatches = (

  left,

  right,

  tolerance = 1

) => {

  const a = roundMoney(left);

  const b = roundMoney(right);

  if (

    a === null ||

    b === null

  ) {

    return false;

  }

  return (

    Math.abs(a - b) <= tolerance

  );

};





/* =========================================

 * NORMALIZAR ROL

 * ========================================= */

const isAdminRole = (role) => {

  return (

    String(role || "")

      .trim()

      .toUpperCase() ===

    "ADMIN"

  );

};





/* =========================================

 * VALIDAR ACCESO A ORDEN

 * Por ahora el flujo cliente requiere que

 * orders.user_id corresponda al usuario

 * autenticado.

 * Las órdenes guest se resolverán en un paso

 * separado con un token de acceso específico;

 * no se permite inferir acceso sólo por email.

 * ========================================= */

const hashGuestAccessToken = (value) => {

  return crypto

    .createHash("sha256")

    .update(

      String(value || "")

    )

    .digest("hex");

};





const safeHashMatches = (

  expectedHash,

  candidateHash

) => {

  const expected =

    String(expectedHash || "")

      .trim()

      .toLowerCase();

  const candidate =

    String(candidateHash || "")

      .trim()

      .toLowerCase();

  if (

    expected.length !== 64 ||

    candidate.length !== 64

  ) {

    return false;

  }

  try {

    return crypto.timingSafeEqual(

      Buffer.from(expected, "hex"),

      Buffer.from(candidate, "hex")

    );

  } catch {

    return false;

  }

};





const assertOrderAccess = ({

  order,

  requesterUserId,

  requesterRole,

  guestAccessToken = null,

  guestOrderId = null,

}) => {

  if (isAdminRole(requesterRole)) {

    return;

  }

  if (

    requesterUserId &&

    order?.user_id &&

    String(order.user_id) ===

      String(requesterUserId)

  ) {

    return;

  }

  const normalizedGuestToken =

    String(guestAccessToken || "").trim();

  const normalizedGuestOrderId =

    String(guestOrderId || "").trim();

  const currentOrderId =

    String(

      order?.id ||

      order?.order_id ||

      ""

    ).trim();

  const guestExpiresAt =

    order?.guest_access_expires_at

      ? new Date(

          order.guest_access_expires_at

        )

      : null;

  const guestTokenUsable =

    Boolean(

      normalizedGuestToken &&

      normalizedGuestOrderId &&

      currentOrderId &&

      normalizedGuestOrderId ===

        currentOrderId &&

      !order?.user_id &&

      order?.guest_access_token_hash &&

      !order?.guest_access_revoked_at &&

      guestExpiresAt &&

      !Number.isNaN(

        guestExpiresAt.getTime()

      ) &&

      guestExpiresAt.getTime() >

        Date.now()

    );

  if (guestTokenUsable) {

    const candidateHash =

      hashGuestAccessToken(

        normalizedGuestToken

      );

    if (

      safeHashMatches(

        order.guest_access_token_hash,

        candidateHash

      )

    ) {

      return;

    }

  }

  throw createServiceError(

    "No tienes permiso para gestionar el pago de esta orden",

    403,

    "ORDER_PAYMENT_ACCESS_DENIED"

  );

};



/* =========================================

 * CUENTAS BANCARIAS ACTIVAS

 * ========================================= */

export const getActiveBankAccounts =

  async () => {

    const result =

      await pool.query(

        `

          SELECT

            id,

            bank_name,

            account_type,

            account_number,

            account_holder,

            rut,

            email,

            currency,

            is_default,

            sort_order

          FROM bank_accounts

          WHERE is_active = TRUE

          ORDER BY

            is_default DESC,

            sort_order ASC,

            created_at ASC

        `

      );

    return result.rows;

  };





/* =========================================

 * CONFIGURACIÓN TRANSFERENCIA MANUAL

 * ========================================= */

const getManualTransferConfiguration =

  async (client) => {

    const methodResult =

      await client.query(

        `

          SELECT

            id,

            code,

            name,

            requires_manual_confirmation

          FROM payment_methods

          WHERE code = 'MANUAL_BANK_TRANSFER'

            AND is_active = TRUE

          LIMIT 1

        `

      );

    if (methodResult.rowCount === 0) {

      throw createServiceError(

        "El método de transferencia bancaria manual no está activo",

        409,

        "MANUAL_BANK_TRANSFER_METHOD_NOT_AVAILABLE"

      );

    }

    const providerResult =

      await client.query(

        `

          SELECT

            id,

            code,

            name,

            environment,

            supports_idempotency

          FROM payment_providers

          WHERE code = 'MANUAL_TRANSFER'

            AND is_active = TRUE

          LIMIT 1

        `

      );

    if (providerResult.rowCount === 0) {

      throw createServiceError(

        "El proveedor de transferencia manual no está activo",

        409,

        "MANUAL_TRANSFER_PROVIDER_NOT_AVAILABLE"

      );

    }

    const bankResult =

      await client.query(

        `

          SELECT

            id,

            bank_name,

            account_type,

            account_number,

            account_holder,

            rut,

            email,

            currency,

            is_default,

            sort_order

          FROM bank_accounts

          WHERE is_active = TRUE

          ORDER BY

            is_default DESC,

            sort_order ASC,

            created_at ASC

          LIMIT 1

        `

      );

    if (bankResult.rowCount === 0) {

      throw createServiceError(

        "No existe una cuenta bancaria activa configurada para recibir transferencias",

        409,

        "BANK_ACCOUNT_NOT_CONFIGURED"

      );

    }

    return {

      method:

        methodResult.rows[0],

      provider:

        providerResult.rows[0],

      bank_account:

        bankResult.rows[0],

    };

  };





/* =========================================

 * DETALLE DE PAGO

 * ========================================= */

const getPaymentSnapshot =

  async (

    client,

    paymentId

  ) => {

    const result =

      await client.query(

        `

          SELECT

            p.id,

            p.order_id,

            p.idempotency_key,

            p.amount,

            p.currency,

            p.status,

            p.customer_reference,

            p.external_reference,

            p.transfer_date,

            p.confirmed_at,

            p.confirmed_by,

            p.rejected_at,

            p.rejected_by,

            p.rejection_reason,

            p.notes,

            p.created_at,

            p.updated_at,

            pm.id AS payment_method_id,

            pm.code AS payment_method_code,

            pm.name AS payment_method_name,

            pm.requires_manual_confirmation,

            pp.id AS provider_id,

            pp.code AS provider_code,

            pp.name AS provider_name,

            ba.id AS bank_account_id,

            ba.bank_name,

            ba.account_type,

            ba.account_number,

            ba.account_holder,

            ba.rut AS bank_account_rut,

            ba.email AS bank_account_email,

            ba.currency AS bank_account_currency,

            ba.is_default AS bank_account_is_default

          FROM payments p

          INNER JOIN payment_methods pm

            ON pm.id = p.payment_method_id

          INNER JOIN payment_providers pp

            ON pp.id = p.provider_id

          LEFT JOIN bank_accounts ba

            ON ba.id = p.bank_account_id

          WHERE p.id = $1

          LIMIT 1

        `,

        [paymentId]

      );

    return (

      result.rows[0] ||

      null

    );

  };





/* =========================================

 * CREAR / OBTENER PAGO TRANSFERENCIA

 * Idempotencia local:

 * payments.order_id es UNIQUE.

 * Si ya existe el mismo pago manual para la

 * orden, se devuelve sin crear duplicado.

 * ========================================= */

export const createManualBankTransferPayment =

  async ({

    orderId,

    requesterUserId,

    requesterRole,

  }) => {

    const client =

      await pool.connect();

    try {

      await client.query("BEGIN");

      const orderResult =

        await client.query(

          `

            SELECT

              id,

              order_number,

              user_id,

              email,

              customer_name,

              status,

              payment_status,

              total,

              currency,

              source,

              created_at,

              updated_at

            FROM orders

            WHERE id = $1

            LIMIT 1

            FOR UPDATE

          `,

          [orderId]

        );

      if (orderResult.rowCount === 0) {

        throw createServiceError(

          "La orden no existe",

          404,

          "ORDER_NOT_FOUND"

        );

      }

      const order =

        orderResult.rows[0];

      assertOrderAccess({

        order,

        requesterUserId,

        requesterRole,

      });

      const orderStatus =

        String(

          order.status || ""

        )

          .trim()

          .toUpperCase();

      if (orderStatus === "CANCELLED") {

        throw createServiceError(

          "No se puede iniciar un pago para una orden cancelada",

          409,

          "ORDER_CANCELLED"

        );

      }

      if (

        String(

          order.payment_status || ""

        )

          .trim()

          .toUpperCase() ===

        "PAID"

      ) {

        throw createServiceError(

          "La orden ya se encuentra pagada",

          409,

          "ORDER_ALREADY_PAID"

        );

      }

      const orderTotal =

        roundMoney(

          order.total

        );

      if (

        orderTotal === null ||

        orderTotal <= 0

      ) {

        throw createServiceError(

          "La orden no posee un total válido para iniciar el pago",

          409,

          "ORDER_TOTAL_INVALID"

        );

      }

      /* =====================================

 * VALIDAR RESERVA WEB ANTES DE PAGO

 * ===================================== */

      if (

        String(order.source || "")

          .trim()

          .toUpperCase() === "WEB"

      ) {

        const reservationsResult =

          await client.query(

            `

              SELECT

                id,

                status,

                expires_at

              FROM inventory_reservations

              WHERE order_id = $1

              ORDER BY created_at ASC, id ASC

              FOR UPDATE

            `,

            [order.id]

          );

        if (reservationsResult.rowCount === 0) {

          throw createServiceError(

            "La orden no posee una reserva de stock válida",

            409,

            "ORDER_INVENTORY_RESERVATION_NOT_FOUND"

          );

        }

        for (

          const reservation

          of reservationsResult.rows

        ) {

          const status = String(

            reservation.status || ""

          )

            .trim()

            .toUpperCase();

          if (status === "CONFIRMED") {

            continue;

          }

          if (

            status !== "ACTIVE" ||

            (

              reservation.expires_at &&

              new Date(

                reservation.expires_at

              ).getTime() <= Date.now()

            )

          ) {

            throw createServiceError(

              "La reserva de stock de la orden expiró. Debes crear una nueva orden antes de pagar",

              409,

              "ORDER_INVENTORY_RESERVATION_EXPIRED"

            );

          }

        }

      }

      /**

 * payments.order_id es UNIQUE.

 * Primero verificamos si el pago ya existe.

 */

      const existingResult =

        await client.query(

          `

            SELECT

              p.id,

              p.status,

              pm.code AS payment_method_code,

              pp.code AS provider_code

            FROM payments p

            INNER JOIN payment_methods pm

              ON pm.id = p.payment_method_id

            INNER JOIN payment_providers pp

              ON pp.id = p.provider_id

            WHERE p.order_id = $1

            LIMIT 1

            FOR UPDATE OF p

          `,

          [orderId]

        );

      if (

        existingResult.rowCount >

        0

      ) {

        const existing =

          existingResult.rows[0];

        if (

          existing.payment_method_code !==

            "MANUAL_BANK_TRANSFER" ||

          existing.provider_code !==

            "MANUAL_TRANSFER"

        ) {

          throw createServiceError(

            "La orden ya posee un pago asociado a otro método",

            409,

            "ORDER_PAYMENT_METHOD_CONFLICT"

          );

        }

        const snapshot =

          await getPaymentSnapshot(

            client,

            existing.id

          );

        await client.query("COMMIT");

        return {

          created: false,

          already_existed: true,

          order,

          payment: snapshot,

        };

      }

      const configuration =

        await getManualTransferConfiguration(

          client

        );

      if (

        String(

          configuration

            .bank_account

            .currency ||

          ""

        )

          .trim()

          .toUpperCase() !==

        String(

          order.currency ||

          ""

        )

          .trim()

          .toUpperCase()

      ) {

        throw createServiceError(

          "La moneda de la cuenta bancaria no coincide con la moneda de la orden",

          409,

          "BANK_ACCOUNT_CURRENCY_MISMATCH"

        );

      }

      const insertResult =

        await client.query(

          `

            INSERT INTO payments (

              order_id,

              provider_id,

              payment_method_id,

              bank_account_id,

              amount,

              currency,

              status,

              notes

            )

            VALUES (

              $1,

              $2,

              $3,

              $4,

              $5,

              $6,

              'PENDING',

              'Pago mediante transferencia bancaria manual'

            )

            RETURNING id

          `,

          [

            order.id,

            configuration.provider.id,

            configuration.method.id,

            configuration.bank_account.id,

            orderTotal,

            order.currency,

          ]

        );

      const paymentId =

        insertResult.rows[0].id;

      await client.query(

        `

          UPDATE orders

          SET payment_status =

            CASE

              WHEN payment_status = 'FAILED'

                THEN 'PENDING'

              ELSE payment_status

            END

          WHERE id = $1

        `,

        [order.id]

      );

      const snapshot =

        await getPaymentSnapshot(

          client,

          paymentId

        );

      await client.query("COMMIT");

      return {

        created: true,

        already_existed: false,

        order,

        payment: snapshot,

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

 * OBTENER PAGO DE UNA ORDEN

 * ========================================= */

export const getOrderPayment =

  async ({

    orderId,

    requesterUserId,

    requesterRole,

  }) => {

    const orderResult =

      await pool.query(

        `

          SELECT

            id,

            order_number,

            user_id,

            email,

            customer_name,

            status,

            payment_status,

            total,

            currency,

            source

          FROM orders

          WHERE id = $1

          LIMIT 1

        `,

        [orderId]

      );

    if (orderResult.rowCount === 0) {

      throw createServiceError(

        "La orden no existe",

        404,

        "ORDER_NOT_FOUND"

      );

    }

    const order =

      orderResult.rows[0];

    assertOrderAccess({

      order,

      requesterUserId,

      requesterRole,

    });

    const paymentResult =

      await pool.query(

        `

          SELECT id

          FROM payments

          WHERE order_id = $1

          LIMIT 1

        `,

        [orderId]

      );

    if (paymentResult.rowCount === 0) {

      return {

        order,

        payment: null,

        proofs: [],

      };

    }

    const paymentId =

      paymentResult.rows[0].id;

    const payment =

      await getPaymentSnapshot(

        pool,

        paymentId

      );

    const proofsResult =

      await pool.query(

        `

          SELECT

            id,

            payment_id,

            file_url,

            original_filename,

            mime_type,

            file_size_bytes,

            submitted_amount,

            submitted_bank,

            submitted_reference,

            submitted_at,

            status,

            reviewed_at,

            reviewed_by,

            review_notes,

            created_at,

            updated_at

          FROM bank_transfer_proofs

          WHERE payment_id = $1

          ORDER BY

            submitted_at DESC,

            created_at DESC

        `,

        [paymentId]

      );

    return {

      order,

      payment,

      proofs:

        proofsResult.rows,

    };

  };





/* =========================================

 * SUBIR / REGISTRAR COMPROBANTE

 * IMPORTANTE:

 * - registrar comprobante NO confirma pago;

 * - payment pasa a AWAITING_CONFIRMATION;

 * - order.payment_status pasa a

 * AWAITING_CONFIRMATION;

 * - sólo un ADMIN podrá aprobarlo.

 * ========================================= */

export const submitBankTransferProof =

  async ({

    paymentId,

    requesterUserId,

    requesterRole,

    guestAccessToken = null,

    guestOrderId = null,

    fileUrl,

    originalFilename = null,

    mimeType = null,

    fileSizeBytes = null,

    submittedAmount = null,

    submittedBank = null,

    submittedReference = null,

    transferDate = null,

  }) => {

    const client =

      await pool.connect();

    try {

      await client.query("BEGIN");

      const paymentResult =

        await client.query(

          `

            SELECT

              p.id,

              p.order_id,

              p.amount,

              p.currency,

              p.status,

              p.bank_account_id,

              pm.code AS payment_method_code,

              pp.code AS provider_code,

              o.id AS guest_order_id,

              o.user_id,

              o.order_number,

              o.status AS order_status,

              o.payment_status AS order_payment_status,

              o.guest_access_token_hash,

              o.guest_access_expires_at,

              o.guest_access_revoked_at

            FROM payments p

            INNER JOIN payment_methods pm

              ON pm.id = p.payment_method_id

            INNER JOIN payment_providers pp

              ON pp.id = p.provider_id

            INNER JOIN orders o

              ON o.id = p.order_id

            WHERE p.id = $1

            LIMIT 1

            FOR UPDATE OF p, o

          `,

          [paymentId]

        );

      if (

        paymentResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El pago no existe",

          404,

          "PAYMENT_NOT_FOUND"

        );

      }

      const payment =

        paymentResult.rows[0];

      assertOrderAccess({

        order: {

          id:

            payment.guest_order_id,

          user_id:

            payment.user_id,

          guest_access_token_hash:

            payment.guest_access_token_hash,

          guest_access_expires_at:

            payment.guest_access_expires_at,

          guest_access_revoked_at:

            payment.guest_access_revoked_at,

        },

        requesterUserId,

        requesterRole,

        guestAccessToken,

        guestOrderId,

      });

      if (

        payment.payment_method_code !==

          "MANUAL_BANK_TRANSFER" ||

        payment.provider_code !==

          "MANUAL_TRANSFER"

      ) {

        throw createServiceError(

          "El pago no corresponde a una transferencia bancaria manual",

          409,

          "PAYMENT_NOT_MANUAL_BANK_TRANSFER"

        );

      }

      const paymentStatus =

        String(

          payment.status || ""

        )

          .trim()

          .toUpperCase();

      if (

        [

          "PAID",

          "CANCELLED",

          "PARTIALLY_REFUNDED",

          "REFUNDED",

        ].includes(

          paymentStatus

        )

      ) {

        throw createServiceError(

          `No se puede cargar un comprobante cuando el pago está en ${paymentStatus}`,

          409,

          "PAYMENT_PROOF_NOT_ALLOWED"

        );

      }

      if (

        String(

          payment.order_status ||

          ""

        )

          .trim()

          .toUpperCase() ===

        "CANCELLED"

      ) {

        throw createServiceError(

          "No se puede cargar un comprobante para una orden cancelada",

          409,

          "ORDER_CANCELLED"

        );

      }

      const pendingProofResult =

        await client.query(

          `

            SELECT id

            FROM bank_transfer_proofs

            WHERE payment_id = $1

              AND status = 'PENDING'

            LIMIT 1

            FOR UPDATE

          `,

          [paymentId]

        );

      if (

        pendingProofResult.rowCount >

        0

      ) {

        throw createServiceError(

          "Ya existe un comprobante pendiente de revisión para este pago",

          409,

          "BANK_TRANSFER_PROOF_ALREADY_PENDING"

        );

      }

      const proofResult =

        await client.query(

          `

            INSERT INTO bank_transfer_proofs (

              payment_id,

              file_url,

              original_filename,

              mime_type,

              file_size_bytes,

              submitted_amount,

              submitted_bank,

              submitted_reference,

              status

            )

            VALUES (

              $1,

              $2,

              $3,

              $4,

              $5,

              $6,

              $7,

              $8,

              'PENDING'

            )

            RETURNING

              id,

              payment_id,

              file_url,

              original_filename,

              mime_type,

              file_size_bytes,

              submitted_amount,

              submitted_bank,

              submitted_reference,

              submitted_at,

              status,

              reviewed_at,

              reviewed_by,

              review_notes,

              created_at,

              updated_at

          `,

          [

            paymentId,

            fileUrl,

            originalFilename,

            mimeType,

            fileSizeBytes,

            submittedAmount,

            submittedBank,

            submittedReference,

          ]

        );

      await client.query(

        `

          UPDATE payments

          SET

            status =

              'AWAITING_CONFIRMATION',

            customer_reference =

              COALESCE(

                $2,

                customer_reference

              ),

            transfer_date =

              COALESCE(

                $3::timestamptz,

                transfer_date

              ),

            rejected_at = NULL,

            rejected_by = NULL,

            rejection_reason = NULL

          WHERE id = $1

        `,

        [

          paymentId,

          submittedReference,

          transferDate,

        ]

      );

      await client.query(

        `

          UPDATE orders

          SET payment_status =

            'AWAITING_CONFIRMATION'

          WHERE id = $1

        `,

        [payment.order_id]

      );

      const snapshot =

        await getPaymentSnapshot(

          client,

          paymentId

        );

      await client.query("COMMIT");

      return {

        proof:

          proofResult.rows[0],

        payment:

          snapshot,

        payment_confirmed:

          false,

        requires_admin_review:

          true,

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

 * LISTAR COMPROBANTES ADMIN

 * ========================================= */

export const listBankTransferProofs =

  async ({

    status = "PENDING",

    limit = 50,

    offset = 0,

  } = {}) => {

    const normalizedStatus =

      String(status || "")

        .trim()

        .toUpperCase();

    const validStatuses = [

      "PENDING",

      "APPROVED",

      "REJECTED",

    ];

    if (

      normalizedStatus &&

      !validStatuses.includes(

        normalizedStatus

      )

    ) {

      throw createServiceError(

        "Estado de comprobante inválido",

        400,

        "BANK_TRANSFER_PROOF_STATUS_INVALID"

      );

    }

    const values = [];

    let whereClause = "";

    if (normalizedStatus) {

      values.push(

        normalizedStatus

      );

      whereClause =

        `WHERE btp.status = $${values.length}`;

    }

    values.push(limit);

    const limitParam =

      `$${values.length}`;

    values.push(offset);

    const offsetParam =

      `$${values.length}`;

    const result =

      await pool.query(

        `

          SELECT

            btp.id,

            btp.payment_id,

            btp.file_url,

            btp.original_filename,

            btp.mime_type,

            btp.file_size_bytes,

            btp.submitted_amount,

            btp.submitted_bank,

            btp.submitted_reference,

            btp.submitted_at,

            btp.status,

            btp.reviewed_at,

            btp.reviewed_by,

            btp.review_notes,

            p.amount AS payment_amount,

            p.currency AS payment_currency,

            p.status AS payment_status,

            o.id AS order_id,

            o.order_number,

            o.customer_name,

            o.email,

            o.total AS order_total,

            o.payment_status AS order_payment_status,

            o.status AS order_status,

            billing.document_type AS billing_document_type,

            td.id AS tax_document_id,

            td.document_type AS tax_document_type,

            td.status AS tax_document_status,

            td.external_status AS tax_document_external_status,

            td.relbase_document_id,

            td.folio,

            td.track_id,

            td.relbase_status,

            td.sii_status,

            td.sii_status_name,

            td.issued_at AS tax_document_issued_at,

            td.error_message AS tax_document_error_message,

            td.pdf_url AS tax_document_pdf_url,

            ba.bank_name AS destination_bank,

            ba.account_type AS destination_account_type,

            ba.account_number AS destination_account_number

          FROM bank_transfer_proofs btp

          INNER JOIN payments p

            ON p.id = btp.payment_id

          INNER JOIN orders o

            ON o.id = p.order_id

          LEFT JOIN LATERAL (

            SELECT
              obd.document_type

            FROM order_billing_data obd

            WHERE obd.order_id = o.id

            ORDER BY
              obd.created_at DESC,
              obd.id DESC

            LIMIT 1

          ) billing
            ON TRUE

          LEFT JOIN LATERAL (

            SELECT
              current_td.id,
              current_td.document_type,
              current_td.status,
              current_td.external_status,
              current_td.relbase_document_id,
              current_td.folio,
              current_td.track_id,
              current_td.relbase_status,
              current_td.sii_status,
              current_td.sii_status_name,
              current_td.issued_at,
              current_td.error_message,
              current_td.pdf_url

            FROM tax_documents current_td

            WHERE
              current_td.order_id = o.id

              AND current_td.document_type IN (
                'BOLETA',
                'FACTURA'
              )

            ORDER BY
              current_td.created_at DESC,
              current_td.id DESC

            LIMIT 1

          ) td
            ON TRUE

          LEFT JOIN bank_accounts ba

            ON ba.id = p.bank_account_id

          ${whereClause}

          ORDER BY

            btp.submitted_at ASC,

            btp.created_at ASC

          LIMIT ${limitParam}

          OFFSET ${offsetParam}

        `,

        values

      );

    return result.rows;

  };





/* =========================================

 * APROBAR COMPROBANTE ADMIN

 * Esta es la ÚNICA operación de este módulo

 * que convierte el pago manual en PAID.

 * NO emite DTE.

 * ========================================= */

export const approveBankTransferProof =

  async ({

    proofId,

    reviewedBy,

    reviewNotes = null,

  }) => {

    const client =

      await pool.connect();

    try {

      await client.query("BEGIN");

      const proofResult =

        await client.query(

          `

            SELECT

              btp.id,

              btp.payment_id,

              btp.status,

              btp.submitted_amount,

              btp.submitted_reference,

              p.order_id,

              p.amount AS payment_amount,

              p.currency AS payment_currency,

              p.status AS payment_status,

              pm.code AS payment_method_code,

              pp.code AS provider_code,

              o.order_number,

              o.source AS order_source,

              o.status AS order_status,

              o.payment_status AS order_payment_status,

              o.total AS order_total,

              o.currency AS order_currency

            FROM bank_transfer_proofs btp

            INNER JOIN payments p

              ON p.id = btp.payment_id

            INNER JOIN payment_methods pm

              ON pm.id = p.payment_method_id

            INNER JOIN payment_providers pp

              ON pp.id = p.provider_id

            INNER JOIN orders o

              ON o.id = p.order_id

            WHERE btp.id = $1

            LIMIT 1

            FOR UPDATE OF btp, p, o

          `,

          [proofId]

        );

      if (

        proofResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El comprobante no existe",

          404,

          "BANK_TRANSFER_PROOF_NOT_FOUND"

        );

      }

      const current =

        proofResult.rows[0];

      if (

        String(

          current.status || ""

        )

          .trim()

          .toUpperCase() !==

        "PENDING"

      ) {

        throw createServiceError(

          "El comprobante ya fue revisado",

          409,

          "BANK_TRANSFER_PROOF_ALREADY_REVIEWED"

        );

      }

      if (

        current.payment_method_code !==

          "MANUAL_BANK_TRANSFER" ||

        current.provider_code !==

          "MANUAL_TRANSFER"

      ) {

        throw createServiceError(

          "El comprobante no corresponde a una transferencia manual",

          409,

          "PAYMENT_NOT_MANUAL_BANK_TRANSFER"

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

        throw createServiceError(

          "No se puede aprobar el pago de una orden cancelada",

          409,

          "ORDER_CANCELLED"

        );

      }

      if (

        !moneyMatches(

          current.payment_amount,

          current.order_total

        )

      ) {

        throw createServiceError(

          "El monto del pago no coincide con el total de la orden",

          409,

          "PAYMENT_AMOUNT_MISMATCH"

        );

      }

      if (

        String(

          current.payment_currency || ""

        )

          .trim()

          .toUpperCase() !==

        String(

          current.order_currency || ""

        )

          .trim()

          .toUpperCase()

      ) {

        throw createServiceError(

          "La moneda del pago no coincide con la moneda de la orden",

          409,

          "PAYMENT_CURRENCY_MISMATCH"

        );

      }

      /**

 * Si el cliente informó submitted_amount,

 * también exigimos coincidencia al aprobar.

 * 

 * No confiamos en ese dato para confirmar

 * automáticamente; sólo es una barrera

 * adicional para el ADMIN.

 */

      if (

        current.submitted_amount !==

          null &&

        !moneyMatches(

          current.submitted_amount,

          current.payment_amount

        )

      ) {

        throw createServiceError(

          "El monto informado en el comprobante no coincide con el monto del pago",

          409,

          "BANK_TRANSFER_SUBMITTED_AMOUNT_MISMATCH"

        );

      }

      /* =====================================

 * RESERVA DE STOCK DE ORDEN WEB

 * Las órdenes WEB mantienen reservas

 * ACTIVE hasta confirmar el pago.

 * Al aprobar la transferencia, la reserva

 * se convierte a CONFIRMED y recién ahí

 * incrementamos inventory.reserved_quantity.

 * ===================================== */

      if (

        String(

          current.order_source || ""

        )

          .trim()

          .toUpperCase() === "WEB"

      ) {

        const reservationsResult =

          await client.query(

            `

              SELECT

                ir.id,

                ir.inventory_id,

                ir.quantity,

                ir.status,

                ir.expires_at,

                ir.confirmed_at,

                i.stock_quantity,

                i.reserved_quantity,

                i.safety_stock

              FROM inventory_reservations ir

              INNER JOIN inventory i

                ON i.id = ir.inventory_id

              WHERE ir.order_id = $1

              ORDER BY ir.inventory_id ASC, ir.id ASC

              FOR UPDATE OF ir, i

            `,

            [current.order_id]

          );

        if (reservationsResult.rowCount === 0) {

          throw createServiceError(

            "La orden web no posee reservas de inventario",

            409,

            "ORDER_INVENTORY_RESERVATION_NOT_FOUND"

          );

        }

        const inventoryToConfirm =

          new Map();

        for (

          const reservation

          of reservationsResult.rows

        ) {

          const status = String(

            reservation.status || ""

          )

            .trim()

            .toUpperCase();

          if (status === "CONFIRMED") {

            continue;

          }

          if (status !== "ACTIVE") {

            throw createServiceError(

              "La reserva de inventario de la orden no se encuentra activa",

              409,

              "ORDER_INVENTORY_RESERVATION_INVALID"

            );

          }

          if (

            reservation.expires_at &&

            new Date(

              reservation.expires_at

            ).getTime() <= Date.now()

          ) {

            throw createServiceError(

              "La reserva de stock de la orden expiró; no se puede confirmar el pago automáticamente",

              409,

              "ORDER_INVENTORY_RESERVATION_EXPIRED"

            );

          }

          const inventoryId = String(

            reservation.inventory_id

          );

          const currentQuantity =

            inventoryToConfirm.get(

              inventoryId

            ) || 0;

          inventoryToConfirm.set(

            inventoryId,

            currentQuantity +

              Number(reservation.quantity)

          );

        }

        for (

          const [

            inventoryId,

            quantity,

          ] of inventoryToConfirm.entries()

        ) {

          await client.query(

            `

              UPDATE inventory

              SET reserved_quantity =

                reserved_quantity + $2

              WHERE id = $1

            `,

            [inventoryId, quantity]

          );

        }

        await client.query(

          `

            UPDATE inventory_reservations

            SET

              status = 'CONFIRMED',

              confirmed_at = COALESCE(

                confirmed_at,

                NOW()

              )

            WHERE order_id = $1

              AND status = 'ACTIVE'

          `,

          [current.order_id]

        );

      }

      const reviewedProofResult =

        await client.query(

          `

            UPDATE bank_transfer_proofs

            SET

              status = 'APPROVED',

              reviewed_at = NOW(),

              reviewed_by = $2,

              review_notes = $3

            WHERE id = $1

              AND status = 'PENDING'

            RETURNING

              id,

              payment_id,

              status,

              reviewed_at,

              reviewed_by,

              review_notes

          `,

          [

            proofId,

            reviewedBy,

            reviewNotes,

          ]

        );

      if (

        reviewedProofResult.rowCount !==

        1

      ) {

        throw createServiceError(

          "El comprobante cambió de estado durante la revisión",

          409,

          "BANK_TRANSFER_PROOF_REVIEW_CONFLICT"

        );

      }

      const paymentUpdate =

        await client.query(

          `

            UPDATE payments

            SET

              status = 'PAID',

              confirmed_at = NOW(),

              confirmed_by = $2,

              rejected_at = NULL,

              rejected_by = NULL,

              rejection_reason = NULL

            WHERE id = $1

            RETURNING

              id,

              order_id,

              amount,

              currency,

              status,

              confirmed_at,

              confirmed_by

          `,

          [

            current.payment_id,

            reviewedBy,

          ]

        );

      const orderUpdate =

        await client.query(

          `

            UPDATE orders

            SET

              payment_status = 'PAID',

              status =

                CASE

                  WHEN status = 'PENDING'

                    THEN 'CONFIRMED'

                  ELSE status

                END

            WHERE id = $1

            RETURNING

              id,

              order_number,

              status,

              payment_status,

              total,

              currency

          `,

          [

            current.order_id,

          ]

        );

      const pickupResult =

        await ensureStorePickupForPaidOrder(

          client,

          current.order_id

        );

      await client.query("COMMIT");

      return {

        approved: true,

        dte_emission_executed: false,

        pickup:

          pickupResult

            ?.pickup ||

          null,

        proof:

          reviewedProofResult.rows[0],

        payment:

          paymentUpdate.rows[0],

        order:

          orderUpdate.rows[0],

        next_action:

          "PREPARE_TAX_DOCUMENT",

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

 * RECHAZAR COMPROBANTE ADMIN

 * payments.status -> REJECTED

 * orders.payment_status -> FAILED

 * Luego el cliente podrá subir un nuevo

 * comprobante sobre el mismo payment.

 * ========================================= */

export const rejectBankTransferProof =

  async ({

    proofId,

    reviewedBy,

    reason,

    reviewNotes = null,

  }) => {

    const client =

      await pool.connect();

    try {

      await client.query("BEGIN");

      const proofResult =

        await client.query(

          `

            SELECT

              btp.id,

              btp.payment_id,

              btp.status,

              p.order_id,

              p.status AS payment_status,

              pm.code AS payment_method_code,

              pp.code AS provider_code

            FROM bank_transfer_proofs btp

            INNER JOIN payments p

              ON p.id = btp.payment_id

            INNER JOIN payment_methods pm

              ON pm.id = p.payment_method_id

            INNER JOIN payment_providers pp

              ON pp.id = p.provider_id

            INNER JOIN orders o

              ON o.id = p.order_id

            WHERE btp.id = $1

            LIMIT 1

            FOR UPDATE OF btp, p, o

          `,

          [proofId]

        );

      if (

        proofResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El comprobante no existe",

          404,

          "BANK_TRANSFER_PROOF_NOT_FOUND"

        );

      }

      const current =

        proofResult.rows[0];

      if (

        String(

          current.status || ""

        )

          .trim()

          .toUpperCase() !==

        "PENDING"

      ) {

        throw createServiceError(

          "El comprobante ya fue revisado",

          409,

          "BANK_TRANSFER_PROOF_ALREADY_REVIEWED"

        );

      }

      if (

        current.payment_method_code !==

          "MANUAL_BANK_TRANSFER" ||

        current.provider_code !==

          "MANUAL_TRANSFER"

      ) {

        throw createServiceError(

          "El comprobante no corresponde a una transferencia manual",

          409,

          "PAYMENT_NOT_MANUAL_BANK_TRANSFER"

        );

      }

      const reviewedProofResult =

        await client.query(

          `

            UPDATE bank_transfer_proofs

            SET

              status = 'REJECTED',

              reviewed_at = NOW(),

              reviewed_by = $2,

              review_notes = $3

            WHERE id = $1

              AND status = 'PENDING'

            RETURNING

              id,

              payment_id,

              status,

              reviewed_at,

              reviewed_by,

              review_notes

          `,

          [

            proofId,

            reviewedBy,

            reviewNotes ||

              reason,

          ]

        );

      if (

        reviewedProofResult.rowCount !==

        1

      ) {

        throw createServiceError(

          "El comprobante cambió de estado durante la revisión",

          409,

          "BANK_TRANSFER_PROOF_REVIEW_CONFLICT"

        );

      }

      const paymentUpdate =

        await client.query(

          `

            UPDATE payments

            SET

              status = 'REJECTED',

              rejected_at = NOW(),

              rejected_by = $2,

              rejection_reason = $3,

              confirmed_at = NULL,

              confirmed_by = NULL

            WHERE id = $1

            RETURNING

              id,

              order_id,

              amount,

              currency,

              status,

              rejected_at,

              rejected_by,

              rejection_reason

          `,

          [

            current.payment_id,

            reviewedBy,

            reason,

          ]

        );

      const orderUpdate =

        await client.query(

          `

            UPDATE orders

            SET payment_status =

              'FAILED'

            WHERE id = $1

            RETURNING

              id,

              order_number,

              status,

              payment_status,

              total,

              currency

          `,

          [

            current.order_id,

          ]

        );

      await client.query("COMMIT");

      return {

        rejected: true,

        proof:

          reviewedProofResult.rows[0],

        payment:

          paymentUpdate.rows[0],

        order:

          orderUpdate.rows[0],

        customer_can_resubmit:

          true,

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

 * METADATA COMPROBANTE PARA VISUALIZACIÓN ADMIN

 * ========================================= */

export const getBankTransferProofFileMetadata =

  async ({ proofId }) => {

    const result = await pool.query(

      `

        SELECT

          btp.id,

          btp.payment_id,

          btp.file_url,

          btp.original_filename,

          btp.mime_type,

          btp.file_size_bytes,

          btp.status,

          btp.submitted_at,

          p.order_id,

          o.order_number

        FROM bank_transfer_proofs btp

        INNER JOIN payments p

          ON p.id = btp.payment_id

        INNER JOIN orders o

          ON o.id = p.order_id

        WHERE btp.id = $1

        LIMIT 1

      `,

      [proofId]

    );

    if (result.rowCount === 0) {

      throw createServiceError(

        "El comprobante no existe",

        404,

        "BANK_TRANSFER_PROOF_NOT_FOUND"

      );

    }

    return result.rows[0];

  };
