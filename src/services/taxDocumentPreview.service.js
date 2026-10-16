import pool from "../config/database.js";

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

*   MONTO CLP ENTERO*

*   Los totales del XML real del DTE*

*   aparecen expresados como enteros.*

*   NO usamos esto para PrcItem,*

*   que puede contener decimales.*

*========================================= */

const toClpInteger = (value) => {

  return Math.round(

    toNumber(value)

  );

};

/* =========================================*

*   FECHA YYYY-MM-DD CHILE*

*========================================= */

const getChileDate = () => {

  const formatter =

    new Intl.DateTimeFormat(

      "en-CA",

      {

        timeZone:

          "America/Santiago",

        year: "numeric",

        month: "2-digit",

        day: "2-digit",

      }

    );

  return formatter.format(

    new Date()

  );

};

/* =========================================*

*   OBTENER PREVIEW CANÓNICO DTE*

*========================================= */

export const getTaxDocumentPreview =

  async (orderId) => {

    const client =

      await pool.connect();

    try {

      /* =====================================*

*         1. DOCUMENTO + ORDEN + BILLING*

*      ===================================== */

      const documentResult =

        await client.query(

          `

            SELECT

              td.id AS tax_document_id,

              td.order_id,

              td.idempotency_key,

              td.document_type,

              td.sii_code,

              td.status,

              td.relbase_document_id,

              td.relbase_customer_id,

              td.folio,

              td.net_amount,

              td.exempt_amount,

              td.tax_amount,

              td.total_amount,

              td.created_at AS prepared_at,

              o.order_number,

              o.source,

              o.email AS order_email,

              o.customer_name,

              o.customer_rut,

              o.customer_phone,

              o.currency,

              o.notes AS invoice_observation,

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

                AS billing_relbase_customer_id

            FROM tax_documents td

            INNER JOIN orders o

              ON o.id = td.order_id

            INNER JOIN order_billing_data obd

              ON obd.order_id = o.id

            WHERE

              td.order_id = $1

              AND td.document_type IN (

                'BOLETA',

                'FACTURA'

              )

            LIMIT 1

          `,

          [

            orderId,

          ]

        );

      if (

        documentResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "La orden todavía no posee un documento tributario preparado",

          404,

          "TAX_DOCUMENT_NOT_PREPARED"

        );

      }

      const row =

        documentResult.rows[0];

      /* =====================================*

*         2. DOCUMENTO DEBE ESTAR PENDIENTE*

*         O YA PROCESADO*

*         Preview nunca emite.*

*      ===================================== */

      if (

        ![

          "PENDING",

          "PROCESSING",

          "ISSUED",

          "ACCEPTED",

          "REJECTED",

          "ERROR",

        ].includes(

          row.status

        )

      ) {

        throw createServiceError(

          `Estado tributario no soportado para preview: ${row.status}`,

          409,

          "INVALID_TAX_DOCUMENT_STATUS"

        );

      }

      /* =====================================*

*         3. PAGO*

*      ===================================== */

      const paymentResult =

        await client.query(

          `

            SELECT

              p.id,

              p.status,

              p.amount,

              p.currency,

              p.customer_reference,

              p.external_reference,

              p.confirmed_at,

              pm.code

                AS payment_method_code,

              pm.name

                AS payment_method_name,

              pp.code

                AS payment_provider_code,

              pp.name

                AS payment_provider_name

            FROM payments p

            INNER JOIN payment_methods pm

              ON pm.id =

                 p.payment_method_id

            INNER JOIN payment_providers pp

              ON pp.id =

                 p.provider_id

            WHERE

              p.order_id = $1

            LIMIT 1

          `,

          [

            orderId,

          ]

        );

      const payment =

        paymentResult.rows[0] ||

        null;

      /* =====================================*

*         4. ITEMS*

*      ===================================== */

      const itemsResult =

        await client.query(

          `

            SELECT

              id,

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

            FROM tax_document_items

            WHERE

              tax_document_id = $1

            ORDER BY

              created_at ASC,

              id ASC

          `,

          [

            row.tax_document_id,

          ]

        );

      if (

        itemsResult.rowCount ===

        0

      ) {

        throw createServiceError(

          "El documento tributario no posee detalle",

          409,

          "TAX_DOCUMENT_ITEMS_NOT_FOUND"

        );

      }

      /* =====================================*

*         5. RECEPTOR*

*      ===================================== */

      const receiver =

        row.document_type ===

        "FACTURA"

          ? {

              type:

                row.customer_type,

              rut:

                row.rut,

              legal_name:

                row.legal_name,

              trade_name:

                row.trade_name,

              business_activity:

                row.business_activity,

              email:

                row.billing_email,

              phone:

                row.phone,

              address:

                row.address_line,

              commune:

                row.commune,

              city:

                row.city,

              region:

                row.region,

              country:

                row.country,

              relbase_customer_id:

                row.billing_relbase_customer_id ||

                row.relbase_customer_id ||

                null,

            }

          : {

              type:

                row.customer_type,

              rut:

                row.rut ||

                row.customer_rut ||

                null,

              legal_name:

                row.legal_name ||

                row.customer_name ||

                null,

              email:

                row.billing_email ||

                row.order_email ||

                null,

              phone:

                row.phone ||

                row.customer_phone ||

                null,

              relbase_customer_id:

                row.billing_relbase_customer_id ||

                row.relbase_customer_id ||

                null,

            };

      /* =====================================*

*         6. ITEMS CANÓNICOS*

*      ===================================== */

      const items =

        itemsResult.rows.map(

          (

            item,

            index

          ) => {

            const taxable =

              toNumber(

                item.tax_rate

              ) > 0;

            return {

              line_number:

                index + 1,

              identifiers: {

                sku:

                  item.sku,

                code_type:

                  item.code_type,

                product_code:

                  item.product_code,

                relbase_product_id:

                  item.relbase_product_id,

              },

              name:

                item.description,

              description:

                item.detail_description,

              quantity:

                toNumber(

                  item.quantity

                ),

              /**

*               * Precio UNITARIO NETO*

*               * para productos afectos.*

*               **

*               * Puede contener decimales.*

*               */

              unit_price:

                toNumber(

                  item.unit_price

                ),

              discount_amount:

                toNumber(

                  item.discount_amount

                ),

              tax: {

                taxable,

                rate:

                  toNumber(

                    item.tax_rate

                  ),

                net_amount:

                  toNumber(

                    item.net_amount

                  ),

                exempt_amount:

                  toNumber(

                    item.exempt_amount

                  ),

                tax_amount:

                  toNumber(

                    item.tax_amount

                  ),

              },

              amounts: {

                /**

*                 * Totales internos exactos.*

*                 */

                net:

                  toNumber(

                    item.net_amount

                  ),

                exempt:

                  toNumber(

                    item.exempt_amount

                  ),

                tax:

                  toNumber(

                    item.tax_amount

                  ),

                gross:

                  toNumber(

                    item.total_amount

                  ),

                /**

*                 * Valores candidatos para*

*                 * un DTE CLP.*

*                 **

*                 * El adaptador Relbase*

*                 * decidirá qué campos*

*                 * utilizar finalmente.*

*                 */

                clp: {

                  net:

                    toClpInteger(

                      item.net_amount

                    ),

                  exempt:

                    toClpInteger(

                      item.exempt_amount

                    ),

                  tax:

                    toClpInteger(

                      item.tax_amount

                    ),

                  gross:

                    toClpInteger(

                      item.total_amount

                    ),

                },

              },

            };

          }

        );

      /* =====================================*

*         7. PREVIEW FINAL*

*      ===================================== */

      const preview = {

        schema:

          "LAMINATIWORD_DTE_V1",

        generated_at:

          new Date()

            .toISOString(),

        document: {

          local_id:

            row.tax_document_id,

          order_id:

            row.order_id,

          order_number:

            row.order_number,

          source:

            row.source,

          type:

            row.document_type,

          sii_code:

            row.sii_code,

          /**

*           * Fecha propuesta.*

*           **

*           * Aún NO está siendo emitido.*

*           * La emisión real deberá calcular*

*           * nuevamente la fecha al momento*

*           * del POST.*

*           */

          proposed_issue_date:

            getChileDate(),

          status:

            row.status,

          idempotency_key:

            row.idempotency_key,

          currency:

            row.currency,

          invoice_observation:

            row.document_type ===

              "FACTURA"

              ? (

                  String(

                    row.invoice_observation ||

                    ""

                  ).trim() ||

                  null

                )

              : null,

          relbase_document_id:

            row.relbase_document_id,

          folio:

            row.folio,

        },

        receiver,

        payment:

          payment

            ? {

                status:

                  payment.status,

                amount:

                  toNumber(

                    payment.amount

                  ),

                currency:

                  payment.currency,

                provider: {

                  code:

                    payment

                      .payment_provider_code,

                  name:

                    payment

                      .payment_provider_name,

                },

                method: {

                  code:

                    payment

                      .payment_method_code,

                  name:

                    payment

                      .payment_method_name,

                },

                confirmed_at:

                  payment.confirmed_at,

                /**

*                 * Todavía NO traducimos esto*

*                 * a FmaPago del SII.*

*                 */

                sii_payment_method:

                  null,

              }

            : null,

        totals: {

          internal: {

            net:

              toNumber(

                row.net_amount

              ),

            exempt:

              toNumber(

                row.exempt_amount

              ),

            tax:

              toNumber(

                row.tax_amount

              ),

            total:

              toNumber(

                row.total_amount

              ),

          },

          /**

*           * En XML real los totales CLP*

*           * aparecen como enteros.*

*           */

          clp: {

            net:

              toClpInteger(

                row.net_amount

              ),

            exempt:

              toClpInteger(

                row.exempt_amount

              ),

            tax:

              toClpInteger(

                row.tax_amount

              ),

            total:

              toClpInteger(

                row.total_amount

              ),

          },

        },

        items,

      };

      return preview;

    } finally {

      client.release();

    }

  };