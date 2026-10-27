import crypto from "crypto";

import pool from "../config/database.js";
import { normalizeRut as normalizeChileanRut } from "../utils/rut.utils.js";
import { sendTransactionalEmail } from "./emailTransport.service.js";
import { buildQuotationEmail } from "./emailTemplates.service.js";
import {
  createPosSale,
  ensurePosInvoiceCustomer,
} from "./pos.service.js";
import { buildQuotationPdfBuffer } from "./quotationPdf.service.js";
import {
  createQuotationTracking,
  markQuotationEmailFailed,
  markQuotationEmailSent,
} from "./quotationTracking.service.js";
import {
  resolveRelbaseCustomerForTaxDocument,
} from "./relbaseCustomer.service.js";

const POS_WAREHOUSE_ID = 956;

const FEX_SHIPPING_SKU = String(
  process.env.FEX_SHIPPING_SKU ||
    "FEX-DESPACHO"
)
  .trim()
  .toUpperCase();

const isFexShippingSku = (sku) =>
  String(sku || "")
    .trim()
    .toUpperCase() ===
  FEX_SHIPPING_SKU;

const QUOTATION_DEFAULT_VALID_DAYS = 7;
const QUOTATION_MAX_VALID_DAYS = 30;
const CONVERTIBLE_STATUSES = new Set([
  "DRAFT",
  "SENT",
  "ACCEPTED",
]);

const EDITABLE_STATUSES = new Set([
  "DRAFT",
  "SENT",
  "EXPIRED",
]);

/*
 * Las cotizaciones PROJECT pueden recuperarse aun cuando su vigencia
 * haya expirado. Al guardarlas nuevamente se renueva valid_until y
 * vuelven a DRAFT, conservando id y quote_number.
 */
const PROJECT_EDITABLE_STATUSES = new Set([
  "DRAFT",
  "SENT",
  "EXPIRED",
]);

const createServiceError = (
  message,
  status = 400,
  code = "QUOTATION_ERROR"
) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const cleanText = (value) => String(value ?? "").trim();

const optionalText = (value) => {
  const normalized = cleanText(value);
  return normalized || null;
};

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanText(value)
  );

const requireUuid = (value, label) => {
  if (!isUuid(value)) {
    throw createServiceError(
      `${label} no posee un UUID válido`,
      400,
      "QUOTATION_INVALID_UUID"
    );
  }
  return cleanText(value);
};

const roundMoney = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round((number + Number.EPSILON) * 100) / 100;
};


const optionalNumber = (
  value,
  {
    label,
    min = 0,
    allowZero = true,
  } = {}
) => {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  const valid =
    Number.isFinite(number) &&
    (
      allowZero
        ? number >= min
        : number > min
    );

  if (!valid) {
    throw createServiceError(
      `${label || "El valor"} no es válido`,
      400,
      "QUOTATION_PROJECT_NUMBER_INVALID"
    );
  }

  return number;
};

const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(value));

const dateOnly = (value) => {
  if (!value) return "";
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? raw
    : parsed.toISOString().slice(0, 10);
};

const escapeHtml = (value) =>
  cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const normalizeRut = (value) => {
  const normalized = normalizeChileanRut(value);
  if (!normalized?.valid) {
    throw createServiceError(
      "El RUT chileno no es válido",
      400,
      "QUOTATION_INVALID_RUT"
    );
  }
  return `${normalized.body}-${normalized.dv}`;
};

const calculateGrossTax = ({ grossTotal, taxRate }) => {
  const gross = roundMoney(grossTotal);
  const rate = Number(taxRate);

  if (
    gross === null ||
    gross < 0 ||
    !Number.isFinite(rate) ||
    rate < 0
  ) {
    throw createServiceError(
      "No fue posible calcular los impuestos de la cotización",
      409,
      "QUOTATION_TAX_INVALID"
    );
  }

  if (rate === 0) {
    return {
      net_amount: gross,
      tax_amount: 0,
      total_amount: gross,
    };
  }

  const net = roundMoney(gross / (1 + rate / 100));
  return {
    net_amount: net,
    tax_amount: roundMoney(gross - net),
    total_amount: gross,
  };
};

const normalizeItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw createServiceError(
      "La cotización debe contener al menos un producto",
      400,
      "QUOTATION_ITEMS_REQUIRED"
    );
  }

  const aggregated = new Map();

  for (const item of items) {
    const productId = requireUuid(
      item?.product_id,
      "product_id"
    );

    const quantity = Number(item?.quantity);

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity > 999
    ) {
      throw createServiceError(
        "La cantidad cotizada debe ser mayor que cero y no superar 999",
        400,
        "QUOTATION_ITEM_QUANTITY_INVALID"
      );
    }

    const rawPriceOverride =
      item?.unit_price_override;

    const hasPriceOverride =
      rawPriceOverride !== undefined &&
      rawPriceOverride !== null &&
      String(rawPriceOverride).trim() !== "";

    const priceOverride = hasPriceOverride
      ? roundMoney(rawPriceOverride)
      : null;

    if (
      hasPriceOverride &&
      (
        priceOverride === null ||
        priceOverride <= 0
      )
    ) {
      throw createServiceError(
        "El precio especial de la cotización no es válido",
        400,
        "QUOTATION_ITEM_PRICE_OVERRIDE_INVALID"
      );
    }

    const current = aggregated.get(productId);

    if (current) {
      if (
        current.unit_price_override !== null &&
        priceOverride !== null &&
        Number(current.unit_price_override) !==
          Number(priceOverride)
      ) {
        throw createServiceError(
          "Un mismo producto no puede tener dos precios especiales distintos en la cotización",
          400,
          "QUOTATION_ITEM_PRICE_OVERRIDE_CONFLICT"
        );
      }

      current.quantity += quantity;

      if (
        current.unit_price_override === null &&
        priceOverride !== null
      ) {
        current.unit_price_override =
          priceOverride;
      }

      continue;
    }

    aggregated.set(productId, {
      product_id: productId,
      quantity,
      unit_price_override:
        priceOverride,
    });
  }

  return [...aggregated.values()]
    .sort((a, b) =>
      a.product_id.localeCompare(b.product_id)
    );
};

const normalizeCustomerSnapshot = (body = {}) => {
  const documentType = cleanText(
    body.document_type || "BOLETA"
  ).toUpperCase();

  if (!["BOLETA", "FACTURA"].includes(documentType)) {
    throw createServiceError(
      "document_type debe ser BOLETA o FACTURA",
      400,
      "QUOTATION_DOCUMENT_TYPE_INVALID"
    );
  }

  const customer = body.customer || {};
  const billing = body.billing || {};

  const requestedCustomerType =
    cleanText(
      billing.customer_type ||
      customer.customer_type
    ).toUpperCase();

  const hasCompanyData =
    Boolean(
      cleanText(
        billing.legal_name
      ) ||
      cleanText(
        billing.business_activity
      ) ||
      cleanText(
        billing.trade_name
      )
    );

  const customerType =
    ["PERSON", "COMPANY"].includes(
      requestedCustomerType
    )
      ? requestedCustomerType
      : (
          documentType === "FACTURA" ||
          hasCompanyData
        )
        ? "COMPANY"
        : "PERSON";

  if (
    documentType === "FACTURA" &&
    customerType !== "COMPANY"
  ) {
    throw createServiceError(
      "Las cotizaciones con Factura requieren cliente tipo empresa",
      400,
      "QUOTATION_INVOICE_CUSTOMER_TYPE_INVALID"
    );
  }

  const rut = normalizeRut(
    documentType === "FACTURA"
      ? billing.rut || customer.rut
      : customer.rut || billing.rut
  );

  const isCompany =
    customerType === "COMPANY";

  const customerName =
    isCompany
      ? cleanText(
          billing.legal_name ||
          customer.name
        )
      : cleanText(
          customer.name ||
          billing.legal_name
        );

  const email =
    cleanText(
      billing.billing_email ||
      customer.email
    );

  const phone =
    cleanText(
      billing.phone ||
      customer.phone
    );

  const addressLine =
    cleanText(
      billing.address_line ||
      customer.address
    );

  if (!customerName) {
    throw createServiceError(
      isCompany
        ? "La razón social es obligatoria"
        : "El nombre del cliente es obligatorio",
      400,
      "QUOTATION_CUSTOMER_NAME_REQUIRED"
    );
  }

  if (!email || !isValidEmail(email)) {
    throw createServiceError(
      "El correo del cliente es obligatorio y debe ser válido",
      400,
      "QUOTATION_EMAIL_INVALID"
    );
  }

  if (!phone) {
    throw createServiceError(
      "El teléfono del cliente es obligatorio",
      400,
      "QUOTATION_PHONE_REQUIRED"
    );
  }

  if (!addressLine) {
    throw createServiceError(
      "La dirección del cliente es obligatoria",
      400,
      "QUOTATION_ADDRESS_REQUIRED"
    );
  }

  if (isCompany) {
    const required = [
      [billing.business_activity, "giro"],
      [billing.commune, "comuna"],
      [billing.city, "ciudad"],
    ];

    for (const [value, label] of required) {
      if (!cleanText(value)) {
        throw createServiceError(
          `Falta ${label} para sincronizar el cliente empresa con Relbase`,
          400,
          "QUOTATION_COMPANY_DATA_INCOMPLETE"
        );
      }
    }
  }

  return {
    intended_document_type: documentType,
    customer_type: customerType,
    rut,
    customer_name: customerName,
    legal_name:
      isCompany
        ? cleanText(
            billing.legal_name ||
            customerName
          )
        : null,
    trade_name:
      isCompany
        ? optionalText(
            billing.trade_name
          )
        : null,
    business_activity:
      isCompany
        ? cleanText(
            billing.business_activity
          )
        : null,
    email,
    phone,
    address_line: addressLine,
    commune:
      optionalText(
        billing.commune
      ),
    city:
      optionalText(
        billing.city
      ),
    region:
      optionalText(
        billing.region
      ),
    country:
      cleanText(
        billing.country ||
        "Chile"
      ) ||
      "Chile",
    relbase_customer_id:
      optionalText(
        billing.relbase_customer_id
      ),
  };
};

const synchronizeProjectCustomerWithRelbase =
  async ({
    customer,
    projectName,
  }) => {
    const result =
      await resolveRelbaseCustomerForTaxDocument({
        document_type:
          customer.intended_document_type,
        customer_type:
          customer.customer_type,
        rut:
          customer.rut,
        legal_name:
          customer.legal_name ||
          customer.customer_name,
        trade_name:
          customer.trade_name ||
          customer.customer_name,
        business_activity:
          customer.business_activity ||
          (
            customer.customer_type === "PERSON"
              ? "Particular"
              : ""
          ),
        email:
          customer.email,
        phone:
          customer.phone,
        address:
          customer.address_line,
        city:
          customer.city || "",
        commune:
          customer.commune || "",
        order_number:
          projectName
            ? `Proyecto ${projectName}`
            : "Cotización proyecto",
        allow_generic_boleta: false,
      });

    if (
      !result?.resolved ||
      !result?.customer_id
    ) {
      throw createServiceError(
        "No fue posible vincular el cliente de proyecto con Relbase",
        409,
        "QUOTATION_PROJECT_RELBASE_CUSTOMER_REQUIRED"
      );
    }

    return {
      customer: {
        ...customer,
        relbase_customer_id:
          String(
            result.customer_id
          ),
      },
      sync: {
        action:
          result.created
            ? "CREATED"
            : result.updated
              ? "UPDATED"
              : "FOUND",
        created:
          result.created === true,
        updated:
          result.updated === true,
        changed_fields:
          result.changed_fields || [],
        relbase_customer_id:
          String(
            result.customer_id
          ),
      },
    };
  };

const resolveValidUntil = (rawDays) => {
  const parsed = Number.parseInt(
    String(rawDays ?? QUOTATION_DEFAULT_VALID_DAYS),
    10
  );

  const days = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), QUOTATION_MAX_VALID_DAYS)
    : QUOTATION_DEFAULT_VALID_DAYS;

  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const expireQuotationIfNeeded = async (quotation) => {
  if (!quotation) return quotation;

  if (
    CONVERTIBLE_STATUSES.has(quotation.status) &&
    dateOnly(quotation.valid_until) <
      new Date().toISOString().slice(0, 10)
  ) {
    const updated = await pool.query(
      `
        UPDATE quotations
        SET status = 'EXPIRED'
        WHERE id = $1
          AND status IN ('DRAFT', 'SENT', 'ACCEPTED')
        RETURNING *
      `,
      [quotation.id]
    );

    return updated.rows[0] || {
      ...quotation,
      status: "EXPIRED",
    };
  }

  return quotation;
};

const getQuotationItems = async (quotationId, client = pool) => {
  const result = await client.query(
    `
      SELECT
        id,
        quotation_id,
        product_id,
        sku,
        product_name,
        quantity,
        unit_price_gross,
        unit_price_net,
        tax_rate,
        line_net,
        line_tax,
        line_total,
        created_at
      FROM quotation_items
      WHERE quotation_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [quotationId]
  );

  return result.rows;
};


const getQuotationProjectLines =
  async (
    quotationId,
    client = pool
  ) => {
    const result =
      await client.query(
        `
          SELECT
            id,
            quotation_id,
            line_type,
            product_id,
            description,
            code,
            brand,
            collection,
            italy_price_usd,
            italy_price_source,
            finish,
            thickness_mm,
            quantity,
            unit,
            format_label,
            width_cm,
            height_cm,
            price_m2_gross,
            unit_price_gross,
            line_total_gross,
            tax_rate,
            line_net,
            line_tax,
            pricing_mode,
            sort_order,
            created_at,
            updated_at
          FROM quotation_project_lines
          WHERE quotation_id = $1
          ORDER BY
            sort_order ASC,
            created_at ASC,
            id ASC
        `,
        [
          quotationId,
        ]
      );

    return result.rows;
  };


const normalizeProjectLines =
  (lines) => {
    if (
      !Array.isArray(lines) ||
      lines.length === 0
    ) {
      throw createServiceError(
        "La cotización de proyecto debe contener al menos una línea",
        400,
        "QUOTATION_PROJECT_LINES_REQUIRED"
      );
    }

    return lines.map(
      (
        line,
        index
      ) => {
        const lineType =
          cleanText(
            line?.line_type ||
            "PRODUCT"
          ).toUpperCase();

        if (
          ![
            "PRODUCT",
            "SERVICE",
            "OTHER",
          ].includes(
            lineType
          )
        ) {
          throw createServiceError(
            `El tipo de línea ${index + 1} no es válido`,
            400,
            "QUOTATION_PROJECT_LINE_TYPE_INVALID"
          );
        }

        const productId =
          line?.product_id
            ? requireUuid(
                line.product_id,
                `product_id de línea ${index + 1}`
              )
            : null;

        const quantity =
          optionalNumber(
            line?.quantity,
            {
              label:
                `La cantidad de línea ${index + 1}`,
              min: 0,
              allowZero:
                false,
            }
          );

        if (
          quantity ===
          null
        ) {
          throw createServiceError(
            `La cantidad de línea ${index + 1} es obligatoria`,
            400,
            "QUOTATION_PROJECT_LINE_QUANTITY_REQUIRED"
          );
        }

        const pricingMode =
          cleanText(
            line?.pricing_mode ||
            (
              line?.price_m2_gross !== undefined &&
              line?.price_m2_gross !== null &&
              String(
                line?.price_m2_gross
              ).trim() !== ""
                ? "AREA"
                : "UNIT"
            )
          ).toUpperCase();

        if (
          ![
            "AREA",
            "UNIT",
            "TOTAL",
          ].includes(
            pricingMode
          )
        ) {
          throw createServiceError(
            `El modo de precio de línea ${index + 1} no es válido`,
            400,
            "QUOTATION_PROJECT_PRICING_MODE_INVALID"
          );
        }

        const taxRate =
          optionalNumber(
            line?.tax_rate,
            {
              label:
                `El IVA de línea ${index + 1}`,
              min: 0,
            }
          );

        return {
          line_type:
            lineType,

          product_id:
            productId,

          description:
            optionalText(
              line?.description
            ),

          code:
            optionalText(
              line?.code
            ),

          brand:
            optionalText(
              line?.brand
            ),

          collection:
            optionalText(
              line?.collection
            ),

          italy_price_usd:
            optionalNumber(
              line?.italy_price_usd,
              {
                label:
                  `El Precio Italia USD de línea ${index + 1}`,
                min: 0,
              }
            ),

          finish:
            optionalText(
              line?.finish
            ),

          thickness_mm:
            optionalNumber(
              line
                ?.thickness_mm,
              {
                label:
                  `El espesor de línea ${index + 1}`,
                min: 0,
                allowZero:
                  false,
              }
            ),

          quantity,

          unit:
            cleanText(
              line?.unit ||
              "UN"
            ) || "UN",

          format_label:
            optionalText(
              line
                ?.format_label
            ),

          width_cm:
            optionalNumber(
              line?.width_cm,
              {
                label:
                  `El ancho de línea ${index + 1}`,
                min: 0,
                allowZero:
                  false,
              }
            ),

          height_cm:
            optionalNumber(
              line?.height_cm,
              {
                label:
                  `El alto de línea ${index + 1}`,
                min: 0,
                allowZero:
                  false,
              }
            ),

          price_m2_gross:
            optionalNumber(
              line
                ?.price_m2_gross,
              {
                label:
                  `El valor m² de línea ${index + 1}`,
                min: 0,
              }
            ),

          unit_price_gross:
            optionalNumber(
              line
                ?.unit_price_gross,
              {
                label:
                  `El valor unitario de línea ${index + 1}`,
                min: 0,
              }
            ),

          line_total_gross:
            optionalNumber(
              line
                ?.line_total_gross,
              {
                label:
                  `El total de línea ${index + 1}`,
                min: 0,
              }
            ),

          tax_rate:
            taxRate,

          pricing_mode:
            pricingMode,

          sort_order:
            Number.isInteger(
              Number(
                line
                  ?.sort_order
              )
            ) &&
            Number(
              line
                ?.sort_order
            ) >= 0
              ? Number(
                  line
                    ?.sort_order
                )
              : index,
        };
      }
    );
  };


const resolveProjectLines =
  async ({
    lines,
    client,
  }) => {
    const resolved = [];

    for (
      let index = 0;
      index < lines.length;
      index += 1
    ) {
      const requested =
        lines[index];

      let product =
        null;

      if (
        requested.product_id
      ) {
        const productResult =
          await client.query(
            `
              SELECT
                v.id,
                v.sku,
                v.internal_code,
                v.name,
                v.base_price,
                v.tax_rate,
                v.width_mm,
                v.height_mm,
                v.thickness_mm,
                v.finish,
                v.brand,
                v.collection,
                italy_price.price_usd
                  AS active_italy_price_usd
              FROM vw_product_catalog v
              LEFT JOIN LATERAL (
                SELECT
                  pip.price_usd
                FROM product_italy_prices pip
                WHERE pip.product_id = v.id
                  AND pip.valid_until IS NULL
                ORDER BY
                  pip.valid_from DESC
                LIMIT 1
              ) italy_price
                ON TRUE
              WHERE v.id = $1
              LIMIT 1
            `,
            [
              requested
                .product_id,
            ]
          );

        if (
          productResult
            .rowCount === 0
        ) {
          throw createServiceError(
            `El producto asociado a la línea ${index + 1} no existe`,
            404,
            "QUOTATION_PROJECT_PRODUCT_NOT_FOUND"
          );
        }

        product =
          productResult
            .rows[0];
      }

      const description =
        requested
          .description ||
        optionalText(
          product?.name
        );

      if (
        !description
      ) {
        throw createServiceError(
          `La descripción de la línea ${index + 1} es obligatoria`,
          400,
          "QUOTATION_PROJECT_DESCRIPTION_REQUIRED"
        );
      }

      const widthCm =
        requested
          .width_cm ??
        (
          product
            ?.width_mm !==
            null &&
          product
            ?.width_mm !==
            undefined
            ? roundMoney(
                Number(
                  product
                    .width_mm
                ) / 10
              )
            : null
        );

      const heightCm =
        requested
          .height_cm ??
        (
          product
            ?.height_mm !==
            null &&
          product
            ?.height_mm !==
            undefined
            ? roundMoney(
                Number(
                  product
                    .height_mm
                ) / 10
              )
            : null
        );

      const thicknessMm =
        requested
          .thickness_mm ??
        (
          product
            ?.thickness_mm !==
            null &&
          product
            ?.thickness_mm !==
            undefined
            ? Number(
                product
                  .thickness_mm
              )
            : null
        );

      const priceM2 =
        requested
          .price_m2_gross;

      let unitPrice =
        requested
          .unit_price_gross;

      if (
        unitPrice ===
          null &&
        requested
          .pricing_mode ===
          "AREA" &&
        priceM2 !==
          null &&
        widthCm !==
          null &&
        heightCm !==
          null
      ) {
        unitPrice =
          roundMoney(
            (
              Number(
                widthCm
              ) /
              100
            ) *
              (
                Number(
                  heightCm
                ) /
                100
              ) *
              Number(
                priceM2
              )
          );
      }

      if (
        unitPrice ===
          null &&
        product
          ?.base_price !==
          null &&
        product
          ?.base_price !==
          undefined
      ) {
        unitPrice =
          roundMoney(
            product
              .base_price
          );
      }

      if (
        unitPrice ===
        null
      ) {
        unitPrice = 0;
      }

      let lineTotal =
        requested
          .line_total_gross;

      if (
        lineTotal ===
        null
      ) {
        if (
          requested
            .pricing_mode ===
          "TOTAL"
        ) {
          throw createServiceError(
            `Ingresa el total manual de la línea ${index + 1}`,
            400,
            "QUOTATION_PROJECT_TOTAL_REQUIRED"
          );
        }

        lineTotal =
          roundMoney(
            Number(
              unitPrice
            ) *
              Number(
                requested
                  .quantity
              )
          );
      }

      const taxRate =
        requested
          .tax_rate ??
        (
          product
            ?.tax_rate !==
            null &&
          product
            ?.tax_rate !==
            undefined
            ? Number(
                product
                  .tax_rate
              )
            : 19
        );

      const tax =
        calculateGrossTax({
          grossTotal:
            lineTotal,
          taxRate,
        });

      const isProductLine =
        requested
          .line_type ===
        "PRODUCT";

      const brand =
        isProductLine
          ? (
              requested
                .brand ||
              optionalText(
                product
                  ?.brand
              )
            )
          : null;

      const collection =
        isProductLine
          ? (
              requested
                .collection ||
              optionalText(
                product
                  ?.collection
              )
            )
          : null;

      if (
        isProductLine &&
        !brand
      ) {
        throw createServiceError(
          `La marca del producto en la línea ${index + 1} es obligatoria`,
          400,
          "QUOTATION_PROJECT_PRODUCT_BRAND_REQUIRED"
        );
      }

      /*
       * Canoniza variantes habituales de ABET para que una
       * entrada manual como "Abet" o "Abet Laminati" no quede
       * fuera de Gerencia Italia por diferencias de escritura.
       */
      const normalizedBrand =
        isProductLine
          ? (
              ["ABET", "ABET LAMINATI", "ABETLAMINATI"]
                .includes(
                  cleanText(
                    brand
                  )
                    .toUpperCase()
                    .replace(
                      /\s+/g,
                      " "
                    )
                    .replace(
                      /\s/g,
                      ""
                    ) ===
                    "ABETLAMINATI"
                    ? "ABETLAMINATI"
                    : cleanText(
                        brand
                      )
                        .toUpperCase()
                        .replace(
                          /\s+/g,
                          " "
                        )
                )
                ? "ABET LAMINATI"
                : cleanText(
                    brand
                  )
            )
          : null;

      let italyPriceUsd =
        null;

      let italyPriceSource =
        null;

      /*
       * Un valor Italia ingresado manualmente puede pertenecer
       * tanto a PRODUCT como a SERVICE / OTHER.
       *
       * Esto permite guardar, por ejemplo, el costo USD histórico
       * de un Flete aéreo o Flete marítimo sin mezclar CLP y USD.
       * El fallback de catálogo sigue siendo exclusivo de PRODUCT.
       */
      if (
        requested
          .italy_price_usd !==
          null
      ) {
        italyPriceUsd =
          Number(
            requested
              .italy_price_usd
          );

        italyPriceSource =
          "MANUAL";
      } else if (
        isProductLine &&
        product
          ?.active_italy_price_usd !==
          null &&
        product
          ?.active_italy_price_usd !==
          undefined
      ) {
        italyPriceUsd =
          Number(
            product
              .active_italy_price_usd
          );

        italyPriceSource =
          "CATALOG";
      }

      resolved.push({
        line_type:
          requested
            .line_type,

        product_id:
          requested
            .product_id,

        description,

        code:
          requested
            .code ||
          optionalText(
            product
              ?.internal_code
          ) ||
          optionalText(
            product
              ?.sku
          ),

        brand:
          normalizedBrand,

        collection,

        italy_price_usd:
          italyPriceUsd,

        italy_price_source:
          italyPriceSource,

        finish:
          requested
            .finish ||
          optionalText(
            product
              ?.finish
          ),

        thickness_mm:
          thicknessMm,

        quantity:
          requested
            .quantity,

        unit:
          requested
            .unit,

        format_label:
          requested
            .format_label ||
          (
            widthCm !==
              null &&
            heightCm !==
              null
              ? `${Number(
                  widthCm
                )}x${Number(
                  heightCm
                )} cm`
              : null
          ),

        width_cm:
          widthCm,

        height_cm:
          heightCm,

        price_m2_gross:
          priceM2,

        unit_price_gross:
          roundMoney(
            unitPrice
          ) ?? 0,

        line_total_gross:
          roundMoney(
            lineTotal
          ) ?? 0,

        tax_rate:
          taxRate,

        line_net:
          tax
            .net_amount,

        line_tax:
          tax
            .tax_amount,

        pricing_mode:
          requested
            .pricing_mode,

        sort_order:
          requested
            .sort_order,
      });
    }

    return resolved;
  };


const insertProjectLines =
  async ({
    quotationId,
    lines,
    client,
  }) => {
    const inserted = [];

    for (
      const line
      of lines
    ) {
      const result =
        await client.query(
          `
            INSERT INTO quotation_project_lines (
              quotation_id,
              line_type,
              product_id,
              description,
              code,
              brand,
              collection,
              italy_price_usd,
              italy_price_source,
              finish,
              thickness_mm,
              quantity,
              unit,
              format_label,
              width_cm,
              height_cm,
              price_m2_gross,
              unit_price_gross,
              line_total_gross,
              tax_rate,
              line_net,
              line_tax,
              pricing_mode,
              sort_order
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
              $21,$22,$23,$24
            )
            RETURNING *
          `,
          [
            quotationId,
            line.line_type,
            line.product_id,
            line.description,
            line.code,
            line.brand,
            line.collection,
            line.italy_price_usd,
            line.italy_price_source,
            line.finish,
            line.thickness_mm,
            line.quantity,
            line.unit,
            line.format_label,
            line.width_cm,
            line.height_cm,
            line.price_m2_gross,
            line.unit_price_gross,
            line.line_total_gross,
            line.tax_rate,
            line.line_net,
            line.line_tax,
            line.pricing_mode,
            line.sort_order,
          ]
        );

      inserted.push(
        result.rows[0]
      );
    }

    return inserted;
  };


export const getQuotationById = async ({ quotationId }) => {
  const id = requireUuid(quotationId, "quotationId");

  const result = await pool.query(
    `
      SELECT
        q.*,
        u.first_name AS created_by_first_name,
        u.last_name AS created_by_last_name,
        u.email AS created_by_email,
        o.order_number AS converted_order_number
      FROM quotations q
      INNER JOIN users u
        ON u.id = q.created_by
      LEFT JOIN orders o
        ON o.id = q.converted_order_id
      WHERE q.id = $1
      LIMIT 1
    `,
    [id]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La cotización no existe",
      404,
      "QUOTATION_NOT_FOUND"
    );
  }

  const quotation = await expireQuotationIfNeeded(
    result.rows[0]
  );
  const isProject =
    cleanText(
      quotation
        .quotation_type
    ).toUpperCase() ===
    "PROJECT";

  const items =
    isProject
      ? []
      : await getQuotationItems(
          id
        );

  const projectLines =
    isProject
      ? await getQuotationProjectLines(
          id
        )
      : [];

  return {
    quotation,
    items,
    project_lines:
      projectLines,
  };
};

export const createQuotation = async ({
  createdBy,
  body,
}) => {
  const userId = requireUuid(createdBy, "createdBy");
  const payload = body || {};

  const quotationType =
    cleanText(
      payload.quotation_type ||
        "STANDARD"
    ).toUpperCase();

  if (
    quotationType ===
    "PROJECT"
  ) {
    return createProjectQuotation({
      createdBy:
        userId,
      body:
        payload,
    });
  }

  const items = normalizeItems(payload.items);
  const customer = normalizeCustomerSnapshot(payload);
  const validUntil = resolveValidUntil(payload.valid_days);
  const notes = optionalText(payload.notes);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const resolvedItems = [];
    let netTotal = 0;
    let taxTotal = 0;
    let total = 0;

    for (const requested of items) {
      const result = await client.query(
        `
          SELECT
            p.id AS product_id,
            p.sku,
            p.name,
            p.base_price,
            p.tax_rate,
            p.is_active,
            p.allow_sale,
            i.stock_quantity,
            i.reserved_quantity,
            (i.stock_quantity - i.reserved_quantity) AS available_pos
          FROM products p
          LEFT JOIN inventory i
            ON i.product_id = p.id
           AND i.relbase_warehouse_id = $2
          WHERE p.id = $1
          LIMIT 1
        `,
        [requested.product_id, POS_WAREHOUSE_ID]
      );

      if (result.rowCount === 0) {
        throw createServiceError(
          "Uno de los productos de la cotización no existe",
          404,
          "QUOTATION_PRODUCT_NOT_FOUND"
        );
      }

      const product = result.rows[0];

      const isFexShipping =
        isFexShippingSku(product.sku);

      if (
        product.is_active !== true ||
        product.allow_sale !== true
      ) {
        throw createServiceError(
          `El producto ${product.sku} no está habilitado para venta`,
          409,
          "QUOTATION_PRODUCT_NOT_SALEABLE"
        );
      }

      if (!isFexShipping) {
        if (
          product.stock_quantity === null ||
          product.reserved_quantity === null
        ) {
          throw createServiceError(
            "Uno de los productos no posee inventario en la bodega Showroom",
            409,
            "QUOTATION_PRODUCT_INVENTORY_NOT_FOUND"
          );
        }

        const available = Number(
          product.available_pos
        );

        if (
          available <
          Number(requested.quantity)
        ) {
          throw createServiceError(
            `Stock actual insuficiente para cotizar ${product.sku}. Disponible: ${available}`,
            409,
            "QUOTATION_INSUFFICIENT_CURRENT_STOCK"
          );
        }
      }

      if (
        isFexShipping &&
        Number(requested.quantity) !== 1
      ) {
        throw createServiceError(
          "El despacho FEX debe agregarse una sola vez por cotización",
          400,
          "QUOTATION_FEX_QUANTITY_INVALID"
        );
      }

      if (
        !isFexShipping &&
        requested.unit_price_override !== null
      ) {
        throw createServiceError(
          `No está permitido modificar el precio de ${product.sku}`,
          403,
          "QUOTATION_PRICE_OVERRIDE_NOT_ALLOWED"
        );
      }

      const unitPriceGross = roundMoney(
        isFexShipping
          ? requested.unit_price_override
          : product.base_price
      );

      if (
        isFexShipping &&
        (
          requested.unit_price_override === null ||
          unitPriceGross === null ||
          unitPriceGross <= 0
        )
      ) {
        throw createServiceError(
          "Ingresa el valor informado por FEX antes de guardar la cotización",
          400,
          "QUOTATION_FEX_PRICE_REQUIRED"
        );
      }

      if (unitPriceGross === null || unitPriceGross <= 0) {
        throw createServiceError(
          `El producto ${product.sku} no posee un precio válido`,
          409,
          "QUOTATION_PRODUCT_PRICE_INVALID"
        );
      }

      const lineTotal = roundMoney(
        unitPriceGross * Number(requested.quantity)
      );
      const tax = calculateGrossTax({
        grossTotal: lineTotal,
        taxRate: product.tax_rate,
      });
      const unitPriceNet = roundMoney(
        unitPriceGross /
          (1 + Number(product.tax_rate || 0) / 100)
      );

      netTotal = roundMoney(netTotal + tax.net_amount);
      taxTotal = roundMoney(taxTotal + tax.tax_amount);
      total = roundMoney(total + lineTotal);

      resolvedItems.push({
        product_id: product.product_id,
        sku: product.sku,
        product_name: product.name,
        quantity: requested.quantity,
        unit_price_gross: unitPriceGross,
        unit_price_net:
          Number(product.tax_rate || 0) === 0
            ? unitPriceGross
            : unitPriceNet,
        tax_rate: Number(product.tax_rate || 0),
        line_net: tax.net_amount,
        line_tax: tax.tax_amount,
        line_total: lineTotal,
      });
    }

    const quotationResult = await client.query(
      `
        INSERT INTO quotations (
          created_by,
          intended_document_type,
          customer_type,
          rut,
          customer_name,
          legal_name,
          trade_name,
          business_activity,
          email,
          phone,
          address_line,
          commune,
          city,
          region,
          country,
          relbase_customer_id,
          quotation_type,
          net_total,
          tax_total,
          total,
          valid_until,
          notes
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'STANDARD',$17,$18,$19,$20,$21
        )
        RETURNING *
      `,
      [
        userId,
        customer.intended_document_type,
        customer.customer_type,
        customer.rut,
        customer.customer_name,
        customer.legal_name,
        customer.trade_name,
        customer.business_activity,
        customer.email,
        customer.phone,
        customer.address_line,
        customer.commune,
        customer.city,
        customer.region,
        customer.country,
        customer.relbase_customer_id,
        netTotal,
        taxTotal,
        total,
        validUntil,
        notes,
      ]
    );

    const quotation = quotationResult.rows[0];
    const insertedItems = [];

    for (const item of resolvedItems) {
      const itemResult = await client.query(
        `
          INSERT INTO quotation_items (
            quotation_id,
            product_id,
            sku,
            product_name,
            quantity,
            unit_price_gross,
            unit_price_net,
            tax_rate,
            line_net,
            line_tax,
            line_total
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING *
        `,
        [
          quotation.id,
          item.product_id,
          item.sku,
          item.product_name,
          item.quantity,
          item.unit_price_gross,
          item.unit_price_net,
          item.tax_rate,
          item.line_net,
          item.line_tax,
          item.line_total,
        ]
      );
      insertedItems.push(itemResult.rows[0]);
    }

    await client.query("COMMIT");

    return {
      quotation,
      items: insertedItems,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // noop
    }
    throw error;
  } finally {
    client.release();
  }
};


export const updateQuotation = async ({
  quotationId,
  body,
}) => {
  const id = requireUuid(quotationId, "quotationId");
  const payload = body || {};

  const requestedQuotationType =
    cleanText(
      payload.quotation_type ||
        "STANDARD"
    ).toUpperCase();

  if (
    ![
      "STANDARD",
      "PROJECT",
    ].includes(
      requestedQuotationType
    )
  ) {
    throw createServiceError(
      "quotation_type debe ser STANDARD o PROJECT",
      400,
      "QUOTATION_TYPE_INVALID"
    );
  }

  const convertingToProject =
    requestedQuotationType ===
    "PROJECT";

  const projectName =
    convertingToProject
      ? cleanText(
          payload.project_name
        )
      : null;

  if (
    convertingToProject &&
    !projectName
  ) {
    throw createServiceError(
      "El nombre del proyecto es obligatorio",
      400,
      "QUOTATION_PROJECT_NAME_REQUIRED"
    );
  }

  const projectReference =
    convertingToProject
      ? optionalText(
          payload.project_reference
        )
      : null;

  const visibleToItaly =
    convertingToProject &&
    payload.visible_to_italy ===
      true;

  const requestedItems = normalizeItems(payload.items);
  const customer = normalizeCustomerSnapshot(payload);
  const notes = optionalText(payload.notes);

  const requestedValidUntil = payload.valid_until
    ? dateOnly(payload.valid_until)
    : null;

  if (
    requestedValidUntil &&
    !/^\d{4}-\d{2}-\d{2}$/.test(requestedValidUntil)
  ) {
    throw createServiceError(
      "La fecha de vigencia no es válida",
      400,
      "QUOTATION_VALID_UNTIL_INVALID"
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lockedResult = await client.query(
      `
        SELECT *
        FROM quotations
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [id]
    );

    if (lockedResult.rowCount === 0) {
      throw createServiceError(
        "La cotización no existe",
        404,
        "QUOTATION_NOT_FOUND"
      );
    }

    const currentQuotation = lockedResult.rows[0];

    if (
      cleanText(
        currentQuotation
          .quotation_type
      ).toUpperCase() ===
      "PROJECT"
    ) {
      throw createServiceError(
        "Esta cotización es de proyecto y debe editarse mediante el endpoint de proyecto",
        409,
        "QUOTATION_PROJECT_ENDPOINT_REQUIRED"
      );
    }

    if (!EDITABLE_STATUSES.has(currentQuotation.status)) {
      throw createServiceError(
        `La cotización no puede editarse desde el estado ${currentQuotation.status}`,
        409,
        "QUOTATION_NOT_EDITABLE"
      );
    }

    const dateResult = await client.query(
      `
        SELECT
          (NOW() AT TIME ZONE 'America/Santiago')::date::text AS today,
          (
            (NOW() AT TIME ZONE 'America/Santiago')::date
            + $1::int
          )::text AS max_valid_until
      `,
      [QUOTATION_MAX_VALID_DAYS]
    );

    const today = String(dateResult.rows[0].today);
    const maxValidUntil = String(
      dateResult.rows[0].max_valid_until
    );

    let validUntil = requestedValidUntil;

    if (!validUntil) {
      if (payload.valid_days !== undefined) {
        const parsed = Number.parseInt(
          String(payload.valid_days),
          10
        );

        const days = Number.isFinite(parsed)
          ? Math.min(
              Math.max(parsed, 1),
              QUOTATION_MAX_VALID_DAYS
            )
          : QUOTATION_DEFAULT_VALID_DAYS;

        const validResult = await client.query(
          `
            SELECT (
              (NOW() AT TIME ZONE 'America/Santiago')::date
              + $1::int
            )::text AS valid_until
          `,
          [days]
        );

        validUntil = String(
          validResult.rows[0].valid_until
        );
      } else {
        validUntil = dateOnly(
          currentQuotation.valid_until
        );
      }
    }

    if (
      validUntil < today ||
      validUntil > maxValidUntil
    ) {
      throw createServiceError(
        `La vigencia debe estar entre ${today} y ${maxValidUntil}`,
        400,
        "QUOTATION_VALID_UNTIL_OUT_OF_RANGE"
      );
    }

    const existingItems =
      await getQuotationItems(id, client);

    const existingByProduct = new Map(
      existingItems.map((item) => [
        item.product_id,
        item,
      ])
    );

    const resolvedItems = [];
    let netTotal = 0;
    let taxTotal = 0;
    let total = 0;

    for (const requested of requestedItems) {
      const result = await client.query(
        `
          SELECT
            p.id AS product_id,
            p.sku,
            p.name,
            p.base_price,
            p.tax_rate,
            p.is_active,
            p.allow_sale,
            i.stock_quantity,
            i.reserved_quantity,
            (i.stock_quantity - i.reserved_quantity) AS available_pos
          FROM products p
          LEFT JOIN inventory i
            ON i.product_id = p.id
           AND i.relbase_warehouse_id = $2
          WHERE p.id = $1
          LIMIT 1
        `,
        [
          requested.product_id,
          POS_WAREHOUSE_ID,
        ]
      );

      if (result.rowCount === 0) {
        throw createServiceError(
          "Uno de los productos de la cotización no existe",
          404,
          "QUOTATION_PRODUCT_NOT_FOUND"
        );
      }

      const product = result.rows[0];

      const isFexShipping =
        isFexShippingSku(product.sku);

      if (
        product.is_active !== true ||
        product.allow_sale !== true
      ) {
        throw createServiceError(
          `El producto ${product.sku} no está habilitado para venta`,
          409,
          "QUOTATION_PRODUCT_NOT_SALEABLE"
        );
      }

      if (!isFexShipping) {
        if (
          product.stock_quantity === null ||
          product.reserved_quantity === null
        ) {
          throw createServiceError(
            "Uno de los productos no posee inventario en la bodega Showroom",
            409,
            "QUOTATION_PRODUCT_INVENTORY_NOT_FOUND"
          );
        }

        const available = Number(
          product.available_pos
        );

        if (
          available <
          Number(requested.quantity)
        ) {
          throw createServiceError(
            `Stock actual insuficiente para cotizar ${product.sku}. Disponible: ${available}`,
            409,
            "QUOTATION_INSUFFICIENT_CURRENT_STOCK"
          );
        }
      }

      if (
        isFexShipping &&
        Number(requested.quantity) !== 1
      ) {
        throw createServiceError(
          "El despacho FEX debe agregarse una sola vez por cotización",
          400,
          "QUOTATION_FEX_QUANTITY_INVALID"
        );
      }

      if (
        !isFexShipping &&
        requested.unit_price_override !== null
      ) {
        throw createServiceError(
          `No está permitido modificar el precio de ${product.sku}`,
          403,
          "QUOTATION_PRICE_OVERRIDE_NOT_ALLOWED"
        );
      }

      const previous =
        existingByProduct.get(
          requested.product_id
        ) || null;

      const unitPriceGross = roundMoney(
        isFexShipping
          ? (
              requested.unit_price_override !== null
                ? requested.unit_price_override
                : previous?.unit_price_gross
            )
          : (
              previous
                ? previous.unit_price_gross
                : product.base_price
            )
      );

      const taxRate = Number(
        previous
          ? previous.tax_rate
          : product.tax_rate || 0
      );

      if (
        isFexShipping &&
        (
          unitPriceGross === null ||
          unitPriceGross <= 0
        )
      ) {
        throw createServiceError(
          "Ingresa el valor informado por FEX antes de guardar la cotización",
          400,
          "QUOTATION_FEX_PRICE_REQUIRED"
        );
      }

      if (
        unitPriceGross === null ||
        unitPriceGross <= 0
      ) {
        throw createServiceError(
          `El producto ${product.sku} no posee un precio válido`,
          409,
          "QUOTATION_PRODUCT_PRICE_INVALID"
        );
      }

      const lineTotal = roundMoney(
        unitPriceGross *
          Number(requested.quantity)
      );

      const tax = calculateGrossTax({
        grossTotal: lineTotal,
        taxRate,
      });

      const unitPriceNet =
        taxRate === 0
          ? unitPriceGross
          : roundMoney(
              unitPriceGross /
                (1 + taxRate / 100)
            );

      netTotal = roundMoney(
        netTotal + tax.net_amount
      );
      taxTotal = roundMoney(
        taxTotal + tax.tax_amount
      );
      total = roundMoney(
        total + lineTotal
      );

      resolvedItems.push({
        product_id:
          product.product_id,
        sku:
          previous?.sku ||
          product.sku,
        product_name:
          previous?.product_name ||
          product.name,
        quantity:
          requested.quantity,
        unit_price_gross:
          unitPriceGross,
        unit_price_net:
          unitPriceNet,
        tax_rate:
          taxRate,
        line_net:
          tax.net_amount,
        line_tax:
          tax.tax_amount,
        line_total:
          lineTotal,
      });
    }

    const sameCustomerIdentity =
      cleanText(currentQuotation.rut) ===
        cleanText(customer.rut) &&
      cleanText(
        currentQuotation
          .intended_document_type
      ) ===
        cleanText(
          customer.intended_document_type
        );

    const relbaseCustomerId =
      customer.relbase_customer_id ||
      (
        sameCustomerIdentity
          ? currentQuotation
              .relbase_customer_id
          : null
      );

    const quotationResult =
      await client.query(
        `
          UPDATE quotations
          SET
            intended_document_type = $2,
            customer_type = $3,
            rut = $4,
            customer_name = $5,
            legal_name = $6,
            trade_name = $7,
            business_activity = $8,
            email = $9,
            phone = $10,
            address_line = $11,
            commune = $12,
            city = $13,
            region = $14,
            country = $15,
            relbase_customer_id = $16,

            quotation_type = $17,
            project_name = $18,
            project_reference = $19,

            visible_to_italy = $20,

            italy_visibility_set_at =
              CASE
                WHEN $20 = TRUE
                  THEN NOW()
                ELSE NULL
              END,

            italy_visibility_set_by =
              CASE
                WHEN $20 = TRUE
                  THEN created_by
                ELSE NULL
              END,

            net_total = $21,
            tax_total = $22,
            total = $23,
            valid_until = $24,
            notes = $25,
            status = 'DRAFT',
            sent_at = NULL
          WHERE id = $1
          RETURNING *
        `,
        [
          id,
          customer.intended_document_type,
          customer.customer_type,
          customer.rut,
          customer.customer_name,
          customer.legal_name,
          customer.trade_name,
          customer.business_activity,
          customer.email,
          customer.phone,
          customer.address_line,
          customer.commune,
          customer.city,
          customer.region,
          customer.country,
          relbaseCustomerId,

          convertingToProject
            ? "PROJECT"
            : "STANDARD",

          convertingToProject
            ? projectName
            : null,

          convertingToProject
            ? projectReference
            : null,

          convertingToProject
            ? visibleToItaly
            : false,

          netTotal,
          taxTotal,
          total,
          validUntil,
          notes,
        ]
      );

    await client.query(
      `
        DELETE FROM quotation_items
        WHERE quotation_id = $1
      `,
      [
        id,
      ]
    );

    /*
     * Conversión STANDARD -> PROJECT:
     * - conserva quotation.id y quote_number;
     * - migra las líneas comerciales existentes;
     * - conserva los precios CLP de la cotización;
     * - el trigger de Fase 5 congela Precio Italia
     *   sólo para productos ABET LAMINATI.
     */
    if (
      convertingToProject
    ) {
      await client.query(
        `
          DELETE FROM quotation_project_lines
          WHERE quotation_id = $1
        `,
        [
          id,
        ]
      );

      const projectLines =
        resolvedItems.map(
          (
            item,
            index
          ) => {
            const isShipping =
              isFexShippingSku(
                item.sku
              );

            return {
              line_type:
                isShipping
                  ? "SERVICE"
                  : "PRODUCT",

              product_id:
                isShipping
                  ? null
                  : item.product_id,

              description:
                item.product_name,

              code:
                item.sku,

              finish:
                null,

              thickness_mm:
                null,

              quantity:
                item.quantity,

              unit:
                "UN",

              format_label:
                null,

              width_cm:
                null,

              height_cm:
                null,

              price_m2_gross:
                null,

              unit_price_gross:
                item.unit_price_gross,

              line_total_gross:
                item.line_total,

              tax_rate:
                item.tax_rate,

              pricing_mode:
                "UNIT",

              sort_order:
                index,
            };
          }
        );

      const resolvedProjectLines =
        await resolveProjectLines({
          lines:
            normalizeProjectLines(
              projectLines
            ),
          client,
        });

      const insertedProjectLines =
        await insertProjectLines({
          quotationId:
            id,
          lines:
            resolvedProjectLines,
          client,
        });

      await client.query(
        "COMMIT"
      );

      return {
        quotation:
          quotationResult.rows[0],

        items:
          [],

        project_lines:
          insertedProjectLines,

        edited:
          true,

        converted_to_project:
          true,

        previous_status:
          currentQuotation.status,
      };
    }

    /*
     * STANDARD:
     * fuerza visible_to_italy = FALSE para
     * mantener la regla de seguridad.
     */
    const insertedItems =
      [];

    for (
      const item
      of resolvedItems
    ) {
      const itemResult =
        await client.query(
          `
            INSERT INTO quotation_items (
              quotation_id,
              product_id,
              sku,
              product_name,
              quantity,
              unit_price_gross,
              unit_price_net,
              tax_rate,
              line_net,
              line_tax,
              line_total
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
            )
            RETURNING *
          `,
          [
            id,
            item.product_id,
            item.sku,
            item.product_name,
            item.quantity,
            item.unit_price_gross,
            item.unit_price_net,
            item.tax_rate,
            item.line_net,
            item.line_tax,
            item.line_total,
          ]
        );

      insertedItems.push(
        itemResult.rows[0]
      );
    }

    await client.query(
      "COMMIT"
    );

    return {
      quotation:
        quotationResult.rows[0],

      items:
        insertedItems,

      edited:
        true,

      converted_to_project:
        false,

      previous_status:
        currentQuotation.status,
    };
  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {
      // noop
    }

    throw error;
  } finally {
    client.release();
  }
};



export const createProjectQuotation =
  async ({
    createdBy,
    body,
  }) => {
    const userId =
      requireUuid(
        createdBy,
        "createdBy"
      );

    const payload =
      body || {};

    let customer =
      normalizeCustomerSnapshot(
        payload
      );

    const projectName =
      cleanText(
        payload
          .project_name
      );

    if (
      !projectName
    ) {
      throw createServiceError(
        "El nombre del proyecto es obligatorio",
        400,
        "QUOTATION_PROJECT_NAME_REQUIRED"
      );
    }

    const projectReference =
      optionalText(
        payload
          .project_reference
      );

    const visibleToItaly =
      payload
        .visible_to_italy ===
        true;

    const validUntil =
      resolveValidUntil(
        payload
          .valid_days
      );

    const notes =
      optionalText(
        payload
          .notes
      );

    const requestedLines =
      normalizeProjectLines(
        payload.lines
      );

    const customerSynchronization =
      await synchronizeProjectCustomerWithRelbase({
        customer,
        projectName,
      });

    customer =
      customerSynchronization.customer;

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const resolvedLines =
        await resolveProjectLines({
          lines:
            requestedLines,
          client,
        });

      let netTotal = 0;
      let taxTotal = 0;
      let total = 0;

      for (
        const line
        of resolvedLines
      ) {
        netTotal =
          roundMoney(
            netTotal +
              Number(
                line
                  .line_net
              )
          );

        taxTotal =
          roundMoney(
            taxTotal +
              Number(
                line
                  .line_tax
              )
          );

        total =
          roundMoney(
            total +
              Number(
                line
                  .line_total_gross
              )
          );
      }

      const quotationResult =
        await client.query(
          `
            INSERT INTO quotations (
              created_by,
              intended_document_type,
              customer_type,
              rut,
              customer_name,
              legal_name,
              trade_name,
              business_activity,
              email,
              phone,
              address_line,
              commune,
              city,
              region,
              country,
              relbase_customer_id,
              quotation_type,
              project_name,
              project_reference,
              visible_to_italy,
              italy_visibility_set_at,
              italy_visibility_set_by,
              net_total,
              tax_total,
              total,
              valid_until,
              notes
            )
            VALUES (
              $1::uuid,
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
              $16::text,
              'PROJECT',
              $17,
              $18,
              $19::boolean,
              CASE
                WHEN $19::boolean
                  THEN NOW()
                ELSE NULL
              END,
              $20::uuid,
              $21,
              $22,
              $23,
              $24,
              $25
            )
            RETURNING *
          `,
          [
            userId,
            customer
              .intended_document_type,
            customer
              .customer_type,
            customer
              .rut,
            customer
              .customer_name,
            customer
              .legal_name,
            customer
              .trade_name,
            customer
              .business_activity,
            customer
              .email,
            customer
              .phone,
            customer
              .address_line,
            customer
              .commune,
            customer
              .city,
            customer
              .region,
            customer
              .country,
            customer
              .relbase_customer_id,
            projectName,
            projectReference,
            visibleToItaly,
            visibleToItaly
              ? userId
              : null,
            netTotal,
            taxTotal,
            total,
            validUntil,
            notes,
          ]
        );

      const quotation =
        quotationResult
          .rows[0];

      const projectLines =
        await insertProjectLines({
          quotationId:
            quotation.id,
          lines:
            resolvedLines,
          client,
        });

      await client.query(
        "COMMIT"
      );

      return {
        quotation,
        items: [],
        project_lines:
          projectLines,
        relbase_customer_sync:
          customerSynchronization.sync,
      };
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // noop
      }

      throw error;
    } finally {
      client.release();
    }
  };


export const updateProjectQuotation =
  async ({
    quotationId,
    body,
  }) => {
    const id =
      requireUuid(
        quotationId,
        "quotationId"
      );

    const payload =
      body || {};

    let customer =
      normalizeCustomerSnapshot(
        payload
      );

    const projectName =
      cleanText(
        payload
          .project_name
      );

    if (
      !projectName
    ) {
      throw createServiceError(
        "El nombre del proyecto es obligatorio",
        400,
        "QUOTATION_PROJECT_NAME_REQUIRED"
      );
    }

    const projectReference =
      optionalText(
        payload
          .project_reference
      );

    const requestedVisibleToItaly =
      payload
        .visible_to_italy;

    const notes =
      optionalText(
        payload
          .notes
      );

    const requestedLines =
      normalizeProjectLines(
        payload.lines
      );

    const customerSynchronization =
      await synchronizeProjectCustomerWithRelbase({
        customer,
        projectName,
      });

    customer =
      customerSynchronization.customer;

    const requestedValidUntil =
      payload
        .valid_until
        ? dateOnly(
            payload
              .valid_until
          )
        : null;

    if (
      requestedValidUntil &&
      !/^\d{4}-\d{2}-\d{2}$/.test(
        requestedValidUntil
      )
    ) {
      throw createServiceError(
        "La fecha de vigencia no es válida",
        400,
        "QUOTATION_VALID_UNTIL_INVALID"
      );
    }

    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const lockedResult =
        await client.query(
          `
            SELECT *
            FROM quotations
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
          `,
          [
            id,
          ]
        );

      if (
        lockedResult
          .rowCount ===
        0
      ) {
        throw createServiceError(
          "La cotización no existe",
          404,
          "QUOTATION_NOT_FOUND"
        );
      }

      const currentQuotation =
        lockedResult
          .rows[0];

      if (
        cleanText(
          currentQuotation
            .quotation_type
        ).toUpperCase() !==
        "PROJECT"
      ) {
        throw createServiceError(
          "La cotización no es de tipo PROJECT",
          409,
          "QUOTATION_NOT_PROJECT"
        );
      }

      if (
        !PROJECT_EDITABLE_STATUSES.has(
          cleanText(
            currentQuotation
              .status
          ).toUpperCase()
        )
      ) {
        throw createServiceError(
          `La cotización no puede editarse desde el estado ${currentQuotation.status}`,
          409,
          "QUOTATION_NOT_EDITABLE"
        );
      }

      const visibleToItaly =
        requestedVisibleToItaly ===
        undefined
          ? Boolean(
              currentQuotation
                .visible_to_italy
            )
          : requestedVisibleToItaly ===
            true;

      const dateResult =
        await client.query(
          `
            SELECT
              (NOW() AT TIME ZONE 'America/Santiago')::date::text
                AS today,
              (
                (NOW() AT TIME ZONE 'America/Santiago')::date
                + $1::int
              )::text
                AS max_valid_until
          `,
          [
            QUOTATION_MAX_VALID_DAYS,
          ]
        );

      const today =
        String(
          dateResult
            .rows[0]
            .today
        );

      const maxValidUntil =
        String(
          dateResult
            .rows[0]
            .max_valid_until
        );

      const currentValidUntil =
        dateOnly(
          currentQuotation
            .valid_until
        );

      const recoveringExpiredQuotation =
        cleanText(
          currentQuotation
            .status
        ).toUpperCase() ===
          "EXPIRED" ||
        currentValidUntil <
          today;

      let validUntil =
        requestedValidUntil;

      if (
        !validUntil
      ) {
        if (
          payload
            .valid_days !==
          undefined
        ) {
          const parsed =
            Number.parseInt(
              String(
                payload
                  .valid_days
              ),
              10
            );

          const days =
            Number.isFinite(
              parsed
            )
              ? Math.min(
                  Math.max(
                    parsed,
                    1
                  ),
                  QUOTATION_MAX_VALID_DAYS
                )
              : QUOTATION_DEFAULT_VALID_DAYS;

          const validResult =
            await client.query(
              `
                SELECT (
                  (NOW() AT TIME ZONE 'America/Santiago')::date
                  + $1::int
                )::text AS valid_until
              `,
              [
                days,
              ]
            );

          validUntil =
            String(
              validResult
                .rows[0]
                .valid_until
            );
        } else if (
          recoveringExpiredQuotation
        ) {
          const recoveryValidResult =
            await client.query(
              `
                SELECT (
                  (NOW() AT TIME ZONE 'America/Santiago')::date
                  + $1::int
                )::text AS valid_until
              `,
              [
                QUOTATION_DEFAULT_VALID_DAYS,
              ]
            );

          validUntil =
            String(
              recoveryValidResult
                .rows[0]
                .valid_until
            );
        } else {
          validUntil =
            currentValidUntil;
        }
      }

      if (
        validUntil <
        today
      ) {
        throw createServiceError(
          "La fecha de vigencia no puede ser anterior a hoy",
          400,
          "QUOTATION_VALID_UNTIL_PAST"
        );
      }

      if (
        validUntil >
        maxValidUntil
      ) {
        throw createServiceError(
          `La vigencia máxima permitida es de ${QUOTATION_MAX_VALID_DAYS} días`,
          400,
          "QUOTATION_VALID_UNTIL_TOO_LONG"
        );
      }

      const resolvedLines =
        await resolveProjectLines({
          lines:
            requestedLines,
          client,
        });

      let netTotal = 0;
      let taxTotal = 0;
      let total = 0;

      for (
        const line
        of resolvedLines
      ) {
        netTotal =
          roundMoney(
            netTotal +
              Number(
                line
                  .line_net
              )
          );

        taxTotal =
          roundMoney(
            taxTotal +
              Number(
                line
                  .line_tax
              )
          );

        total =
          roundMoney(
            total +
              Number(
                line
                  .line_total_gross
              )
          );
      }

      const sameCustomerIdentity =
        cleanText(
          currentQuotation
            .rut
        ) ===
          cleanText(
            customer.rut
          ) &&
        cleanText(
          currentQuotation
            .intended_document_type
        ) ===
          cleanText(
            customer
              .intended_document_type
          );

      const relbaseCustomerId =
        customer
          .relbase_customer_id ||
        (
          sameCustomerIdentity
            ? currentQuotation
                .relbase_customer_id
            : null
        );

      const quotationResult =
        await client.query(
          `
            UPDATE quotations
            SET
              intended_document_type = $2,
              customer_type = $3,
              rut = $4,
              customer_name = $5,
              legal_name = $6,
              trade_name = $7,
              business_activity = $8,
              email = $9,
              phone = $10,
              address_line = $11,
              commune = $12,
              city = $13,
              region = $14,
              country = $15,
              relbase_customer_id = $16::text,
              project_name = $17,
              project_reference = $18,
              visible_to_italy = $19::boolean,
              italy_visibility_set_at =
                CASE
                  WHEN $19::boolean
                    THEN COALESCE(
                      italy_visibility_set_at,
                      NOW()
                    )
                  ELSE NULL
                END,
              italy_visibility_set_by =
                CASE
                  WHEN $19::boolean
                    THEN COALESCE(
                      italy_visibility_set_by,
                      created_by
                    )
                  ELSE NULL
                END,
              net_total = $20,
              tax_total = $21,
              total = $22,
              valid_until = $23,
              notes = $24,
              status = 'DRAFT',
              sent_at = NULL
            WHERE id = $1
            RETURNING *
          `,
          [
            id,
            customer
              .intended_document_type,
            customer
              .customer_type,
            customer
              .rut,
            customer
              .customer_name,
            customer
              .legal_name,
            customer
              .trade_name,
            customer
              .business_activity,
            customer
              .email,
            customer
              .phone,
            customer
              .address_line,
            customer
              .commune,
            customer
              .city,
            customer
              .region,
            customer
              .country,
            relbaseCustomerId,
            projectName,
            projectReference,
            visibleToItaly,
            netTotal,
            taxTotal,
            total,
            validUntil,
            notes,
          ]
        );

      await client.query(
        `
          DELETE FROM quotation_project_lines
          WHERE quotation_id = $1
        `,
        [
          id,
        ]
      );

      const projectLines =
        await insertProjectLines({
          quotationId:
            id,
          lines:
            resolvedLines,
          client,
        });

      await client.query(
        "COMMIT"
      );

      return {
        quotation:
          quotationResult
            .rows[0],

        items: [],

        project_lines:
          projectLines,

        edited:
          true,

        previous_status:
          currentQuotation
            .status,

        relbase_customer_sync:
          customerSynchronization.sync,
      };
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // noop
      }

      throw error;
    } finally {
      client.release();
    }
  };


export const listQuotations = async ({ query = {} } = {}) => {
  const search = optionalText(query.search);
  const status = optionalText(query.status)?.toUpperCase() || null;
  const quotationType =
    optionalText(
      query.type ||
      query.quotation_type
    )?.toUpperCase() ||
    null;

  if (
    quotationType &&
    ![
      "STANDARD",
      "PROJECT",
    ].includes(
      quotationType
    )
  ) {
    throw createServiceError(
      "type debe ser STANDARD o PROJECT",
      400,
      "QUOTATION_TYPE_INVALID"
    );
  }

  const page = Math.max(Number.parseInt(String(query.page || 1), 10) || 1, 1);
  const limit = Math.min(
    Math.max(Number.parseInt(String(query.limit || 20), 10) || 20, 1),
    100
  );
  const offset = (page - 1) * limit;

  const values = [];
  const conditions = ["1=1"];

  if (search) {
    values.push(`%${search}%`);
    const p = `$${values.length}`;
    conditions.push(`(
      q.quote_number ILIKE ${p}
      OR q.rut ILIKE ${p}
      OR q.customer_name ILIKE ${p}
      OR COALESCE(q.legal_name, '') ILIKE ${p}
      OR q.email ILIKE ${p}
      OR COALESCE(q.project_name, '') ILIKE ${p}
      OR COALESCE(q.project_reference, '') ILIKE ${p}
      OR EXISTS (
        SELECT 1
        FROM quotation_items qi_search
        WHERE qi_search.quotation_id = q.id
          AND (
            qi_search.sku ILIKE ${p}
            OR qi_search.product_name ILIKE ${p}
          )
      )
      OR EXISTS (
        SELECT 1
        FROM quotation_project_lines qpl_search
        WHERE qpl_search.quotation_id = q.id
          AND (
            COALESCE(qpl_search.code, '') ILIKE ${p}
            OR qpl_search.description ILIKE ${p}
            OR COALESCE(qpl_search.finish, '') ILIKE ${p}
          )
      )
    )`);
  }

  if (status) {
    values.push(status);
    conditions.push(`q.status = $${values.length}`);
  }

  if (
    quotationType
  ) {
    values.push(
      quotationType
    );

    conditions.push(
      `q.quotation_type = $${values.length}`
    );
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM quotations q WHERE ${conditions.join(
      " AND "
    )}`,
    values
  );

  const listValues = [...values, limit, offset];
  const result = await pool.query(
    `
      SELECT
        q.*,
        o.order_number AS converted_order_number,
        u.first_name AS created_by_first_name,
        u.last_name AS created_by_last_name,
        COALESCE(item_summary.product_skus, ARRAY[]::text[]) AS product_skus,
        COALESCE(item_summary.product_count, 0) AS product_count,

        jsonb_build_object(
          'send_count',
            COALESCE(tracking_summary.send_count, 0),

          'last_sent_at',
            tracking_summary.last_sent_at,

          'first_opened_at',
            tracking_summary.first_opened_at,

          'last_opened_at',
            tracking_summary.last_opened_at,

          'open_count',
            COALESCE(tracking_summary.open_count, 0),

          'first_viewed_at',
            tracking_summary.first_viewed_at,

          'last_viewed_at',
            tracking_summary.last_viewed_at,

          'view_count',
            COALESCE(tracking_summary.view_count, 0),

          'distinct_view_environments',
            COALESCE(
              tracking_summary.distinct_view_environments,
              0
            ),

          'has_detected_open',
            COALESCE(tracking_summary.open_count, 0) > 0,

          'has_been_viewed',
            COALESCE(tracking_summary.view_count, 0) > 0
        ) AS tracking

      FROM quotations q
      LEFT JOIN orders o
        ON o.id = q.converted_order_id
      INNER JOIN users u
        ON u.id = q.created_by
      LEFT JOIN LATERAL (
        SELECT
          ARRAY_AGG(
            DISTINCT line_code
            ORDER BY line_code
          )
            FILTER (
              WHERE line_code IS NOT NULL
                AND BTRIM(line_code) <> ''
            )
            AS product_skus,

          COUNT(*)::int
            AS product_count

        FROM (
          SELECT
            qi.sku::text
              AS line_code
          FROM quotation_items qi
          WHERE qi.quotation_id = q.id

          UNION ALL

          SELECT
            qpl.code::text
              AS line_code
          FROM quotation_project_lines qpl
          WHERE qpl.quotation_id = q.id
        ) quotation_lines
      ) item_summary ON TRUE

      LEFT JOIN LATERAL (
        SELECT
          (
            SELECT COUNT(*)::int
            FROM quotation_email_messages qem_count
            WHERE qem_count.quotation_id = q.id
          ) AS send_count,

          (
            SELECT MAX(qem_sent.sent_at)
            FROM quotation_email_messages qem_sent
            WHERE qem_sent.quotation_id = q.id
          ) AS last_sent_at,

          (
            SELECT MIN(qem_open.first_opened_at)
            FROM quotation_email_messages qem_open
            WHERE qem_open.quotation_id = q.id
              AND qem_open.first_opened_at IS NOT NULL
          ) AS first_opened_at,

          (
            SELECT MAX(qem_last_open.last_opened_at)
            FROM quotation_email_messages qem_last_open
            WHERE qem_last_open.quotation_id = q.id
          ) AS last_opened_at,

          (
            SELECT COALESCE(SUM(qem_total.open_count), 0)::int
            FROM quotation_email_messages qem_total
            WHERE qem_total.quotation_id = q.id
          ) AS open_count,

          (
            SELECT MIN(qat_first.first_used_at)
            FROM quotation_access_tokens qat_first
            WHERE qat_first.quotation_id = q.id
              AND qat_first.first_used_at IS NOT NULL
          ) AS first_viewed_at,

          (
            SELECT MAX(qat_last.last_used_at)
            FROM quotation_access_tokens qat_last
            WHERE qat_last.quotation_id = q.id
          ) AS last_viewed_at,

          (
            SELECT COALESCE(SUM(qat_total.view_count), 0)::int
            FROM quotation_access_tokens qat_total
            WHERE qat_total.quotation_id = q.id
          ) AS view_count,

          (
            SELECT COUNT(
              DISTINCT CONCAT(
                COALESCE(qae.ip_hash, ''),
                '|',
                COALESCE(qae.user_agent, '')
              )
            )::int
            FROM quotation_access_events qae
            WHERE qae.quotation_id = q.id
              AND qae.event_type = 'VIEWED'
          ) AS distinct_view_environments

      ) tracking_summary ON TRUE

      WHERE ${conditions.join(" AND ")}
      ORDER BY q.created_at DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `,
    listValues
  );

  const today = new Date().toISOString().slice(0, 10);
  const expirableIds = result.rows
    .filter(
      (q) =>
        CONVERTIBLE_STATUSES.has(q.status) &&
        dateOnly(q.valid_until) < today
    )
    .map((q) => q.id);

  if (expirableIds.length > 0) {
    await pool.query(
      `
        UPDATE quotations
        SET status = 'EXPIRED'
        WHERE id = ANY($1::uuid[])
          AND status IN ('DRAFT', 'SENT', 'ACCEPTED')
      `,
      [expirableIds]
    );
  }

  const normalizedRows = result.rows.map((q) =>
    expirableIds.includes(q.id)
      ? { ...q, status: "EXPIRED" }
      : q
  );

  const total = Number(countResult.rows[0]?.total || 0);
  return {
    pagination: {
      page,
      limit,
      total,
      total_pages: total === 0 ? 0 : Math.ceil(total / limit),
      has_next_page: page * limit < total,
      has_previous_page: page > 1,
    },
    quotations: normalizedRows,
  };
};

export const deleteQuotation = async ({ quotationId }) => {
  const id = requireUuid(quotationId, "quotationId");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const currentResult = await client.query(
      `
        SELECT
          id,
          quote_number,
          status,
          converted_order_id,
          customer_name,
          legal_name,
          total
        FROM quotations
        WHERE id = $1
        FOR UPDATE
      `,
      [id]
    );

    if (currentResult.rowCount === 0) {
      throw createServiceError(
        "La cotización no existe",
        404,
        "QUOTATION_NOT_FOUND"
      );
    }

    const current = currentResult.rows[0];

    if (
      current.converted_order_id ||
      cleanText(current.status).toUpperCase() === "CONVERTED"
    ) {
      throw createServiceError(
        "La cotización ya fue convertida en venta y no puede eliminarse. Debe conservarse para mantener la trazabilidad.",
        409,
        "QUOTATION_CANNOT_DELETE_CONVERTED"
      );
    }

    await client.query(
      `
        DELETE FROM quotation_items
        WHERE quotation_id = $1
      `,
      [id]
    );

    const deletedResult = await client.query(
      `
        DELETE FROM quotations
        WHERE id = $1
          AND converted_order_id IS NULL
        RETURNING
          id,
          quote_number,
          status,
          customer_name,
          legal_name,
          total
      `,
      [id]
    );

    if (deletedResult.rowCount !== 1) {
      throw createServiceError(
        "La cotización cambió de estado y no pudo eliminarse",
        409,
        "QUOTATION_DELETE_CONFLICT"
      );
    }

    await client.query("COMMIT");

    return {
      deleted: true,
      quotation: deletedResult.rows[0],
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // noop
    }
    throw error;
  } finally {
    client.release();
  }
};

export const cancelQuotation = async ({ quotationId }) => {
  const id = requireUuid(quotationId, "quotationId");

  const result = await pool.query(
    `
      UPDATE quotations
      SET status = 'CANCELLED'
      WHERE id = $1
        AND status IN ('DRAFT', 'SENT', 'ACCEPTED')
      RETURNING *
    `,
    [id]
  );

  if (result.rowCount === 0) {
    const existing = await getQuotationById({ quotationId: id });
    throw createServiceError(
      `La cotización no puede cancelarse desde el estado ${existing.quotation.status}`,
      409,
      "QUOTATION_CANNOT_CANCEL"
    );
  }

  return result.rows[0];
};

export const getQuotationPdf = async ({ quotationId }) => {
  const data = await getQuotationById({ quotationId });
  const buffer = await buildQuotationPdfBuffer(data);

  return {
    ...data,
    buffer,
    filename: `${data.quotation.quote_number}.pdf`,
  };
};

export const emailQuotation = async ({ quotationId }) => {
  const {
    quotation,
    items,
    project_lines,
  } =
    await getQuotationById({
      quotationId,
    });

  if (["EXPIRED", "CANCELLED", "CONVERTED"].includes(quotation.status)) {
    throw createServiceError(
      `No es posible enviar una cotización en estado ${quotation.status}`,
      409,
      "QUOTATION_EMAIL_STATUS_INVALID"
    );
  }

  const subject =
    `Cotización ${quotation.quote_number} · Laminati`;

  const tracking = await createQuotationTracking({
    quotationId: quotation.id,
    recipientEmail: quotation.email,
    subject,
  });

  let info;

  try {
    const emailTemplate = buildQuotationEmail({
      quotation,
      to: quotation.email,
      quotationUrl: tracking.quotation_url,
      openPixelUrl: tracking.open_pixel_url,
    });

    info = await sendTransactionalEmail({
      ...emailTemplate,
      messageId: `<quotation-${tracking.email_message_id}@laminatiword.local>`,
      /*
       * No adjuntamos el PDF.
       * El cliente debe entrar por la URL trackeada para registrar VIEW.
       */
      attachments: [],
    });
  } catch (error) {
    try {
      await markQuotationEmailFailed({
        emailMessageId: tracking.email_message_id,
        error,
      });
    } catch (trackingError) {
      console.error(
        "Error registrando fallo de email de cotización:",
        trackingError
      );
    }

    throw error;
  }

  await markQuotationEmailSent({
    emailMessageId: tracking.email_message_id,
    providerMessageId: info.message_id,
    providerResponse: info,
  });

  await pool.query(
    `
      UPDATE quotations
      SET
        status = CASE
          WHEN status = 'DRAFT' THEN 'SENT'
          ELSE status
        END,
        sent_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [quotation.id]
  );

  return {
    sent: true,
    email: quotation.email,
    provider: info,
    tracking: {
      email_message_id: tracking.email_message_id,
      access_token_id: tracking.access_token_id,
      ...(String(process.env.NODE_ENV || "")
        .trim()
        .toLowerCase() !== "production"
        ? {
            quotation_url: tracking.quotation_url,
            open_pixel_url: tracking.open_pixel_url,
          }
        : {}),
    },
    quotation: {
      ...quotation,
      status:
        quotation.status === "DRAFT" ? "SENT" : quotation.status,
    },
    items,
    project_lines:
      project_lines ||
      [],
  };
};

const ensureInvoiceCustomerForQuotation = async (quotation) => {
  if (quotation.intended_document_type !== "FACTURA") {
    return quotation.relbase_customer_id || null;
  }

  const result = await ensurePosInvoiceCustomer({
    body: {
      rut: quotation.rut,
      legal_name: quotation.legal_name || quotation.customer_name,
      trade_name: quotation.trade_name,
      business_activity: quotation.business_activity,
      billing_email: quotation.email,
      phone: quotation.phone,
      address_line: quotation.address_line,
      commune: quotation.commune,
      city: quotation.city,
      region: quotation.region,
      country: quotation.country,
    },
  });

  return result.relbase_customer_id;
};

export const convertQuotationToSale = async ({
  quotationId,
  cashierUserId,
  body,
}) => {
  const id = requireUuid(quotationId, "quotationId");
  const cashierId = requireUuid(cashierUserId, "cashierUserId");

  const initial = await getQuotationById({ quotationId: id });
  const initialQuotation = initial.quotation;

  if (
    cleanText(
      initialQuotation
        .quotation_type
    ).toUpperCase() ===
    "PROJECT"
  ) {
    throw createServiceError(
      "Las cotizaciones de proyecto todavía no se convierten automáticamente en venta POS",
      409,
      "QUOTATION_PROJECT_CONVERSION_NOT_SUPPORTED"
    );
  }

  if (!CONVERTIBLE_STATUSES.has(initialQuotation.status)) {
    if (
      initialQuotation.status === "CONVERTED" &&
      initialQuotation.converted_order_id
    ) {
      return {
        converted: false,
        already_converted: true,
        quotation: initialQuotation,
        order_id: initialQuotation.converted_order_id,
        order_number: initialQuotation.converted_order_number || null,
      };
    }

    throw createServiceError(
      `La cotización no puede convertirse desde el estado ${initialQuotation.status}`,
      409,
      "QUOTATION_NOT_CONVERTIBLE"
    );
  }

  /*
   * Si es Factura, la escritura/validación con Relbase ocurre
   * antes de tomar locks de PostgreSQL.
   */
  const relbaseCustomerId =
    await ensureInvoiceCustomerForQuotation(initialQuotation);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lockedResult = await client.query(
      `
        SELECT *
        FROM quotations
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [id]
    );

    if (lockedResult.rowCount === 0) {
      throw createServiceError(
        "La cotización no existe",
        404,
        "QUOTATION_NOT_FOUND"
      );
    }

    const quotation = lockedResult.rows[0];

    if (quotation.status === "CONVERTED") {
      await client.query("COMMIT");
      return {
        converted: false,
        already_converted: true,
        quotation,
        order_id: quotation.converted_order_id,
      };
    }

    if (!CONVERTIBLE_STATUSES.has(quotation.status)) {
      throw createServiceError(
        `La cotización no puede convertirse desde el estado ${quotation.status}`,
        409,
        "QUOTATION_NOT_CONVERTIBLE"
      );
    }

    const todayResult = await client.query(
      `SELECT (NOW() AT TIME ZONE 'America/Santiago')::date::text AS today`
    );
    const today = todayResult.rows[0].today;

    if (dateOnly(quotation.valid_until) < today) {
      await client.query(
        `UPDATE quotations SET status = 'EXPIRED' WHERE id = $1`,
        [id]
      );
      throw createServiceError(
        "La cotización está vencida y no puede convertirse en venta",
        409,
        "QUOTATION_EXPIRED"
      );
    }

    const items = await getQuotationItems(id, client);
    if (items.length === 0) {
      throw createServiceError(
        "La cotización no posee productos",
        409,
        "QUOTATION_ITEMS_MISSING"
      );
    }

    const pricingSnapshot = new Map(
      items.map((item) => [
        item.product_id,
        {
          product_id: item.product_id,
          sku: item.sku,
          product_name: item.product_name,
          quantity: Number(item.quantity),
          unit_price_gross: Number(item.unit_price_gross),
          tax_rate: Number(item.tax_rate),
        },
      ])
    );

    const saleBody = {
      idempotency_key: quotation.conversion_idempotency_key,
      document_type: quotation.intended_document_type,
      customer: {
        name: quotation.customer_name,
        rut: quotation.rut,
        email: quotation.email,
        phone: quotation.phone,
      },
      billing: {
        customer_type: quotation.customer_type,
        rut: quotation.rut,
        legal_name:
          quotation.legal_name || quotation.customer_name,
        trade_name: quotation.trade_name,
        business_activity: quotation.business_activity,
        billing_email: quotation.email,
        phone: quotation.phone,
        address_line: quotation.address_line,
        commune: quotation.commune,
        city: quotation.city,
        region: quotation.region,
        country: quotation.country,
        relbase_customer_id:
          relbaseCustomerId || quotation.relbase_customer_id,
      },
      items: items.map((item) => ({
        product_id: item.product_id,
        quantity: Number(item.quantity),
      })),
      payment: {
        method: cleanText(body?.payment?.method).toUpperCase(),
        amount_received: body?.payment?.amount_received,
        external_reference: body?.payment?.external_reference,
      },
      notes:
        optionalText(body?.notes) ||
        `Venta desde cotización ${quotation.quote_number}`,
    };

    const sale = await createPosSale({
      cashierUserId: cashierId,
      body: saleBody,
      trustedPricingSnapshot: pricingSnapshot,
    });

    if (!sale?.order?.id) {
      throw createServiceError(
        "La venta fue procesada, pero no devolvió order_id",
        500,
        "QUOTATION_CONVERSION_ORDER_MISSING"
      );
    }

    const quoteTotal = roundMoney(quotation.total);
    const orderTotal = roundMoney(sale.order.total);

    if (quoteTotal !== orderTotal) {
      throw createServiceError(
        `El total de la venta (${orderTotal}) no coincide con el total cotizado (${quoteTotal})`,
        409,
        "QUOTATION_CONVERSION_TOTAL_MISMATCH"
      );
    }

    const convertedResult = await client.query(
      `
        UPDATE quotations
        SET
          status = 'CONVERTED',
          converted_order_id = $2,
          converted_at = NOW(),
          relbase_customer_id = COALESCE($3, relbase_customer_id)
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        sale.order.id,
        relbaseCustomerId || null,
      ]
    );

    await client.query("COMMIT");

    return {
      converted: true,
      already_converted: false,
      quotation: convertedResult.rows[0],
      sale,
      dte_emission_executed: false,
      next_action: "PREPARE_TAX_DOCUMENT_WHEN_ENABLED",
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // noop
    }
    throw error;
  } finally {
    client.release();
  }
};
