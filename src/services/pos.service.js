import crypto from "crypto";

import pool from "../config/database.js";

import {
  getProductImageSignedUrl,
} from "./productImageStorage.service.js";

import {
  ensureRelbaseCustomer,
  findRelbaseCustomerByRutService,
} from "./relbaseCustomer.service.js";

import {
  resolveCustomerProductPrice,
} from "./customerPricing.service.js";

import {
  captureOrderItemItalyPriceSnapshot,
} from "./italyPriceSnapshot.service.js";

const POS_PROVIDER_CODE = "LOCAL_POS";
const POS_WAREHOUSE_ID = 956;

/*
 * Despacho FEX:
 * producto real, precio por operación y sin reserva de stock.
 */
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

/*
 * Servicio manual Showroom:
 * - no existe como producto local del catálogo;
 * - no consume ni reserva inventario;
 * - usa un producto/servicio técnico de Relbase sólo al preparar el DTE.
 */
const POS_MANUAL_SERVICE_SKU = String(
  process.env.POS_MANUAL_SERVICE_SKU ||
    "SERVICIO-MANUAL"
)
  .trim()
  .toUpperCase();

const RELBASE_MANUAL_SERVICE_CODE = String(
  process.env.RELBASE_MANUAL_SERVICE_CODE ||
    POS_MANUAL_SERVICE_SKU
).trim();

const POS_MANUAL_SERVICE_TAX_RATE = Number(
  process.env.POS_MANUAL_SERVICE_TAX_RATE ||
    19
);

const getManualServiceRelbaseProductId = () => {
  const value = Number(
    process.env.RELBASE_MANUAL_SERVICE_PRODUCT_ID
  );

  if (
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw createServiceError(
      "Falta configurar RELBASE_MANUAL_SERVICE_PRODUCT_ID con un ID Relbase válido",
      500,
      "POS_MANUAL_SERVICE_RELBASE_ID_MISSING"
    );
  }

  return String(value);
};

const buildManualServiceName = ({
  serviceName,
  serviceDetail,
  referenceCode,
}) => {
  const parts = [
    toOptionalString(serviceName),
    toOptionalString(serviceDetail),
    referenceCode
      ? `Correspondiente a ${referenceCode}`
      : null,
  ].filter(Boolean);

  return parts.join(" - ");
};

const POS_PAYMENT_METHODS = new Set([
  "CASH",
  "DEBIT_CARD",
  "CREDIT_CARD",
  "MANUAL_BANK_TRANSFER",
]);

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

const roundMoney = (value) => {
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

const toOptionalString = (value) => {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
};

const normalizePaymentMethod = (value) => {
  return String(value || "")
    .trim()
    .toUpperCase();
};


const normalizeOperationDiscount = (
  value
) => {
  if (
    value === undefined ||
    value === null
  ) {
    return {
      type: "PERCENT",
      value: 0,
    };
  }

  const type =
    String(
      value?.type ||
        "PERCENT"
    )
      .trim()
      .toUpperCase();

  if (
    ![
      "PERCENT",
      "AMOUNT",
    ].includes(type)
  ) {
    throw createServiceError(
      "El tipo de descuento global debe ser PERCENT o AMOUNT",
      400,
      "POS_OPERATION_DISCOUNT_TYPE_INVALID"
    );
  }

  const rawValue =
    value?.value === undefined ||
    value?.value === null ||
    String(value.value).trim() === ""
      ? 0
      : Number(value.value);

  const discountValue =
    roundMoney(rawValue);

  if (
    discountValue === null ||
    discountValue < 0
  ) {
    throw createServiceError(
      "El descuento global informado no es válido",
      400,
      "POS_OPERATION_DISCOUNT_INVALID"
    );
  }

  if (
    type === "PERCENT" &&
    discountValue >= 100
  ) {
    throw createServiceError(
      "El descuento global porcentual debe ser menor a 100%",
      400,
      "POS_OPERATION_DISCOUNT_PERCENT_INVALID"
    );
  }

  return {
    type,
    value: discountValue,
  };
};

const allocateMoneyProportionally = ({
  amount,
  weights,
}) => {
  const safeWeights =
    weights.map(
      (value) =>
        Math.max(
          Math.round(
            Number(value || 0) *
              100
          ),
          0
        )
    );

  const totalWeight =
    safeWeights.reduce(
      (sum, value) =>
        sum + value,
      0
    );

  const target =
    Math.max(
      Math.round(
        Number(amount || 0) *
          100
      ),
      0
    );

  if (
    target <= 0 ||
    totalWeight <= 0
  ) {
    return safeWeights.map(
      () => 0
    );
  }

  const allocations =
    safeWeights.map(
      (
        weight,
        index
      ) => {
        const exact =
          target *
          weight /
          totalWeight;

        const cents =
          Math.floor(exact);

        return {
          index,
          cents,
          remainder:
            exact - cents,
          capacity:
            Math.max(
              weight - cents,
              0
            ),
        };
      }
    );

  let remaining =
    target -
    allocations.reduce(
      (sum, item) =>
        sum + item.cents,
      0
    );

  const ranked = [
    ...allocations,
  ].sort(
    (a, b) =>
      b.remainder -
        a.remainder ||
      b.capacity -
        a.capacity ||
      a.index -
        b.index
  );

  let cursor = 0;

  while (
    remaining > 0 &&
    ranked.length > 0
  ) {
    const current =
      ranked[
        cursor %
          ranked.length
      ];

    if (
      current.cents <
      safeWeights[
        current.index
      ]
    ) {
      current.cents += 1;
      remaining -= 1;
    }

    cursor += 1;

    if (
      cursor >
      ranked.length *
        4 &&
      !ranked.some(
        (item) =>
          item.cents <
          safeWeights[
            item.index
          ]
      )
    ) {
      break;
    }
  }

  const byIndex =
    new Array(
      safeWeights.length
    ).fill(0);

  for (
    const item of ranked
  ) {
    byIndex[
      item.index
    ] =
      item.cents / 100;
  }

  return byIndex;
};

const applyOperationDiscount = ({
  items,
  discount,
}) => {
  const currentTotal =
    roundMoney(
      items.reduce(
        (
          sum,
          item
        ) =>
          sum +
          Number(
            item.line_total ||
              0
          ),
        0
      )
    );

  if (
    currentTotal === null ||
    currentTotal <= 0
  ) {
    throw createServiceError(
      "No fue posible calcular el total previo al descuento global",
      409,
      "POS_OPERATION_DISCOUNT_BASE_INVALID"
    );
  }

  if (
    !discount ||
    Number(
      discount.value ||
        0
    ) <= 0
  ) {
    return {
      amount: 0,
      type:
        discount?.type ||
        "PERCENT",
      value:
        Number(
          discount?.value ||
            0
        ),
    };
  }

  const requestedAmount =
    discount.type ===
      "AMOUNT"
      ? roundMoney(
          discount.value
        )
      : roundMoney(
          currentTotal *
            Number(
              discount.value
            ) /
            100
        );

  if (
    requestedAmount ===
      null ||
    requestedAmount <= 0
  ) {
    throw createServiceError(
      "El descuento global calculado no es válido",
      400,
      "POS_OPERATION_DISCOUNT_AMOUNT_INVALID"
    );
  }

  if (
    requestedAmount >=
    currentTotal
  ) {
    throw createServiceError(
      "El descuento global debe ser menor al total de la operación",
      400,
      "POS_OPERATION_DISCOUNT_EXCEEDS_TOTAL"
    );
  }

  const allocations =
    allocateMoneyProportionally({
      amount:
        requestedAmount,
      weights:
        items.map(
          (item) =>
            item.line_total
        ),
    });

  items.forEach(
    (
      item,
      index
    ) => {
      const additionalDiscount =
        roundMoney(
          allocations[
            index
          ] || 0
        ) || 0;

      if (
        additionalDiscount <=
        0
      ) {
        return;
      }

      const nextDiscount =
        roundMoney(
          Number(
            item.discount_amount ||
              0
          ) +
            additionalDiscount
        );

      const nextLineTotal =
        roundMoney(
          Number(
            item.line_total ||
              0
          ) -
            additionalDiscount
        );

      if (
        nextDiscount === null ||
        nextLineTotal === null ||
        nextLineTotal <= 0 ||
        nextDiscount >=
          Number(
            item.line_subtotal ||
              0
          )
      ) {
        throw createServiceError(
          `El descuento global deja una línea inválida para ${item.sku || "un ítem"}`,
          400,
          "POS_OPERATION_DISCOUNT_LINE_INVALID"
        );
      }

      const tax =
        calculateGrossTax({
          grossTotal:
            nextLineTotal,
          taxRate:
            item.tax_rate,
        });

      item.discount_amount =
        nextDiscount;
      item.line_total =
        nextLineTotal;
      item.tax_amount =
        tax.tax_amount;
    }
  );

  const appliedAmount =
    roundMoney(
      allocations.reduce(
        (
          sum,
          value
        ) =>
          sum +
          Number(
            value || 0
          ),
        0
      )
    );

  if (
    Math.round(
      appliedAmount * 100
    ) !==
    Math.round(
      requestedAmount * 100
    )
  ) {
    throw createServiceError(
      "No fue posible distribuir exactamente el descuento global entre las líneas",
      409,
      "POS_OPERATION_DISCOUNT_ALLOCATION_MISMATCH"
    );
  }

  return {
    amount:
      appliedAmount,
    type:
      discount.type,
    value:
      discount.value,
  };
};


/* =========================================
   IMAGEN PRINCIPAL PRODUCTO POS
   - Railway Storage privado -> URL firmada.
   - URL externa antigua -> compatibilidad.
   - No expone storage keys al frontend.
   - Una falla de imagen NO bloquea el catálogo POS.
========================================= */
const resolvePosProductImage = async (product) => {
  const {
    primary_image_id,
    primary_image_image_url,
    primary_image_alt_text,
    primary_image_storage_provider,
    primary_image_thumbnail_key,
    primary_image_card_key,
    ...safeProduct
  } = product;

  if (!primary_image_id) {
    return {
      ...safeProduct,
      primary_image_url: null,
      primary_image_alt: safeProduct.name || null,
      has_image: false,
    };
  }

  const storageProvider = String(
    primary_image_storage_provider || ""
  )
    .trim()
    .toUpperCase();

  const legacyUrl =
    toOptionalString(primary_image_image_url);

  let resolvedUrl = null;

  if (storageProvider !== "RAILWAY") {
    resolvedUrl = legacyUrl;
  } else {
    try {
      const storageKey =
        toOptionalString(primary_image_card_key) ||
        toOptionalString(primary_image_thumbnail_key);

      resolvedUrl = storageKey
        ? await getProductImageSignedUrl(storageKey)
        : null;
    } catch (error) {
      console.error(
        "Error generando URL firmada para imagen POS:",
        {
          product_id: safeProduct.id,
          image_id: primary_image_id,
          message: error?.message || null,
        }
      );
      resolvedUrl = null;
    }
  }

  return {
    ...safeProduct,
    primary_image_url: resolvedUrl,
    primary_image_alt:
      toOptionalString(primary_image_alt_text) ||
      safeProduct.name ||
      null,
    has_image: Boolean(resolvedUrl),
  };
};

const assertUuid = (value, fieldName) => {
  const normalized = String(value || "").trim();

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized
    )
  ) {
    throw createServiceError(
      `${fieldName} no posee un UUID válido`,
      400,
      "INVALID_UUID"
    );
  }

  return normalized;
};

const calculateGrossTax = ({
  grossTotal,
  taxRate,
}) => {
  const gross = roundMoney(grossTotal);
  const rate = Number(taxRate);

  if (
    gross === null ||
    gross < 0 ||
    !Number.isFinite(rate) ||
    rate < 0
  ) {
    throw createServiceError(
      "No fue posible calcular los impuestos de la venta",
      409,
      "POS_TAX_CALCULATION_INVALID"
    );
  }

  if (rate === 0) {
    return {
      net_amount: 0,
      exempt_amount: gross,
      tax_amount: 0,
      total_amount: gross,
    };
  }

  const factor = 1 + rate / 100;
  const net = roundMoney(gross / factor);
  const tax = roundMoney(gross - net);

  return {
    net_amount: net,
    exempt_amount: 0,
    tax_amount: tax,
    total_amount: gross,
  };
};

const normalizeItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw createServiceError(
      "La venta POS debe contener al menos un producto o servicio",
      400,
      "POS_ITEMS_REQUIRED"
    );
  }

  const aggregatedProducts = new Map();
  const manualServices = [];

  for (const item of items) {
    const itemType = String(
      item?.item_type || "PRODUCT"
    )
      .trim()
      .toUpperCase();

    const quantity = Number(item?.quantity);

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0
    ) {
      throw createServiceError(
        "La cantidad de cada producto o servicio debe ser mayor a cero",
        400,
        "POS_ITEM_QUANTITY_INVALID"
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
        "El precio de venta informado no es válido",
        400,
        "POS_ITEM_PRICE_OVERRIDE_INVALID"
      );
    }

    const rawDiscountType =
      String(
        item?.discount_type ||
        "PERCENT"
      )
        .trim()
        .toUpperCase();

    const discountType =
      [
        "PERCENT",
        "AMOUNT",
      ].includes(rawDiscountType)
        ? rawDiscountType
        : null;

    if (!discountType) {
      throw createServiceError(
        "El tipo de descuento debe ser PERCENT o AMOUNT",
        400,
        "POS_ITEM_DISCOUNT_TYPE_INVALID"
      );
    }

    const rawDiscountValue =
      item?.discount_value === undefined ||
      item?.discount_value === null ||
      String(item?.discount_value).trim() === ""
        ? 0
        : Number(item.discount_value);

    const discountValue = roundMoney(
      rawDiscountValue
    );

    if (
      discountValue === null ||
      discountValue < 0
    ) {
      throw createServiceError(
        "El descuento informado no es válido",
        400,
        "POS_ITEM_DISCOUNT_INVALID"
      );
    }

    if (
      discountType === "PERCENT" &&
      discountValue >= 100
    ) {
      throw createServiceError(
        "El descuento porcentual debe ser menor a 100%",
        400,
        "POS_ITEM_DISCOUNT_PERCENT_INVALID"
      );
    }

    if (itemType === "SERVICE") {
      const serviceName =
        toOptionalString(item?.service_name);
      const serviceDetail =
        toOptionalString(item?.service_detail);
      const referenceCode =
        toOptionalString(item?.reference_code);

      if (!serviceName) {
        throw createServiceError(
          "El nombre del servicio es obligatorio",
          400,
          "POS_MANUAL_SERVICE_NAME_REQUIRED"
        );
      }

      if (
        priceOverride === null ||
        priceOverride <= 0
      ) {
        throw createServiceError(
          "El servicio manual requiere un valor unitario mayor a cero",
          400,
          "POS_MANUAL_SERVICE_PRICE_REQUIRED"
        );
      }

      manualServices.push({
        item_type: "SERVICE",
        product_id: null,
        quantity,
        unit_price_override: priceOverride,
        discount_type: discountType,
        discount_value: discountValue,
        service_name: serviceName,
        service_detail: serviceDetail,
        reference_code: referenceCode,
        service_description:
          buildManualServiceName({
            serviceName,
            serviceDetail,
            referenceCode,
          }),
      });

      continue;
    }

    if (itemType !== "PRODUCT") {
      throw createServiceError(
        "item_type debe ser PRODUCT o SERVICE",
        400,
        "POS_ITEM_TYPE_INVALID"
      );
    }

    const productId = assertUuid(
      item?.product_id,
      "product_id"
    );

    const current =
      aggregatedProducts.get(productId);

    if (current) {
      if (
        current.unit_price_override !== null &&
        priceOverride !== null &&
        Number(current.unit_price_override) !==
          Number(priceOverride)
      ) {
        throw createServiceError(
          "Un mismo producto no puede tener dos precios de venta distintos en la misma operación",
          400,
          "POS_ITEM_PRICE_OVERRIDE_CONFLICT"
        );
      }

      if (
        current.discount_type !==
          discountType ||
        Number(current.discount_value) !==
          Number(discountValue)
      ) {
        throw createServiceError(
          "Un mismo producto no puede tener descuentos distintos en la misma operación",
          400,
          "POS_ITEM_DISCOUNT_CONFLICT"
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

    aggregatedProducts.set(productId, {
      item_type: "PRODUCT",
      product_id: productId,
      quantity,
      unit_price_override:
        priceOverride,
      discount_type:
        discountType,
      discount_value:
        discountValue,
    });
  }

  const products = [
    ...aggregatedProducts.values(),
  ].sort((a, b) =>
    a.product_id.localeCompare(
      b.product_id
    )
  );

  return [
    ...products,
    ...manualServices,
  ];
};


const normalizeBilling = ({
  documentType,
  customer,
  billing,
}) => {
  const type = String(documentType || "BOLETA")
    .trim()
    .toUpperCase();

  if (
    type !== "BOLETA" &&
    type !== "FACTURA"
  ) {
    throw createServiceError(
      "document_type debe ser BOLETA o FACTURA",
      400,
      "POS_DOCUMENT_TYPE_INVALID"
    );
  }

  if (type === "BOLETA") {
    return {
      document_type: "BOLETA",
      customer_type:
        String(
          billing?.customer_type || "PERSON"
        )
          .trim()
          .toUpperCase() === "COMPANY"
          ? "COMPANY"
          : "PERSON",
      rut:
        toOptionalString(billing?.rut) ||
        toOptionalString(customer?.rut),
      legal_name:
        toOptionalString(billing?.legal_name) ||
        toOptionalString(customer?.name) ||
        "Cliente presencial",
      trade_name:
        toOptionalString(billing?.trade_name),
      business_activity:
        toOptionalString(
          billing?.business_activity
        ),
      billing_email:
        toOptionalString(
          billing?.billing_email
        ) ||
        toOptionalString(customer?.email),
      phone:
        toOptionalString(billing?.phone) ||
        toOptionalString(customer?.phone),
      address_line:
        toOptionalString(billing?.address_line),
      commune:
        toOptionalString(billing?.commune),
      city:
        toOptionalString(billing?.city),
      region:
        toOptionalString(billing?.region),
      country:
        toOptionalString(billing?.country) ||
        "Chile",
      relbase_customer_id:
        toOptionalString(
          billing?.relbase_customer_id
        ),
    };
  }

  const required = [
    ["rut", "RUT"],
    ["legal_name", "razón social"],
    ["business_activity", "giro"],
    ["address_line", "dirección"],
    ["commune", "comuna"],
    ["city", "ciudad"],
    ["relbase_customer_id", "cliente Relbase"],
  ];

  for (const [field, label] of required) {
    if (!toOptionalString(billing?.[field])) {
      throw createServiceError(
        `Falta ${label} para una venta POS con FACTURA`,
        400,
        "POS_INVOICE_BILLING_INCOMPLETE"
      );
    }
  }

  return {
    document_type: "FACTURA",
    customer_type: "COMPANY",
    rut: toOptionalString(billing.rut),
    legal_name:
      toOptionalString(billing.legal_name),
    trade_name:
      toOptionalString(billing.trade_name),
    business_activity:
      toOptionalString(
        billing.business_activity
      ),
    billing_email:
      toOptionalString(billing.billing_email) ||
      toOptionalString(customer?.email),
    phone:
      toOptionalString(billing.phone) ||
      toOptionalString(customer?.phone),
    address_line:
      toOptionalString(billing.address_line),
    commune:
      toOptionalString(billing.commune),
    city:
      toOptionalString(billing.city),
    region:
      toOptionalString(billing.region),
    country:
      toOptionalString(billing.country) ||
      "Chile",
    relbase_customer_id:
      toOptionalString(
        billing.relbase_customer_id
      ),
  };
};

const getPosConfiguration = async (
  client,
  paymentMethodCode
) => {
  const providerResult = await client.query(
    `
      SELECT
        id,
        code,
        name,
        environment,
        is_active,
        supports_idempotency
      FROM payment_providers
      WHERE code = $1
        AND is_active = TRUE
      LIMIT 1
    `,
    [POS_PROVIDER_CODE]
  );

  if (providerResult.rowCount === 0) {
    throw createServiceError(
      "El proveedor LOCAL_POS no está activo",
      409,
      "POS_PROVIDER_NOT_AVAILABLE"
    );
  }

  const methodResult = await client.query(
    `
      SELECT
        id,
        code,
        name,
        is_active,
        requires_manual_confirmation
      FROM payment_methods
      WHERE code = $1
        AND is_active = TRUE
      LIMIT 1
    `,
    [paymentMethodCode]
  );

  if (methodResult.rowCount === 0) {
    throw createServiceError(
      "El método de pago POS no está activo",
      409,
      "POS_PAYMENT_METHOD_NOT_AVAILABLE"
    );
  }

  return {
    provider: providerResult.rows[0],
    method: methodResult.rows[0],
  };
};

const getExistingSaleByIdempotencyKey = async (
  client,
  idempotencyKey
) => {
  const paymentResult = await client.query(
    `
      SELECT
        p.id AS payment_id,
        p.order_id,
        p.amount,
        p.currency,
        p.status AS payment_status,
        p.amount_received,
        p.change_due,
        p.external_reference,
        p.confirmed_at,
        p.confirmed_by,
        pm.code AS payment_method,
        pp.code AS provider_code,
        o.order_number,
        o.status AS order_status,
        o.payment_status AS order_payment_status,
        o.fulfillment_status,
        o.subtotal,
        o.discount_total,
        o.shipping_total,
        o.tax_total,
        o.total,
        o.source,
        o.created_at
      FROM payments p
      INNER JOIN orders o
        ON o.id = p.order_id
      INNER JOIN payment_methods pm
        ON pm.id = p.payment_method_id
      INNER JOIN payment_providers pp
        ON pp.id = p.provider_id
      WHERE p.idempotency_key = $1
      LIMIT 1
    `,
    [idempotencyKey]
  );

  if (paymentResult.rowCount === 0) {
    return null;
  }

  const sale = paymentResult.rows[0];

  if (
    sale.provider_code !== POS_PROVIDER_CODE ||
    sale.source !== "STORE"
  ) {
    throw createServiceError(
      "La clave de idempotencia ya fue utilizada por otra operación",
      409,
      "IDEMPOTENCY_KEY_CONFLICT"
    );
  }

  const itemsResult = await client.query(
    `
      SELECT
        id,
        product_id,
        sku,
        product_name,
        quantity,
        unit_price,
        discount_amount,
        tax_rate,
        line_subtotal,
        line_total
      FROM order_items
      WHERE order_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [sale.order_id]
  );

  const reservationsResult = await client.query(
    `
      SELECT
        ir.id,
        ir.inventory_id,
        ir.quantity,
        ir.status,
        ir.confirmed_at,
        i.relbase_warehouse_id,
        i.stock_quantity,
        i.reserved_quantity,
        (i.stock_quantity - i.reserved_quantity)
          AS available_pos
      FROM inventory_reservations ir
      INNER JOIN inventory i
        ON i.id = ir.inventory_id
      WHERE ir.order_id = $1
      ORDER BY ir.created_at ASC, ir.id ASC
    `,
    [sale.order_id]
  );

  return {
    order: {
      id: sale.order_id,
      order_number: sale.order_number,
      status: sale.order_status,
      payment_status:
        sale.order_payment_status,
      fulfillment_status:
        sale.fulfillment_status,
      subtotal: sale.subtotal,
      discount_total: sale.discount_total,
      shipping_total: sale.shipping_total,
      tax_total: sale.tax_total,
      total: sale.total,
      currency: sale.currency,
      source: sale.source,
      created_at: sale.created_at,
    },
    payment: {
      id: sale.payment_id,
      method: sale.payment_method,
      provider: sale.provider_code,
      status: sale.payment_status,
      amount: sale.amount,
      currency: sale.currency,
      amount_received:
        sale.amount_received,
      change_due: sale.change_due,
      external_reference:
        sale.external_reference,
      confirmed_at: sale.confirmed_at,
      confirmed_by: sale.confirmed_by,
    },
    items: itemsResult.rows,
    reservations: reservationsResult.rows,
  };
};

const resolveCustomerIdentity = ({
  customer,
  billing,
}) => {
  const name =
    toOptionalString(customer?.name) ||
    toOptionalString(billing?.legal_name) ||
    "Cliente presencial";

  const email =
    toOptionalString(customer?.email) ||
    toOptionalString(billing?.billing_email) ||
    "pos@laminatiword.local";

  return {
    name,
    email,
    rut:
      toOptionalString(customer?.rut) ||
      toOptionalString(billing?.rut),
    phone:
      toOptionalString(customer?.phone) ||
      toOptionalString(billing?.phone),
  };
};


/* =========================================
   CATÁLOGO POS / SHOWROOM
   - Usa exactamente la bodega POS configurada
     por este servicio (Relbase warehouse 956).
   - No modifica stock.
   - No llama a Relbase.
   - No emite DTE.
========================================= */
export const listPosProducts = async ({
  query = {},
} = {}) => {
  const search =
    toOptionalString(query?.q) || null;

  const parsedLimit = Number.parseInt(
    String(query?.limit ?? "50"),
    10
  );

  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 100)
    : 50;

  const values = [
    POS_WAREHOUSE_ID,
    FEX_SHIPPING_SKU,
  ];

  const fexParam = "$2";

  const conditions = [
    "p.is_active = TRUE",
    "p.allow_sale = TRUE",
    "p.relbase_product_id IS NOT NULL",
    `(
      UPPER(p.sku) = UPPER(${fexParam})
      OR (
        p.base_price IS NOT NULL
        AND p.base_price > 0
      )
    )`,
  ];

  if (!search) {
    conditions.push(`
      (
        UPPER(p.sku) = UPPER(${fexParam})
        OR
        COALESCE(
          i.stock_quantity -
          i.reserved_quantity,
          0
        ) > 0
      )
    `);
  }

  let searchOrderSql = "";

  if (search) {
    const pattern = `%${search}%`;
    values.push(pattern);
    const patternParam = `$${values.length}`;

    values.push(search);
    const exactParam = `$${values.length}`;

    conditions.push(`
      (
        p.sku ILIKE ${patternParam}
        OR p.name ILIKE ${patternParam}
        OR COALESCE(p.internal_code, '') ILIKE ${patternParam}
        OR COALESCE(p.relbase_product_id::text, '') ILIKE ${patternParam}
      )
    `);

    searchOrderSql = `
      CASE
        WHEN UPPER(p.sku) = UPPER(${exactParam}) THEN 0
        WHEN UPPER(COALESCE(p.internal_code, '')) = UPPER(${exactParam}) THEN 1
        WHEN p.sku ILIKE (${exactParam} || '%') THEN 2
        WHEN p.name ILIKE (${exactParam} || '%') THEN 3
        ELSE 4
      END,
    `;
  }

  values.push(limit);
  const limitParam = `$${values.length}`;

  const result = await pool.query(
    `
      SELECT
        p.id,
        p.sku,
        p.internal_code,
        p.relbase_product_id,
        p.name,
        p.base_price,
        p.collection_id,
        p.tax_rate,
        p.finish,
        p.color,

        v.promotion_id,
        v.promotion_name,
        v.promotion_type,
        v.promotional_price,
        v.final_price,
        v.has_promotion,
        v.has_quantity_promotion,
        v.quantity_tiers,

        (
          UPPER(p.sku) =
          UPPER(${fexParam})
        ) AS is_fex_shipping,

        (
          UPPER(p.sku) =
          UPPER(${fexParam})
        ) AS allows_price_override,

        (
          UPPER(p.sku) <>
          UPPER(${fexParam})
        ) AS requires_inventory,

        img.id AS primary_image_id,
        img.image_url AS primary_image_image_url,
        img.alt_text AS primary_image_alt_text,
        img.storage_provider AS primary_image_storage_provider,
        img.thumbnail_key AS primary_image_thumbnail_key,
        img.card_key AS primary_image_card_key,

        i.id AS inventory_id,
        i.relbase_warehouse_id,
        i.warehouse_code,
        i.warehouse_name,
        COALESCE(i.stock_quantity, 0) AS stock_quantity,
        COALESCE(i.reserved_quantity, 0) AS reserved_quantity,

        CASE
          WHEN UPPER(p.sku) =
            UPPER(${fexParam})
            THEN 1
          ELSE GREATEST(
            COALESCE(i.stock_quantity, 0) -
            COALESCE(i.reserved_quantity, 0),
            0
          )
        END AS available_pos,

        CASE
          WHEN UPPER(p.sku) =
            UPPER(${fexParam})
            THEN 'SERVICE'
          WHEN i.id IS NULL
            THEN 'NO_POS_INVENTORY'
          WHEN (
            COALESCE(i.stock_quantity, 0) -
            COALESCE(i.reserved_quantity, 0)
          ) <= 0
            THEN 'OUT_OF_STOCK'
          ELSE 'AVAILABLE'
        END AS pos_stock_status,

        i.last_sync_at

      FROM products p

      LEFT JOIN vw_product_catalog v
        ON v.id = p.id

      LEFT JOIN inventory i
        ON i.product_id = p.id
       AND i.relbase_warehouse_id = $1

      LEFT JOIN LATERAL (
        SELECT
          pi.id,
          pi.image_url,
          pi.alt_text,
          pi.storage_provider,
          pi.thumbnail_key,
          pi.card_key
        FROM product_images pi
        WHERE pi.product_id = p.id
        ORDER BY
          pi.is_primary DESC,
          pi.sort_order ASC,
          pi.created_at ASC
        LIMIT 1
      ) img
        ON TRUE

      WHERE ${conditions.join(" AND ")}

      ORDER BY
        CASE
          WHEN UPPER(p.sku) =
            UPPER(${fexParam})
            THEN 0
          ELSE 1
        END,
        ${searchOrderSql}
        p.name ASC,
        p.sku ASC

      LIMIT ${limitParam}
    `,
    values
  );

  const products =
    await Promise.all(
      result.rows.map(
        (product) =>
          resolvePosProductImage(product)
      )
    );

  return {
    warehouse: {
      relbase_warehouse_id:
        String(POS_WAREHOUSE_ID),
    },
    fex_shipping: {
      sku: FEX_SHIPPING_SKU,
      price_override: true,
      inventory_required: false,
    },
    query: search,
    limit,
    count: products.length,
    products,
  };
};

/* =========================================
   CATÁLOGO PARA COTIZACIÓN PROJECT
   - Catálogo comercial de referencia, NO catálogo POS.
   - Permite productos activos aunque:
     * no tengan stock;
     * no tengan fila en inventory;
     * base_price sea NULL;
     * relbase_product_id sea NULL.
   - No modifica stock.
   - No llama a Relbase.
   - No emite DTE.
========================================= */
export const listProjectQuotationProducts = async ({
  query = {},
} = {}) => {
  const search =
    toOptionalString(query?.q) || null;

  const parsedLimit = Number.parseInt(
    String(query?.limit ?? "20"),
    10
  );

  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 100)
    : 20;

  const values = [];
  const conditions = [
    "p.is_active = TRUE",
  ];

  let searchOrderSql = "";

  if (search) {
    const pattern = `%${search}%`;
    values.push(pattern);
    const patternParam = `$${values.length}`;

    values.push(search);
    const exactParam = `$${values.length}`;

    conditions.push(`
      (
        p.sku ILIKE ${patternParam}
        OR p.name ILIKE ${patternParam}
        OR COALESCE(p.internal_code, '') ILIKE ${patternParam}
      )
    `);

    searchOrderSql = `
      CASE
        WHEN UPPER(p.sku) = UPPER(${exactParam}) THEN 0
        WHEN UPPER(COALESCE(p.internal_code, '')) = UPPER(${exactParam}) THEN 1
        WHEN p.sku ILIKE (${exactParam} || '%') THEN 2
        WHEN p.name ILIKE (${exactParam} || '%') THEN 3
        ELSE 4
      END,
    `;
  }

  values.push(limit);
  const limitParam = `$${values.length}`;

  const result = await pool.query(
    `
      SELECT
        p.id,
        p.sku,
        p.internal_code,
        p.relbase_product_id,
        p.name,
        p.base_price,
        p.tax_rate,
        p.finish,
        p.color,
        p.width_mm,
        p.height_mm,
        p.thickness_mm,
        p.brand_id,
        p.category_id,
        p.collection_id,
        p.is_active,
        p.allow_sale
      FROM products p
      WHERE ${conditions.join(" AND ")}
      ORDER BY
        ${searchOrderSql}
        p.name ASC,
        p.sku ASC
      LIMIT ${limitParam}
    `,
    values
  );

  return {
    query: search,
    limit,
    count: result.rows.length,
    products: result.rows,
  };
};

/* =========================================
   ASEGURAR CLIENTE RELBASE PARA FACTURA POS
   - Sólo resuelve/crea el receptor tributario.
   - NO abre transacción de venta POS.
   - NO modifica inventario.
   - NO prepara ni emite DTE.
   - El tipo de cliente se resuelve en backend desde
     RELBASE_COMPANY_CUSTOMER_TYPE_ID.
========================================= */
export const ensurePosInvoiceCustomer = async ({
  body,
} = {}) => {
  const payload = body || {};

  const rut = toOptionalString(payload.rut);
  const legalName = toOptionalString(
    payload.legal_name
  );
  const tradeName =
    toOptionalString(payload.trade_name) ||
    legalName;
  const businessActivity = toOptionalString(
    payload.business_activity
  );
  const billingEmail = toOptionalString(
    payload.billing_email
  );
  const phone = toOptionalString(payload.phone);
  const addressLine = toOptionalString(
    payload.address_line
  );
  const commune = toOptionalString(
    payload.commune
  );
  const city = toOptionalString(payload.city);

  const required = [
    [rut, "RUT"],
    [legalName, "razón social"],
    [businessActivity, "giro"],
    [addressLine, "dirección"],
    [commune, "comuna"],
    [city, "ciudad"],
  ];

  for (const [value, label] of required) {
    if (!value) {
      throw createServiceError(
        `Falta ${label} para asegurar el cliente de Factura en Relbase`,
        400,
        "POS_INVOICE_CUSTOMER_INCOMPLETE"
      );
    }
  }

  const configuredType = Number(
    process.env.RELBASE_COMPANY_CUSTOMER_TYPE_ID
  );

  if (!Number.isInteger(configuredType)) {
    throw createServiceError(
      "RELBASE_COMPANY_CUSTOMER_TYPE_ID no está configurado correctamente",
      500,
      "POS_RELBASE_COMPANY_TYPE_NOT_CONFIGURED"
    );
  }

  const result = await ensureRelbaseCustomer({
    rut,
    company_id: null,
    create_if_missing: true,
    customer_data: {
      type_customer: configuredType,
      name: legalName,
      name_fantasy: tradeName,
      address: addressLine,
      business_activity: businessActivity,
      city,
      commune,
      email: billingEmail || "",
      email_commercial: billingEmail || "",
      phone: phone || "",
      mobile: phone || "",
      reference: "Laminatiword Showroom",
    },
  });

  /*
   * Verificación semántica obligatoria después de
   * asegurar el cliente. Esto también cubre el caso
   * en que el cliente ya existía con el mismo RUT.
   */
  const verification =
    await findRelbaseCustomerByRutService(rut);

  if (
    !verification?.found ||
    !verification?.customer
  ) {
    throw createServiceError(
      "El cliente fue procesado en Relbase, pero no fue posible verificarlo nuevamente por RUT",
      502,
      "POS_RELBASE_CUSTOMER_VERIFICATION_FAILED"
    );
  }

  const verifiedCustomer =
    verification.customer;

  const actualType = String(
    verifiedCustomer?.type_customer || ""
  )
    .trim()
    .toLowerCase();

  if (actualType !== "company") {
    throw createServiceError(
      "El RUT existe en Relbase, pero no corresponde a un cliente empresa. No puede utilizarse para Factura.",
      409,
      "POS_RELBASE_INVOICE_CUSTOMER_TYPE_MISMATCH"
    );
  }

  const relbaseCustomerId =
    toOptionalString(
      verifiedCustomer?.id ||
        verifiedCustomer?.customer_id ||
        verifiedCustomer?.relbase_customer_id
    );

  if (!relbaseCustomerId) {
    throw createServiceError(
      "Relbase no devolvió un identificador válido para el cliente de Factura",
      502,
      "POS_RELBASE_CUSTOMER_ID_MISSING"
    );
  }

  return {
    found: result?.found === true,
    created: result?.created === true,
    source: "RELBASE",
    customer: verifiedCustomer,
    relbase_customer_id: relbaseCustomerId,
  };
};

export const createPosSale = async ({
  cashierUserId,
  body,
  trustedPricingSnapshot = null,
}) => {
  const cashierId = assertUuid(
    cashierUserId,
    "cashierUserId"
  );

  const payload = body || {};
  const items = normalizeItems(payload.items);

  /*
   * Uso interno para conversión de cotizaciones.
   * Nunca se obtiene desde req.body: quotation.service.js
   * lo construye desde quotation_items persistidos.
   */
  const trustedPricing =
    trustedPricingSnapshot instanceof Map
      ? trustedPricingSnapshot
      : null;

  const paymentMethod = normalizePaymentMethod(
    payload?.payment?.method
  );

  if (!POS_PAYMENT_METHODS.has(paymentMethod)) {
    throw createServiceError(
      "Método POS inválido. Usa CASH, DEBIT_CARD, CREDIT_CARD o MANUAL_BANK_TRANSFER",
      400,
      "POS_PAYMENT_METHOD_INVALID"
    );
  }

  const suppliedIdempotencyKey =
    toOptionalString(payload.idempotency_key);

  const idempotencyKey = suppliedIdempotencyKey
    ? assertUuid(
        suppliedIdempotencyKey,
        "idempotency_key"
      )
    : crypto.randomUUID();

  const requestedCustomerUserId =
    payload.customer_user_id === undefined ||
    payload.customer_user_id === null ||
    String(payload.customer_user_id).trim() === ""
      ? null
      : assertUuid(
          payload.customer_user_id,
          "customer_user_id"
        );

  let customer = resolveCustomerIdentity({
    customer: payload.customer,
    billing: payload.billing,
  });

  const billing = normalizeBilling({
    documentType: payload.document_type,
    customer: payload.customer,
    billing: payload.billing,
  });

  const notes =
    toOptionalString(payload.notes);

  const operationDiscount =
    normalizeOperationDiscount(
      payload.operation_discount
    );

  let requestedCompanyId =
    payload.company_id === undefined ||
    payload.company_id === null ||
    String(payload.company_id).trim() === ""
      ? null
      : assertUuid(payload.company_id, "company_id");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing =
      await getExistingSaleByIdempotencyKey(
        client,
        idempotencyKey
      );

    if (existing) {
      await client.query("COMMIT");

      return {
        created: false,
        already_existed: true,
        idempotency_key: idempotencyKey,
        ...existing,
      };
    }

    let customerUser = null;

    if (requestedCustomerUserId) {
      const customerUserResult =
        await client.query(
          `
            SELECT
              u.id,
              u.first_name,
              u.last_name,
              u.email,
              u.phone,
              u.rut,
              u.is_active,
              r.name AS role,
              company.company_id,
              company.company_name
            FROM users u
            INNER JOIN roles r
              ON r.id = u.role_id
            LEFT JOIN LATERAL (
              SELECT
                cc.id AS company_id,
                COALESCE(
                  NULLIF(cc.trade_name, ''),
                  cc.legal_name
                ) AS company_name
              FROM company_users cu
              INNER JOIN customer_companies cc
                ON cc.id = cu.company_id
              WHERE cu.user_id = u.id
                AND cu.is_active = TRUE
                AND cc.is_active = TRUE
              ORDER BY
                cu.is_primary_contact DESC,
                cu.created_at ASC
              LIMIT 1
            ) company ON TRUE
            WHERE u.id = $1
              AND u.deleted_at IS NULL
              AND u.is_active = TRUE
              AND r.name IN (
                'CLIENTE',
                'USUARIO_EMPRESA'
              )
            LIMIT 1
          `,
          [requestedCustomerUserId]
        );

      if (customerUserResult.rowCount === 0) {
        throw createServiceError(
          "El cliente LaminatiWord seleccionado no existe, está inactivo o no posee un perfil comercial válido",
          404,
          "POS_CUSTOMER_USER_NOT_FOUND"
        );
      }

      customerUser = customerUserResult.rows[0];

      const localCustomerName = [
        customerUser.first_name,
        customerUser.last_name,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();

      customer = {
        name:
          localCustomerName ||
          customer.name,
        email:
          toOptionalString(customerUser.email) ||
          customer.email,
        rut:
          toOptionalString(customerUser.rut) ||
          customer.rut,
        phone:
          toOptionalString(customerUser.phone) ||
          customer.phone,
      };

      if (
        !requestedCompanyId &&
        customerUser.company_id
      ) {
        requestedCompanyId =
          customerUser.company_id;
      }

      if (
        billing.document_type === "BOLETA"
      ) {
        billing.rut =
          customer.rut || billing.rut;
        billing.legal_name =
          customer.name || billing.legal_name;
        billing.billing_email =
          customer.email || billing.billing_email;
        billing.phone =
          customer.phone || billing.phone;
      }
    }

    if (requestedCompanyId) {
      const companyCheck = await client.query(
        `
          SELECT id
          FROM customer_companies
          WHERE id = $1
            AND is_active = TRUE
          LIMIT 1
        `,
        [requestedCompanyId]
      );

      if (companyCheck.rowCount === 0) {
        throw createServiceError(
          "La empresa indicada no existe o no está activa",
          404,
          "POS_COMPANY_NOT_FOUND"
        );
      }
    }

    const configuration =
      await getPosConfiguration(
        client,
        paymentMethod
      );

    const resolvedItems = [];
    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;
    let total = 0;

    /*
     * Se bloquea cada fila de inventory con FOR UPDATE.
     * Los product_id vienen ordenados para reducir riesgo
     * de deadlock cuando dos cajas compran varios productos.
     */
    for (const requestedItem of items) {
      if (
        requestedItem.item_type === "SERVICE"
      ) {
        const relbaseProductId =
          getManualServiceRelbaseProductId();

        const quantity = Number(
          requestedItem.quantity
        );

        const unitPrice = roundMoney(
          requestedItem.unit_price_override
        );

        if (
          unitPrice === null ||
          unitPrice <= 0
        ) {
          throw createServiceError(
            "El servicio manual requiere un valor unitario mayor a cero",
            400,
            "POS_MANUAL_SERVICE_PRICE_REQUIRED"
          );
        }

        const effectiveTaxRate = Number(
          POS_MANUAL_SERVICE_TAX_RATE
        );

        if (
          !Number.isFinite(effectiveTaxRate) ||
          effectiveTaxRate < 0
        ) {
          throw createServiceError(
            "POS_MANUAL_SERVICE_TAX_RATE no posee un valor válido",
            500,
            "POS_MANUAL_SERVICE_TAX_RATE_INVALID"
          );
        }

        const lineSubtotal = roundMoney(
          unitPrice * quantity
        );

        let discountAmount = 0;

        if (
          requestedItem.discount_type ===
          "AMOUNT"
        ) {
          discountAmount = roundMoney(
            requestedItem.discount_value
          );
        } else {
          discountAmount = roundMoney(
            lineSubtotal *
              Number(
                requestedItem.discount_value ||
                  0
              ) /
              100
          );
        }

        if (
          discountAmount === null ||
          discountAmount < 0 ||
          discountAmount >= lineSubtotal
        ) {
          throw createServiceError(
            "El descuento del servicio debe ser menor al subtotal de la línea",
            400,
            "POS_MANUAL_SERVICE_DISCOUNT_EXCEEDS_LINE"
          );
        }

        const lineTotal = roundMoney(
          lineSubtotal - discountAmount
        );

        const tax = calculateGrossTax({
          grossTotal: lineTotal,
          taxRate: effectiveTaxRate,
        });

        subtotal = roundMoney(
          subtotal + lineSubtotal
        );
        discountTotal = roundMoney(
          discountTotal + discountAmount
        );
        taxTotal = roundMoney(
          taxTotal + tax.tax_amount
        );
        total = roundMoney(
          total + lineTotal
        );

        resolvedItems.push({
          item_type: "SERVICE",
          is_manual_service: true,
          product_id: null,
          relbase_product_id:
            relbaseProductId,
          product_code:
            RELBASE_MANUAL_SERVICE_CODE,
          reference_code:
            requestedItem.reference_code,
          sku: POS_MANUAL_SERVICE_SKU,
          name:
            requestedItem.service_description,
          tax_rate: effectiveTaxRate,
          quantity,
          unit_price: unitPrice,
          discount_amount: discountAmount,
          line_subtotal: lineSubtotal,
          line_total: lineTotal,
          tax_amount: tax.tax_amount,
          inventory_id: null,
          is_fex_shipping: false,
          available_before: null,
        });

        continue;
      }

      const itemResult = await client.query(
        `
          SELECT
            p.id AS product_id,
            p.relbase_product_id,
            p.sku,
            p.name,
            p.base_price,
            p.collection_id,
            p.tax_rate,
            p.is_active,
            p.allow_sale,

            i.id AS inventory_id,
            i.relbase_warehouse_id,
            i.warehouse_code,
            i.warehouse_name,
            i.stock_quantity,
            i.reserved_quantity,
            i.last_sync_at

          FROM products p

          LEFT JOIN inventory i
            ON i.product_id = p.id
           AND i.relbase_warehouse_id = $2

          WHERE p.id = $1
          LIMIT 1
        `,
        [
          requestedItem.product_id,
          POS_WAREHOUSE_ID,
        ]
      );

      if (itemResult.rowCount === 0) {
        throw createServiceError(
          "El producto solicitado no existe",
          404,
          "POS_PRODUCT_NOT_FOUND"
        );
      }

      const product = itemResult.rows[0];

      const isFexShipping =
        isFexShippingSku(product.sku);

      if (!isFexShipping) {
        if (!product.inventory_id) {
          throw createServiceError(
            "El producto no posee inventario sincronizado en la bodega POS",
            409,
            "POS_PRODUCT_INVENTORY_NOT_FOUND"
          );
        }

        const lockedInventory =
          await client.query(
            `
              SELECT
                id AS inventory_id,
                relbase_warehouse_id,
                warehouse_code,
                warehouse_name,
                stock_quantity,
                reserved_quantity,
                last_sync_at
              FROM inventory
              WHERE id = $1
              LIMIT 1
              FOR UPDATE
            `,
            [product.inventory_id]
          );

        if (lockedInventory.rowCount === 0) {
          throw createServiceError(
            "El inventario del producto cambió durante la venta",
            409,
            "POS_PRODUCT_INVENTORY_CHANGED"
          );
        }

        Object.assign(
          product,
          lockedInventory.rows[0]
        );
      }

      if (
        product.is_active !== true ||
        product.allow_sale !== true
      ) {
        throw createServiceError(
          `El producto ${product.sku} no está habilitado para venta`,
          409,
          "POS_PRODUCT_NOT_SALEABLE"
        );
      }

      if (!product.relbase_product_id) {
        throw createServiceError(
          `El producto ${product.sku} no está vinculado con Relbase`,
          409,
          "POS_PRODUCT_RELBASE_ID_REQUIRED"
        );
      }

      const trustedItem = trustedPricing
        ? trustedPricing.get(
            requestedItem.product_id
          )
        : null;

      const quantity = Number(
        requestedItem.quantity
      );

      let automaticCustomerPricing = null;

      /*
       * Si la línea no viene desde una cotización confiable
       * ni corresponde al despacho FEX, resolvemos siempre
       * el mejor precio automático en backend.
       *
       * Esto permite aplicar:
       * - promoción FIXED_PRICE
       * - promoción QUANTITY_TIER según quantity
       * - lista de precios de cliente, si corresponde
       *
       * Lista y promoción no se acumulan: customerPricing
       * elige el mejor precio disponible.
       */
      if (
        !trustedItem &&
        !isFexShipping
      ) {
        const resolvedPricing =
          await resolveCustomerProductPrice({
            client,
            userId:
              customerUser?.id ||
              null,
            quantity,
            product: {
              id: product.product_id,
              sku: product.sku,
              collection_id:
                product.collection_id ||
                null,
              base_price:
                product.base_price,
            },
          });

        const basePrice =
          roundMoney(
            resolvedPricing?.base_price
          );

        const finalPrice =
          roundMoney(
            resolvedPricing?.final_price
          );

        if (
          basePrice !== null &&
          finalPrice !== null &&
          finalPrice > 0 &&
          finalPrice < basePrice
        ) {
          automaticCustomerPricing =
            resolvedPricing;
        }
      }

      if (
        trustedItem &&
        Number(trustedItem.quantity) !== quantity
      ) {
        throw createServiceError(
          `La cantidad cotizada de ${product.sku} no coincide con la conversión solicitada`,
          409,
          "POS_QUOTATION_QUANTITY_MISMATCH"
        );
      }

      if (
        isFexShipping &&
        quantity !== 1
      ) {
        throw createServiceError(
          "El despacho FEX debe agregarse una sola vez por operación",
          400,
          "POS_FEX_QUANTITY_INVALID"
        );
      }

      const unitPriceSource =
        automaticCustomerPricing
          ? automaticCustomerPricing.base_price
          : trustedItem
            ? trustedItem.unit_price_gross
            : requestedItem
                  .unit_price_override !==
                null
              ? requestedItem
                  .unit_price_override
              : product.base_price;

      const unitPrice = roundMoney(
        unitPriceSource
      );

      if (
        isFexShipping &&
        !trustedItem &&
        (
          requestedItem.unit_price_override === null ||
          unitPrice === null ||
          unitPrice <= 0
        )
      ) {
        throw createServiceError(
          "Ingresa el valor informado por FEX antes de confirmar la operación",
          400,
          "POS_FEX_PRICE_REQUIRED"
        );
      }

      if (
        unitPrice === null ||
        unitPrice <= 0
      ) {
        throw createServiceError(
          `El producto ${product.sku} no posee un precio válido`,
          409,
          "POS_PRODUCT_PRICE_INVALID"
        );
      }

      const effectiveTaxRate =
        trustedItem?.tax_rate !== undefined &&
        trustedItem?.tax_rate !== null
          ? Number(trustedItem.tax_rate)
          : Number(product.tax_rate);

      let availablePos = null;

      if (!isFexShipping) {
        const stockQuantity = Number(
          product.stock_quantity
        );

        const reservedQuantity = Number(
          product.reserved_quantity
        );

        availablePos =
          stockQuantity -
          reservedQuantity;

        if (availablePos < quantity) {
          throw createServiceError(
            `Stock insuficiente para ${product.sku}. Disponible POS: ${availablePos}`,
            409,
            "POS_INSUFFICIENT_STOCK"
          );
        }
      }

      const lineSubtotal = roundMoney(
        unitPrice * quantity
      );

      let discountAmount = 0;

      if (automaticCustomerPricing) {
        discountAmount = roundMoney(
          (
            Number(
              automaticCustomerPricing.base_price
            ) -
            Number(
              automaticCustomerPricing.final_price
            )
          ) * quantity
        );
      } else if (!trustedItem) {
        if (
          requestedItem.discount_type ===
          "AMOUNT"
        ) {
          discountAmount =
            roundMoney(
              requestedItem
                .discount_value
            );
        } else {
          discountAmount =
            roundMoney(
              lineSubtotal *
                Number(
                  requestedItem
                    .discount_value ||
                    0
                ) /
                100
            );
        }
      }

      if (
        discountAmount === null ||
        discountAmount < 0 ||
        discountAmount >=
          lineSubtotal
      ) {
        throw createServiceError(
          `El descuento de ${product.sku} debe ser menor al subtotal de la línea`,
          400,
          "POS_ITEM_DISCOUNT_EXCEEDS_LINE"
        );
      }

      const lineTotal = roundMoney(
        lineSubtotal - discountAmount
      );

      const tax = calculateGrossTax({
        grossTotal: lineTotal,
        taxRate: effectiveTaxRate,
      });

      subtotal = roundMoney(
        subtotal + lineSubtotal
      );
      discountTotal = roundMoney(
        discountTotal +
        discountAmount
      );
      taxTotal = roundMoney(
        taxTotal + tax.tax_amount
      );
      total = roundMoney(
        total + lineTotal
      );

      resolvedItems.push({
        ...product,
        inventory_id:
          isFexShipping
            ? null
            : product.inventory_id,
        is_fex_shipping:
          isFexShipping,
        sku:
          trustedItem?.sku ||
          product.sku,
        name:
          trustedItem?.product_name ||
          product.name,
        tax_rate: effectiveTaxRate,
        quantity,
        unit_price: unitPrice,
        discount_amount: discountAmount,
        line_subtotal: lineSubtotal,
        line_total: lineTotal,
        tax_amount: tax.tax_amount,
        available_before:
          availablePos,
        customer_pricing:
          automaticCustomerPricing
            ? {
                price_list_id:
                  automaticCustomerPricing
                    .price_list?.id || null,
                rule_id:
                  automaticCustomerPricing
                    .rule?.id || null,
                rule_scope:
                  automaticCustomerPricing
                    .rule?.scope_type || null,
                discount_type:
                  automaticCustomerPricing
                    .rule?.discount_type || null,
                discount_value:
                  automaticCustomerPricing
                    .rule?.discount_value || null,
                final_price:
                  automaticCustomerPricing
                    .final_price,
                pricing_source:
                  automaticCustomerPricing
                    .pricing_source ||
                  null,
                promotion_id:
                  automaticCustomerPricing
                    .promotion?.id ||
                  null,
                promotion_name:
                  automaticCustomerPricing
                    .promotion?.name ||
                  null,
                promotion_type:
                  automaticCustomerPricing
                    .promotion?.type ||
                  null,
                promotion_tier:
                  automaticCustomerPricing
                    .promotion?.tier ||
                  null,
              }
            : null,
      });
    }

    const appliedOperationDiscount =
      applyOperationDiscount({
        items:
          resolvedItems,
        discount:
          operationDiscount,
      });

    if (
      appliedOperationDiscount.amount >
      0
    ) {
      discountTotal =
        roundMoney(
          resolvedItems.reduce(
            (
              sum,
              item
            ) =>
              sum +
              Number(
                item.discount_amount ||
                  0
              ),
            0
          )
        );

      taxTotal =
        roundMoney(
          resolvedItems.reduce(
            (
              sum,
              item
            ) =>
              sum +
              Number(
                item.tax_amount ||
                  0
              ),
            0
          )
        );

      total =
        roundMoney(
          resolvedItems.reduce(
            (
              sum,
              item
            ) =>
              sum +
              Number(
                item.line_total ||
                  0
              ),
            0
          )
        );
    }

    const amountReceivedRaw =
      payload?.payment?.amount_received;

    let amountReceived = null;
    let changeDue = 0;
    let externalReference =
      toOptionalString(
        payload?.payment?.external_reference
      );

    if (paymentMethod === "CASH") {
      /*
       * Showroom simplificado:
       * si amount_received no viene informado,
       * asumimos pago exacto por el total.
       *
       * Otros clientes de la API todavía pueden
       * enviar amount_received para calcular vuelto.
       */
      const hasAmountReceived =
        amountReceivedRaw !== undefined &&
        amountReceivedRaw !== null &&
        String(
          amountReceivedRaw
        ).trim() !== "";

      amountReceived =
        hasAmountReceived
          ? roundMoney(
              amountReceivedRaw
            )
          : total;

      if (
        amountReceived === null ||
        amountReceived < total
      ) {
        throw createServiceError(
          `El efectivo recibido debe ser igual o superior al total de ${total}`,
          400,
          "POS_CASH_AMOUNT_INSUFFICIENT"
        );
      }

      changeDue = roundMoney(
        amountReceived - total
      );
    } else {
      /*
       * Voucher, autorización y referencia bancaria
       * pasan a ser opcionales en venta presencial.
       * Si vienen informados, se siguen persistiendo.
       */
      amountReceived = total;
      changeDue = 0;
    }

    const orderResult = await client.query(
      `
        INSERT INTO orders (
          company_id,
          user_id,
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
          notes
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'STORE',
          'PENDING',
          'PENDING',
          'PENDING',
          $7,
          $8,
          0,
          $9,
          $10,
          'CLP',
          $11
        )
        RETURNING
          id,
          order_number,
          company_id,
          user_id,
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
      `,
      [
        requestedCompanyId,
        customerUser?.id || null,
        customer.email,
        customer.name,
        customer.rut,
        customer.phone,
        subtotal,
        discountTotal,
        taxTotal,
        total,
        notes,
      ]
    );

    const order = orderResult.rows[0];
    const insertedItems = [];
    const reservations = [];

    for (const item of resolvedItems) {
      const orderItemResult = await client.query(
        `
          INSERT INTO order_items (
            order_id,
            product_id,
            sku,
            product_name,
            product_code,
            reference_code,
            quantity,
            unit_price,
            discount_amount,
            tax_rate,
            line_subtotal,
            line_total
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
            $12
          )
          RETURNING
            id,
            order_id,
            product_id,
            sku,
            product_name,
            product_code,
            reference_code,
            quantity,
            unit_price,
            discount_amount,
            tax_rate,
            line_subtotal,
            line_total,
            created_at
        `,
        [
          order.id,
          item.product_id,
          item.sku,
          item.name,
          item.product_code || null,
          item.reference_code || null,
          item.quantity,
          item.unit_price,
          item.discount_amount,
          item.tax_rate,
          item.line_subtotal,
          item.line_total,
        ]
      );

      insertedItems.push(
        orderItemResult.rows[0]
      );

      await captureOrderItemItalyPriceSnapshot({
        client,
        orderId:
          order.id,
        orderItemId:
          orderItemResult.rows[0].id,
        productId:
          item.product_id,
        quantity:
          item.quantity,
      });

      /*
       * SHOWROOM / POS:
       * La venta presencial NO crea reservas de inventario
       * ni incrementa inventory.reserved_quantity.
       *
       * Las reservas quedan exclusivamente para el flujo
       * de pedidos online. El POS sigue respetando las
       * reservas online existentes al validar available_pos,
       * pero su propia venta utiliza el stock sincronizado
       * desde Relbase como fuente de verdad.
       *
       * `reservations` se conserva vacío en la respuesta
       * para mantener compatibilidad con consumidores
       * existentes de este servicio.
       */
    }

    await client.query(
      `
        INSERT INTO order_billing_data (
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
          relbase_customer_id
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
          $15
        )
      `,
      [
        order.id,
        billing.document_type,
        billing.customer_type,
        billing.rut,
        billing.legal_name,
        billing.trade_name,
        billing.business_activity,
        billing.billing_email,
        billing.phone,
        billing.address_line,
        billing.commune,
        billing.city,
        billing.region,
        billing.country,
        billing.relbase_customer_id,
      ]
    );

    const paymentInsert = await client.query(
      `
        INSERT INTO payments (
          order_id,
          provider_id,
          payment_method_id,
          idempotency_key,
          amount,
          currency,
          status,
          external_reference,
          amount_received,
          change_due,
          notes
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          'CLP',
          'PENDING',
          $6,
          $7,
          $8,
          $9
        )
        RETURNING id
      `,
      [
        order.id,
        configuration.provider.id,
        configuration.method.id,
        idempotencyKey,
        total,
        externalReference,
        amountReceived,
        changeDue,
        `Venta POS ${paymentMethod}`,
      ]
    );

    const paymentId = paymentInsert.rows[0].id;

    /*
     * Se realiza PENDING -> PAID mediante UPDATE para que
     * trg_payment_status_history registre la transición.
     */
    const paymentResult = await client.query(
      `
        UPDATE payments
        SET
          status = 'PAID',
          confirmed_at = NOW(),
          confirmed_by = $2
        WHERE id = $1
        RETURNING
          id,
          order_id,
          amount,
          currency,
          status,
          external_reference,
          amount_received,
          change_due,
          confirmed_at,
          confirmed_by,
          created_at,
          updated_at
      `,
      [paymentId, cashierId]
    );

    const completedOrderResult =
      await client.query(
        `
          UPDATE orders
          SET
            status = 'COMPLETED',
            payment_status = 'PAID',
            fulfillment_status = 'DELIVERED'
          WHERE id = $1
          RETURNING
            id,
            order_number,
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
        `,
        [order.id]
      );

    await client.query("COMMIT");

    return {
      created: true,
      already_existed: false,
      idempotency_key: idempotencyKey,
      dte_emission_executed: false,
      relbase_stock_write_executed: false,
      order: completedOrderResult.rows[0],
      operation_discount: {
        type:
          appliedOperationDiscount.type,
        value:
          appliedOperationDiscount.value,
        amount:
          appliedOperationDiscount.amount,
      },
      payment: {
        ...paymentResult.rows[0],
        method: configuration.method.code,
        provider: configuration.provider.code,
      },
      billing: {
        document_type:
          billing.document_type,
        customer_type:
          billing.customer_type,
        relbase_customer_id:
          billing.relbase_customer_id,
      },
      items: insertedItems,
      reservations,
      next_action:
        "PREPARE_TAX_DOCUMENT_WHEN_REQUIRED",
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // La transacción puede haber terminado.
    }

    /*
     * Carrera de idempotencia: si otro request ganó
     * la inserción del mismo payments.idempotency_key,
     * devolvemos la venta ya creada en vez de duplicar.
     */
    if (
      error?.code === "23505" &&
      String(error?.constraint || "") ===
        "payments_idempotency_key_unique"
    ) {
      const existingClient =
        await pool.connect();

      try {
        const existing =
          await getExistingSaleByIdempotencyKey(
            existingClient,
            idempotencyKey
          );

        if (existing) {
          return {
            created: false,
            already_existed: true,
            idempotency_key:
              idempotencyKey,
            ...existing,
          };
        }
      } finally {
        existingClient.release();
      }
    }

    throw error;
  } finally {
    client.release();
  }
};

export const getPosSaleByOrderId = async ({
  orderId,
}) => {
  const normalizedOrderId = assertUuid(
    orderId,
    "orderId"
  );

  const result = await pool.query(
    `
      SELECT
        p.idempotency_key
      FROM payments p
      INNER JOIN orders o
        ON o.id = p.order_id
      INNER JOIN payment_providers pp
        ON pp.id = p.provider_id
      WHERE p.order_id = $1
        AND o.source = 'STORE'
        AND pp.code = $2
      LIMIT 1
    `,
    [normalizedOrderId, POS_PROVIDER_CODE]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La venta POS no existe",
      404,
      "POS_SALE_NOT_FOUND"
    );
  }

  const snapshot =
    await getExistingSaleByIdempotencyKey(
      pool,
      result.rows[0].idempotency_key
    );

  return snapshot;
};
