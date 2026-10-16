import pool from "../config/database.js";

import {
  resolveRelbaseCustomerForTaxDocument,
} from "./relbaseCustomer.service.js";

import {
  ensureRelbaseManualCatalogItem,
} from "./relbaseManualCatalog.service.js";

const POS_MANUAL_SERVICE_SKU = String(
  process.env.POS_MANUAL_SERVICE_SKU ||
    "SERV-HPL"
)
  .trim()
  .toUpperCase();

const POS_MANUAL_SUPPLY_SKU = String(
  process.env.POS_MANUAL_SUPPLY_SKU ||
    "INS-HPL"
)
  .trim()
  .toUpperCase();

const LEGACY_MANUAL_SERVICE_SKU =
  "SERVICIO-MANUAL";

const resolveManualKindFromSku = (
  sku
) => {
  const normalized =
    String(sku || "")
      .trim()
      .toUpperCase();

  if (
    normalized ===
      POS_MANUAL_SERVICE_SKU ||
    normalized ===
      LEGACY_MANUAL_SERVICE_SKU
  ) {
    return "SERVICE";
  }

  if (
    normalized ===
    POS_MANUAL_SUPPLY_SKU
  ) {
    return "SUPPLY";
  }

  return null;
};

const resolveManualCatalogForOrder =
  async (orderId) => {
    const result =
      await pool.query(
        `
          SELECT DISTINCT
            sku
          FROM order_items
          WHERE
            order_id = $1
        `,
        [
          orderId,
        ]
      );

    const kinds =
      new Set();

    for (
      const row of result.rows
    ) {
      const kind =
        resolveManualKindFromSku(
          row.sku
        );

      if (kind) {
        kinds.add(kind);
      }
    }

    const resolved = {};

    for (
      const kind of kinds
    ) {
      resolved[kind] =
        await ensureRelbaseManualCatalogItem(
          kind
        );
    }

    return resolved;
  };

/* =========================================*

*   ERROR CONTROLADO*

*========================================= */

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

/* =========================================*

*   NORMALIZAR NÚMERO*

*========================================= */

const toNumber = (

  value,

  defaultValue = 0

) => {

  const number = Number(value);

  return Number.isFinite(number)

    ? number

    : defaultValue;

};

/* =========================================*

*   REDONDEAR MONEDA*

*   Trabajamos con 2 decimales internamente.*

*   La adaptación exacta al payload DTE*

*   de Relbase se hará en el Paso de emisión.*

*========================================= */

const roundMoney = (value) => {

  return (

    Math.round(

      (

        Number(value) +

        Number.EPSILON

      ) * 100

    ) / 100

  );

};

/* =========================================*

*   COMPARAR MONTOS*

*   Permitimos diferencia máxima de $1*

*   debido a redondeos tributarios.*

*========================================= */

const assertMoneyMatches = (

  expected,

  actual,

  message,

  code

) => {

  const difference =

    Math.abs(

      roundMoney(expected) -

      roundMoney(actual)

    );

  if (difference > 1) {

    throw createServiceError(

      `${message}. Esperado: ${roundMoney(

        expected

      )}, calculado: ${roundMoney(

        actual

      )}`,

      409,

      code

    );

  }

};

/* =========================================*

*   CÓDIGO SII*

*========================================= */

const getSiiCode = (

  documentType

) => {

  if (

    documentType ===

    "FACTURA"

  ) {

    return 33;

  }

  if (

    documentType ===

    "BOLETA"

  ) {

    return 39;

  }

  throw createServiceError(

    "Tipo de documento tributario no soportado",

    400,

    "DOCUMENT_TYPE_NOT_SUPPORTED"

  );

};

/* =========================================*

*   VALIDAR FACTURA*

*========================================= */

const validateInvoiceBilling = (

  billing

) => {

  const requiredFields = [

    [

      "rut",

      "RUT",

    ],

    [

      "legal_name",

      "razón social",

    ],

    [

      "business_activity",

      "giro",

    ],

    [

      "address_line",

      "dirección",

    ],

    [

      "commune",

      "comuna",

    ],

    [

      "city",

      "ciudad",

    ],

  ];

  for (

    const [

      field,

      label,

    ] of requiredFields

  ) {

    const value =

      String(

        billing?.[field] ||

          ""

      ).trim();

    if (!value) {

      throw createServiceError(

        `Falta ${label} para preparar la factura`,

        400,

        "INVOICE_BILLING_INCOMPLETE"

      );

    }

  }

};

/* =========================================*

*   VALIDAR BOLETA*

*========================================= */

const validateReceiptBilling = (

  billing

) => {

  if (

    billing.customer_type !==

      "PERSON" &&

    billing.customer_type !==

      "COMPANY"

  ) {

    throw createServiceError(

      "El tipo de cliente de la boleta no es válido",

      400,

      "INVALID_RECEIPT_CUSTOMER_TYPE"

    );

  }

  /**

*   * Boleta no requiere necesariamente*

*   * relbase_customer_id.*

*   **

*   * Esto nos permitirá posteriormente*

*   * emitir boleta a consumidor final.*

*   */

};

/* =========================================*

*   CALCULAR LÍNEA TRIBUTARIA*

*   IMPORTANTE:*

*   order_items.unit_price*

*   = precio comercial BRUTO / IVA incluido*

*   tax_document_items.unit_price*

*   = precio NETO utilizado para el DTE*

*     cuando el producto está afecto.*

*   Ejemplo factura real Relbase:*

*   Bruto unitario:*

*   $49.000*

*   Neto unitario:*

*   $41.176,50*

*   IVA:*

*   19%*

*========================================= */

const calculateTaxLine = (

  item

) => {

  const quantity =

    toNumber(item.quantity);

  const grossUnitPrice =

    roundMoney(

      toNumber(

        item.unit_price

      )

    );

  const grossDiscount =

    roundMoney(

      toNumber(

        item.discount_amount

      )

    );

  const grossSubtotal =

    roundMoney(

      toNumber(

        item.line_subtotal

      )

    );

  const grossTotal =

    roundMoney(

      toNumber(

        item.line_total

      )

    );

  const taxRate =

    toNumber(

      item.tax_rate

    );

  if (quantity <= 0) {

    throw createServiceError(

      `La cantidad del producto ${item.sku} no es válida`,

      409,

      "INVALID_ITEM_QUANTITY"

    );

  }

  if (

    grossUnitPrice < 0 ||

    grossDiscount < 0 ||

    grossSubtotal < 0 ||

    grossTotal < 0

  ) {

    throw createServiceError(

      `El producto ${item.sku} contiene montos inválidos`,

      409,

      "INVALID_ITEM_AMOUNT"

    );

  }

  /**

*   * Validar:*

*   **

*   * unit_price × quantity*

*   * ≈ line_subtotal*

*   */

  const expectedSubtotal =

    roundMoney(

      grossUnitPrice *

        quantity

    );

  assertMoneyMatches(

    grossSubtotal,

    expectedSubtotal,

    `El subtotal del producto ${item.sku} no coincide con cantidad × precio`,

    "ITEM_SUBTOTAL_MISMATCH"

  );

  /**

*   * Validar:*

*   **

*   * line_subtotal - discount*

*   * ≈ line_total*

*   */

  const expectedGrossTotal =

    roundMoney(

      grossSubtotal -

        grossDiscount

    );

  assertMoneyMatches(

    grossTotal,

    expectedGrossTotal,

    `El total del producto ${item.sku} no coincide con subtotal - descuento`,

    "ITEM_TOTAL_MISMATCH"

  );

  /* =====================================*

*     PRODUCTO EXENTO*

*  ===================================== */

  if (taxRate <= 0) {

    return {

      quantity,

      /**

*       * En una línea exenta,*

*       * precio bruto = precio neto/exento.*

*       */

      unit_price:

        grossUnitPrice,

      discount_amount:

        grossDiscount,

      net_amount: 0,

      exempt_amount:

        grossTotal,

      tax_amount: 0,

      total_amount:

        grossTotal,

      source: {

        gross_unit_price:

          grossUnitPrice,

        gross_discount_amount:

          grossDiscount,

        gross_subtotal:

          grossSubtotal,

        gross_total:

          grossTotal,

      },

    };

  }

  /* =====================================*

*     PRODUCTO AFECTO*

*  ===================================== */

  const taxFactor =

    1 +

    taxRate / 100;

  /**

*   * Precio unitario neto.*

*   **

*   * Este es el criterio observado*

*   * en la factura real de Relbase.*

*   */

  const netUnitPrice =

    roundMoney(

      grossUnitPrice /

        taxFactor

    );

  /**

*   * Si existe descuento en el pedido,*

*   * convertimos también el descuento*

*   * bruto a su equivalente neto.*

*   */

  const netDiscount =

    roundMoney(

      grossDiscount /

        taxFactor

    );

  /**

*   * El neto final se calcula desde*

*   * el total bruto real de la línea.*

*   **

*   * Esto evita acumulación de errores*

*   * de redondeo por unidad.*

*   */

  const netAmount =

    roundMoney(

      grossTotal /

        taxFactor

    );

  const taxAmount =

    roundMoney(

      grossTotal -

        netAmount

    );

  return {

    quantity,

    /**

*     * tax_document_items.unit_price*

*     * será NETO.*

*     */

    unit_price:

      netUnitPrice,

    /**

*     * tax_document_items.discount_amount*

*     * también será NETO.*

*     */

    discount_amount:

      netDiscount,

    net_amount:

      netAmount,

    exempt_amount: 0,

    tax_amount:

      taxAmount,

    /**

*     * total_amount conserva*

*     * el valor final IVA incluido.*

*     */

    total_amount:

      grossTotal,

    source: {

      gross_unit_price:

        grossUnitPrice,

      gross_discount_amount:

        grossDiscount,

      gross_subtotal:

        grossSubtotal,

      gross_total:

        grossTotal,

    },

  };

};

/* =========================================*

*   DOCUMENTO PRIMARIO EXISTENTE*

*========================================= */

const getExistingPrimaryDocument =

  async (

    client,

    orderId

  ) => {

    const result =

      await client.query(

        `

          SELECT

            id,

            order_id,

            parent_document_id,

            idempotency_key,

            emission_flow_version,

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

          WHERE

            order_id = $1

            AND

            document_type IN (

              'BOLETA',

              'FACTURA'

            )

          LIMIT 1

        `,

        [

          orderId,

        ]

      );

    return (

      result.rows[0] ||

      null

    );

  };

/* =========================================*

*   ITEMS DE DOCUMENTO EXISTENTE*

*========================================= */

const getTaxDocumentItems =

  async (

    client,

    taxDocumentId

  ) => {

    const result =

      await client.query(

        `

          SELECT

            id,

            tax_document_id,

            order_item_id,

            product_id,

            relbase_product_id,

            sku,

            code_type,

            product_code,

            description,

            detail_description,

            quantity,

            unit_price,

            discount_amount,

            tax_rate,

            net_amount,

            exempt_amount,

            tax_amount,

            total_amount,

            created_at

          FROM tax_document_items

          WHERE

            tax_document_id = $1

          ORDER BY

            created_at ASC,

            id ASC

        `,

        [

          taxDocumentId,

        ]

      );

    return result.rows;

  };

/* =========================================
   ID RELBASE POSITIVO
========================================= */

const toPositiveRelbaseId = (
  value
) => {
  const number = Number(value);

  return (
    Number.isInteger(number) &&
    number > 0
  )
    ? number
    : null;
};

/* =========================================
   RESOLVER CLIENTE RELBASE ANTES DEL BEGIN

   IMPORTANTE:
   - La llamada HTTP a Relbase ocurre fuera de
     la transacción principal.
   - Evitamos mantener SELECT ... FOR UPDATE
     mientras esperamos una API externa.
   - Sólo actualizamos tax_documents si está
     PENDING y aún no existe identidad externa.
========================================= */

const resolveAndPersistRelbaseCustomer =
  async (
    orderId
  ) => {
    const contextResult =
      await pool.query(
        `
          SELECT
            o.id AS order_id,
            o.order_number,
            o.company_id,
            o.email AS order_email,
            o.customer_name,
            o.customer_rut,
            o.customer_phone,
            obd.id AS billing_id,
            obd.document_type,
            obd.customer_type,
            obd.rut,
            obd.legal_name,
            obd.trade_name,
            obd.business_activity,
            obd.billing_email,
            obd.phone,
            obd.address_line,
            obd.commune,
            obd.city,
            obd.region,
            obd.country,
            obd.relbase_customer_id
          FROM orders o
          INNER JOIN order_billing_data obd
            ON obd.order_id = o.id
          WHERE o.id = $1
          LIMIT 1
        `,
        [
          orderId,
        ]
      );

    if (
      contextResult.rowCount ===
      0
    ) {
      return {
        attempted: false,
        resolved: false,
        customer_id: null,
        reason:
          "ORDER_OR_BILLING_NOT_FOUND",
      };
    }

    const context =
      contextResult.rows[0];

    const documentType =
      String(
        context.document_type ||
          ""
      )
        .trim()
        .toUpperCase();

    if (
      documentType ===
      "FACTURA"
    ) {
      validateInvoiceBilling(
        context
      );
    } else if (
      documentType ===
      "BOLETA"
    ) {
      validateReceiptBilling(
        context
      );
    } else {
      throw createServiceError(
        "El tipo de documento tributario no es válido",
        400,
        "INVALID_DOCUMENT_TYPE"
      );
    }

    const existingDocumentResult =
      await pool.query(
        `
          SELECT
            id,
            status,
            relbase_customer_id,
            relbase_document_id,
            request_payload
          FROM tax_documents
          WHERE
            order_id = $1
            AND document_type IN (
              'BOLETA',
              'FACTURA'
            )
          LIMIT 1
        `,
        [
          orderId,
        ]
      );

    const existingDocument =
      existingDocumentResult.rows[0] ||
      null;

    const billingCustomerId =
      toPositiveRelbaseId(
        context.relbase_customer_id
      );

    const documentCustomerId =
      toPositiveRelbaseId(
        existingDocument
          ?.relbase_customer_id
      );

    const alreadyResolvedCustomerId =
      billingCustomerId ||
      documentCustomerId;

    if (
      alreadyResolvedCustomerId
    ) {
      if (!billingCustomerId) {
        await pool.query(
          `
            UPDATE order_billing_data
            SET
              relbase_customer_id = $2,
              updated_at = NOW()
            WHERE order_id = $1
          `,
          [
            orderId,
            alreadyResolvedCustomerId,
          ]
        );
      }

      return {
        attempted: false,
        resolved: true,
        found: true,
        created: false,
        generic_boleta: false,
        customer_id:
          alreadyResolvedCustomerId,
        reason:
          billingCustomerId
            ? "BILLING_CUSTOMER_ALREADY_LINKED"
            : "TAX_DOCUMENT_CUSTOMER_ALREADY_LINKED",
      };
    }

    if (
      existingDocument &&
      (
        String(
          existingDocument.status ||
            ""
        )
          .trim()
          .toUpperCase() !==
          "PENDING" ||
        existingDocument
          .relbase_document_id ||
        existingDocument
          .request_payload
      )
    ) {
      return {
        attempted: false,
        resolved: false,
        customer_id: null,
        generic_boleta:
          documentType ===
          "BOLETA",
        reason:
          "EXISTING_DOCUMENT_NOT_SAFE_TO_REBIND",
      };
    }

    const effectiveRut =
      context.rut ||
      (
        documentType ===
        "BOLETA"
          ? context.customer_rut
          : null
      ) ||
      null;

    const effectiveName =
      context.legal_name ||
      context.customer_name ||
      null;

    const resolution =
      await resolveRelbaseCustomerForTaxDocument({
        document_type:
          documentType,
        customer_type:
          context.customer_type,
        rut:
          effectiveRut,
        legal_name:
          effectiveName,
        trade_name:
          context.trade_name ||
          "",
        business_activity:
          context.business_activity ||
          "",
        email:
          context.billing_email ||
          context.order_email ||
          "",
        phone:
          context.phone ||
          context.customer_phone ||
          "",
        address:
          context.address_line ||
          "",
        city:
          context.city ||
          "",
        commune:
          context.commune ||
          "",
        order_number:
          context.order_number,
        allow_generic_boleta:
          true,
      });

    const resolvedCustomerId =
      toPositiveRelbaseId(
        resolution?.customer_id
      );

    if (!resolvedCustomerId) {
      return {
        attempted: true,
        ...resolution,
        customer_id: null,
      };
    }

    await pool.query(
      `
        UPDATE order_billing_data
        SET
          relbase_customer_id = $2,
          updated_at = NOW()
        WHERE order_id = $1
      `,
      [
        orderId,
        resolvedCustomerId,
      ]
    );

    await pool.query(
      `
        UPDATE tax_documents
        SET
          relbase_customer_id = $2,
          updated_at = NOW()
        WHERE
          order_id = $1
          AND document_type IN (
            'BOLETA',
            'FACTURA'
          )
          AND status = 'PENDING'
          AND relbase_document_id IS NULL
          AND request_payload IS NULL
      `,
      [
        orderId,
        resolvedCustomerId,
      ]
    );

    return {
      attempted: true,
      ...resolution,
      customer_id:
        resolvedCustomerId,
    };
  };

/* =========================================*

*   PREPARAR DOCUMENTO TRIBUTARIO*

*========================================= */

export const prepareTaxDocument =

  async (orderId) => {

    const customerResolution =

      await resolveAndPersistRelbaseCustomer(

        orderId

      );

    /*
     * Antes de abrir la transacción tributaria resolvemos
     * los productos técnicos Relbase de las líneas manuales.
     *
     * - SERVICE -> SERV-HPL
     * - SUPPLY  -> INS-HPL
     *
     * Si el SKU no existe en Relbase se crea automáticamente.
     * Las siguientes facturas reutilizan el mismo registro.
     */
    const manualCatalog =
      await resolveManualCatalogForOrder(
        orderId
      );

    const client =

      await pool.connect();

    try {

      await client.query(

        "BEGIN"

      );

      /* =====================================*

*         1. ORDEN*

*      ===================================== */

      const orderResult =

        await client.query(

          `

            SELECT

              id,

              order_number,

              user_id,

              company_id,

              email,

              customer_name,

              customer_rut,

              customer_phone,

              source,

              status,

              payment_status,

              fulfillment_status,

              subtotal,

              discount_total,

              shipping_total,

              tax_total,

              total,

              currency,

              notes,

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

          "La orden no existe",

          404,

          "ORDER_NOT_FOUND"

        );

      }

      const order =

        orderResult.rows[0];

      /* =====================================*

*         2. VALIDAR ORDEN*

*      ===================================== */

      if (

        order.status ===

        "CANCELLED"

      ) {

        throw createServiceError(

          "No se puede preparar un documento tributario para una orden cancelada",

          409,

          "ORDER_CANCELLED"

        );

      }

      if (

        order.payment_status !==

        "PAID"

      ) {

        throw createServiceError(

          "La orden debe encontrarse pagada antes de preparar el documento tributario",

          409,

          "ORDER_NOT_PAID"

        );

      }

      /**

*       * Laminatiword actualmente*

*       * sólo utiliza retiro en tienda.*

*       **

*       * No permitimos transporte/despacho*

*       * mientras esa funcionalidad no exista.*

*       */

      const shippingTotal =

        roundMoney(

          toNumber(

            order.shipping_total

          )

        );

      if (shippingTotal !== 0) {

        throw createServiceError(

          "La preparación tributaria actual sólo soporta pedidos con retiro en tienda y shipping_total = 0",

          409,

          "SHIPPING_NOT_SUPPORTED"

        );

      }

      /* =====================================*

*         3. PAGO*

*      ===================================== */

      const paymentResult =

        await client.query(

          `

            SELECT

              id,

              order_id,

              provider_id,

              payment_method_id,

              amount,

              currency,

              status,

              customer_reference,

              external_reference,

              confirmed_at,

              confirmed_by,

              created_at,

              updated_at

            FROM payments

            WHERE

              order_id = $1

            LIMIT 1

          `,

          [

            order.id,

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

        payment.status !==

        "PAID"

      ) {

        throw createServiceError(

          "El pago asociado a la orden todavía no está confirmado",

          409,

          "PAYMENT_NOT_PAID"

        );

      }

      assertMoneyMatches(

        order.total,

        payment.amount,

        "El monto pagado no coincide con el total de la orden",

        "PAYMENT_AMOUNT_MISMATCH"

      );

      /* =====================================*

*         4. DATOS TRIBUTARIOS*

*      ===================================== */

      const billingResult =

        await client.query(

          `

            SELECT

              id,

              order_id,

              document_type,

              customer_type,

              rut,

              legal_name,

              trade_name,

              business_activity,

              billing_email,

              phone,

              address_line,

              commune,

              city,

              region,

              country,

              relbase_customer_id,

              created_at,

              updated_at

            FROM order_billing_data

            WHERE

              order_id = $1

            LIMIT 1

          `,

          [

            order.id,

          ]

        );

      if (

        billingResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "La orden no posee datos tributarios",

          409,

          "ORDER_BILLING_DATA_NOT_FOUND"

        );

      }

      const billing =

        billingResult.rows[0];

      const documentType =

        String(

          billing.document_type

        ).toUpperCase();

      if (

        documentType ===

        "FACTURA"

      ) {

        validateInvoiceBilling(

          billing

        );

        if (

          !toPositiveRelbaseId(

            billing.relbase_customer_id

          )

        ) {

          throw createServiceError(

            "La factura requiere un cliente real resuelto en Relbase",

            409,

            "RELBASE_CUSTOMER_REQUIRED"

          );

        }

      } else if (

        documentType ===

        "BOLETA"

      ) {

        validateReceiptBilling(

          billing

        );

      } else {

        throw createServiceError(

          "El tipo de documento tributario no es válido",

          400,

          "INVALID_DOCUMENT_TYPE"

        );

      }

      /* =====================================*

*         5. IDEMPOTENCIA LOCAL*

*         La orden está bloqueada,*

*         por lo que dos requests simultáneos*

*         no crearán dos documentos.*

*      ===================================== */

      const existingDocument =

        await getExistingPrimaryDocument(

          client,

          order.id

        );

      if (existingDocument) {

        const existingItems =

          await getTaxDocumentItems(

            client,

            existingDocument.id

          );

        await client.query(

          "COMMIT"

        );

        return {

          already_prepared:

            true,

          customer_resolution:

            customerResolution,

          order,

          billing,

          payment,

          tax_document:

            existingDocument,

          items:

            existingItems,

        };

      }

      /* =====================================*

*         6. ITEMS DE ORDEN*

*      ===================================== */

      const itemsResult =

        await client.query(

          `

            SELECT

              oi.id,

              oi.order_id,

              oi.product_id,

              oi.sku,

              oi.product_name,

              oi.product_code,

              oi.finish,

              oi.reference_code,

              oi.quantity,

              oi.unit_price,

              oi.discount_amount,

              oi.tax_rate,

              oi.line_subtotal,

              oi.line_total,

              p.relbase_product_id,

              p.description AS product_description

            FROM order_items oi

            LEFT JOIN products p

              ON p.id =

                 oi.product_id

            WHERE

              oi.order_id = $1

            ORDER BY

              oi.created_at ASC,

              oi.id ASC

          `,

          [

            order.id,

          ]

        );

      if (

        itemsResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "La orden no posee productos",

          409,

          "ORDER_ITEMS_NOT_FOUND"

        );

      }

      const orderItems =

        itemsResult.rows;

      /* =====================================*

*         7. CALCULAR LÍNEAS DTE*

*      ===================================== */

      let calculatedGrossSubtotal =

        0;

      let calculatedGrossDiscount =

        0;

      let netAmount =

        0;

      let exemptAmount =

        0;

      let taxAmount =

        0;

      let totalAmount =

        0;

      const calculatedItems =

        orderItems.map(

          (item) => {

            const amounts =

              calculateTaxLine(

                item

              );

            calculatedGrossSubtotal =

              roundMoney(

                calculatedGrossSubtotal +

                  amounts

                    .source

                    .gross_subtotal

              );

            calculatedGrossDiscount =

              roundMoney(

                calculatedGrossDiscount +

                  amounts

                    .source

                    .gross_discount_amount

              );

            netAmount =

              roundMoney(

                netAmount +

                  amounts.net_amount

              );

            exemptAmount =

              roundMoney(

                exemptAmount +

                  amounts.exempt_amount

              );

            taxAmount =

              roundMoney(

                taxAmount +

                  amounts.tax_amount

              );

            totalAmount =

              roundMoney(

                totalAmount +

                  amounts.total_amount

              );

            return {

              ...item,

              dte:

                amounts,

            };

          }

        );

      /* =====================================*

*         8. VALIDAR TOTALES DE ORDEN*

*      ===================================== */

      assertMoneyMatches(

        order.subtotal,

        calculatedGrossSubtotal,

        "El subtotal de la orden no coincide con el detalle de productos",

        "ORDER_SUBTOTAL_MISMATCH"

      );

      assertMoneyMatches(

        order.discount_total,

        calculatedGrossDiscount,

        "El descuento de la orden no coincide con el detalle de productos",

        "ORDER_DISCOUNT_MISMATCH"

      );

      assertMoneyMatches(

        order.tax_total,

        taxAmount,

        "El IVA de la orden no coincide con el IVA calculado",

        "ORDER_TAX_MISMATCH"

      );

      assertMoneyMatches(

        order.total,

        totalAmount,

        "El total de la orden no coincide con el documento tributario",

        "ORDER_TOTAL_MISMATCH"

      );

      /**

*       * Comprobación tributaria final:*

*       **

*       * neto + exento + IVA = total*

*       */

      const reconstructedTotal =

        roundMoney(

          netAmount +

            exemptAmount +

            taxAmount

        );

      assertMoneyMatches(

        totalAmount,

        reconstructedTotal,

        "La composición tributaria del documento no cuadra",

        "TAX_TOTAL_MISMATCH"

      );

      /* =====================================*

*         9. CÓDIGO SII*

*      ===================================== */

      const siiCode =

        getSiiCode(

          documentType

        );

      /* =====================================*

*         10. CREAR TAX DOCUMENT*
*
*         SEGURIDAD FAST-PATH:*
*         emission_flow_version = 2 identifica*
*         exclusivamente documentos creados por*
*         este flujo versionado. Documentos previos*
*         permanecen NULL y jamás usan fast-path.*

*      ===================================== */

      const taxDocumentResult =

        await client.query(

          `

            INSERT INTO tax_documents (

              order_id,

              document_type,

              sii_code,

              relbase_customer_id,

              emission_flow_version,

              status,

              net_amount,

              exempt_amount,

              tax_amount,

              total_amount

            )

            VALUES (

              $1,

              $2,

              $3,

              $4,

              2,

              'PENDING',

              $5,

              $6,

              $7,

              $8

            )

            RETURNING

              id,

              order_id,

              parent_document_id,

              idempotency_key,

              emission_flow_version,

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

              created_at,

              updated_at

          `,

          [

            order.id,

            documentType,

            siiCode,

            billing

              .relbase_customer_id ||

              null,

            netAmount,

            exemptAmount,

            taxAmount,

            totalAmount,

          ]

        );

      const taxDocument =

        taxDocumentResult.rows[0];

      /* =====================================*

*         11. CREAR SNAPSHOT ITEMS DTE*

*      ===================================== */

      const insertedItems = [];

      for (

        const item of

        calculatedItems

      ) {

        const dte =

          item.dte;

        const manualKind =
          resolveManualKindFromSku(
            item.sku
          );

        const manualCatalogItem =
          manualKind
            ? manualCatalog[
                manualKind
              ] || null
            : null;

        if (
          manualKind &&
          !manualCatalogItem?.id
        ) {
          throw createServiceError(
            "No fue posible resolver el producto técnico Relbase de una línea manual",
            500,
            "RELBASE_MANUAL_CATALOG_ITEM_MISSING"
          );
        }

        const resolvedRelbaseProductId =
          manualKind
            ? manualCatalogItem.id
            : item.relbase_product_id ||
              null;

        const resolvedProductCode =
          manualKind
            ? manualCatalogItem.code
            : item.product_code ||
              item.sku ||
              null;

        const resolvedDetailDescription =
          manualKind
            ? item.product_name
            : item.product_description ||
              item.product_name ||
              null;

        const itemResult =

          await client.query(

            `

              INSERT INTO tax_document_items (

                tax_document_id,

                order_item_id,

                product_id,

                relbase_product_id,

                sku,

                code_type,

                product_code,

                description,

                detail_description,

                quantity,

                unit_price,

                discount_amount,

                tax_rate,

                net_amount,

                exempt_amount,

                tax_amount,

                total_amount

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

                $9,

                $10,

                $11,

                $12,

                $13,

                $14,

                $15,

                $16,

                $17

              )

              RETURNING

                id,

                tax_document_id,

                order_item_id,

                product_id,

                relbase_product_id,

                sku,

                code_type,

                product_code,

                description,

                detail_description,

                quantity,

                unit_price,

                discount_amount,

                tax_rate,

                net_amount,

                exempt_amount,

                tax_amount,

                total_amount,

                created_at

            `,

            [

              taxDocument.id,

              item.id,

              item.product_id ||

                null,

              resolvedRelbaseProductId,

              item.sku,

              "INT1",

              resolvedProductCode,

              item.product_name,

              resolvedDetailDescription,

              dte.quantity,

              /**

*               * NETO para afectos.*

*               * Bruto/exento para exentos.*

*               */

              dte.unit_price,

              dte.discount_amount,

              item.tax_rate,

              dte.net_amount,

              dte.exempt_amount,

              dte.tax_amount,

              dte.total_amount,

            ]

          );

        insertedItems.push(

          itemResult.rows[0]

        );

      }

      /* =====================================*

*         12. COMMIT*

*      ===================================== */

      await client.query(

        "COMMIT"

      );

      return {

        already_prepared:

          false,

        customer_resolution:

          customerResolution,

        order,

        billing,

        payment,

        tax_document:

          taxDocument,

        items:

          insertedItems,

        calculation: {

          gross_subtotal:

            calculatedGrossSubtotal,

          gross_discount:

            calculatedGrossDiscount,

          net_amount:

            netAmount,

          exempt_amount:

            exemptAmount,

          tax_amount:

            taxAmount,

          total_amount:

            totalAmount,

        },

      };

    } catch (error) {

      try {

        await client.query(

          "ROLLBACK"

        );

      } catch {

        // La transacción puede

        // haber finalizado.

      }

      throw error;

    } finally {

      client.release();

    }

  };

/* =========================================
   LISTADO ADMIN DE DOCUMENTOS TRIBUTARIOS
========================================= */

export const listAdminTaxDocuments =
  async ({
    query = {},
  } = {}) => {
    const type =
      String(
        query.type ||
        query.document_type ||
        ""
      )
        .trim()
        .toUpperCase();

    const status =
      String(
        query.status ||
        ""
      )
        .trim()
        .toUpperCase();

    const siiStatus =
      String(
        query.sii_status ||
        ""
      )
        .trim()
        .toLowerCase();

    const search =
      String(
        query.q ||
        ""
      ).trim();

    const dateFrom =
      String(
        query.date_from ||
        ""
      ).trim();

    const dateTo =
      String(
        query.date_to ||
        ""
      ).trim();

    const limit =
      Math.min(
        Math.max(
          Number(
            query.limit
          ) || 50,
          1
        ),
        100
      );

    const offset =
      Math.max(
        Number(
          query.offset
        ) || 0,
        0
      );

    const result =
      await pool.query(
        `
          SELECT
            td.id,
            o.id AS order_id,
            o.order_number,
            o.customer_name,
            o.customer_rut,
            o.email,
            o.total AS order_total,
            o.currency,
            o.source AS order_source,
            o.status AS order_status,
            o.payment_status AS order_payment_status,
            o.fulfillment_status,
            o.customer_phone,
            o.created_at AS order_created_at,

            payment.payment_id,
            payment.payment_status,
            payment.payment_amount,
            payment.payment_currency,
            payment.payment_confirmed_at,
            payment.payment_external_reference,
            payment.payment_customer_reference,
            payment.payment_method_code,
            payment.payment_method_name,
            payment.provider_code,
            payment.provider_name,

            obd.legal_name,
            obd.trade_name,
            obd.business_activity,
            obd.billing_email,

            COALESCE(
              td.document_type,
              obd.document_type
            ) AS document_type,

            td.sii_code,

            COALESCE(
              td.status,
              CASE
                WHEN job.status = 'PROCESSING'
                  THEN 'PROCESSING'
                ELSE 'PENDING'
              END
            ) AS status,

            td.folio,
            td.relbase_document_id,
            td.relbase_customer_id,
            td.external_status,
            td.relbase_status,
            td.sii_status,
            td.sii_status_name,
            td.net_amount,
            td.exempt_amount,
            td.tax_amount,
            COALESCE(
              td.total_amount,
              o.total
            ) AS total_amount,
            td.issued_at,
            td.last_status_sync_at,
            td.pdf_url,
            td.xml_url,
            td.error_message,

            COALESCE(
              td.created_at,
              job.created_at,
              o.created_at
            ) AS created_at,

            COALESCE(
              td.updated_at,
              job.updated_at,
              o.updated_at
            ) AS updated_at,

            job.id AS emission_job_id,
            job.status AS emission_job_status,
            job.attempts AS emission_attempts,
            job.last_error AS emission_last_error,
            job.last_error_code AS emission_last_error_code,
            job.processing_started_at,
            job.completed_at,

            COUNT(*) OVER() AS total_count

          FROM orders o

          LEFT JOIN order_billing_data obd
            ON obd.order_id = o.id

          LEFT JOIN LATERAL (
            SELECT
              p.id AS payment_id,
              p.status AS payment_status,
              p.amount AS payment_amount,
              p.currency AS payment_currency,
              p.confirmed_at AS payment_confirmed_at,
              p.external_reference AS payment_external_reference,
              p.customer_reference AS payment_customer_reference,
              pm.code AS payment_method_code,
              pm.name AS payment_method_name,
              pp.code AS provider_code,
              pp.name AS provider_name
            FROM payments p
            LEFT JOIN payment_methods pm
              ON pm.id = p.payment_method_id
            LEFT JOIN payment_providers pp
              ON pp.id = p.provider_id
            WHERE p.order_id = o.id
            ORDER BY
              p.confirmed_at DESC NULLS LAST,
              p.created_at DESC
            LIMIT 1
          ) payment
            ON TRUE

          LEFT JOIN tax_documents td
            ON td.order_id = o.id
           AND td.document_type IN (
             'BOLETA',
             'FACTURA'
           )

          LEFT JOIN tax_document_emission_jobs job
            ON job.order_id = o.id

          WHERE
            (
              td.id IS NOT NULL
              OR job.id IS NOT NULL
            )

            AND (
              $1 = ''
              OR COALESCE(
                td.document_type,
                obd.document_type
              ) = $1
            )

            AND (
              $2 = ''
              OR UPPER(
                COALESCE(
                  td.status,
                  CASE
                    WHEN job.status = 'PROCESSING'
                      THEN 'PROCESSING'
                    ELSE 'PENDING'
                  END
                )
              ) = $2
            )

            AND (
              $3 = ''
              OR LOWER(
                COALESCE(
                  td.sii_status,
                  ''
                )
              ) = $3
            )

            AND (
              $4 = ''
              OR o.order_number ILIKE '%' || $4 || '%'
              OR COALESCE(o.customer_name, '') ILIKE '%' || $4 || '%'
              OR COALESCE(o.customer_rut, '') ILIKE '%' || $4 || '%'
              OR COALESCE(obd.legal_name, '') ILIKE '%' || $4 || '%'
              OR COALESCE(obd.trade_name, '') ILIKE '%' || $4 || '%'
              OR COALESCE(td.folio::text, '') ILIKE '%' || $4 || '%'
              OR COALESCE(td.relbase_document_id::text, '') ILIKE '%' || $4 || '%'
            )

            AND (
              $5::date IS NULL
              OR COALESCE(
                td.created_at,
                job.created_at,
                o.created_at
              )::date >= $5::date
            )

            AND (
              $6::date IS NULL
              OR COALESCE(
                td.created_at,
                job.created_at,
                o.created_at
              )::date <= $6::date
            )

          ORDER BY
            COALESCE(
              td.created_at,
              job.created_at,
              o.created_at
            ) DESC,
            o.id DESC

          LIMIT $7
          OFFSET $8
        `,
        [
          type,
          status,
          siiStatus,
          search,
          dateFrom || null,
          dateTo || null,
          limit,
          offset,
        ]
      );

    const summaryResult =
      await pool.query(
        `
          SELECT
            COUNT(*)::integer AS total,

            COUNT(*) FILTER (
              WHERE COALESCE(
                td.document_type,
                obd.document_type
              ) = 'FACTURA'
            )::integer AS facturas,

            COUNT(*) FILTER (
              WHERE COALESCE(
                td.document_type,
                obd.document_type
              ) = 'BOLETA'
            )::integer AS boletas,

            COUNT(*) FILTER (
              WHERE
                COALESCE(
                  td.status,
                  CASE
                    WHEN job.status = 'PROCESSING'
                      THEN 'PROCESSING'
                    ELSE 'PENDING'
                  END
                ) IN (
                  'PENDING',
                  'PROCESSING'
                )
            )::integer AS en_emision,

            COUNT(*) FILTER (
              WHERE td.status IN (
                'ISSUED',
                'ACCEPTED'
              )
            )::integer AS emitidos,

            COUNT(*) FILTER (
              WHERE
                td.status IN (
                  'ERROR',
                  'REJECTED'
                )
                OR job.status IN (
                  'FAILED',
                  'BLOCKED',
                  'REQUIRES_RECONCILIATION'
                )
            )::integer AS con_error

          FROM orders o

          LEFT JOIN order_billing_data obd
            ON obd.order_id = o.id

          LEFT JOIN tax_documents td
            ON td.order_id = o.id
           AND td.document_type IN (
             'BOLETA',
             'FACTURA'
           )

          LEFT JOIN tax_document_emission_jobs job
            ON job.order_id = o.id

          WHERE
            td.id IS NOT NULL
            OR job.id IS NOT NULL
        `
      );

    const total =
      result.rows.length > 0
        ? Number(
            result.rows[0]
              .total_count ||
            0
          )
        : 0;

    const documents =
      result.rows.map(
        ({
          total_count,
          ...row
        }) => row
      );

    return {
      documents,
      pagination: {
        total,
        limit,
        offset,
        has_more:
          offset +
            documents.length <
          total,
      },
      summary:
        summaryResult.rows[0] || {
          total: 0,
          facturas: 0,
          boletas: 0,
          en_emision: 0,
          emitidos: 0,
          con_error: 0,
        },
    };
  };

