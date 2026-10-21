import pool from "../config/database.js";

import {
  resolveCustomerProductPrice,
} from "./customerPricing.service.js";

import {
  captureOrderItemItalyPriceSnapshot,
} from "./italyPriceSnapshot.service.js";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_RESERVATION_MINUTES = 48 * 60;

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

const isAdminRole = (role) => {
  return (
    String(role || "")
      .trim()
      .toUpperCase() === "ADMIN"
  );
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

const getDefaultWarehouseId = () => {
  const warehouseId = Number(
    process.env.RELBASE_DEFAULT_WAREHOUSE_ID
  );

  if (
    !Number.isInteger(warehouseId) ||
    warehouseId <= 0
  ) {
    throw createServiceError(
      "RELBASE_DEFAULT_WAREHOUSE_ID no se encuentra configurado correctamente",
      500,
      "WEB_WAREHOUSE_NOT_CONFIGURED"
    );
  }

  return warehouseId;
};

const getReservationMinutes = () => {
  const configured = Number(
    process.env.WEB_ORDER_RESERVATION_MINUTES
  );

  if (
    Number.isInteger(configured) &&
    configured >= 15 &&
    configured <= 10080
  ) {
    return configured;
  }

  return DEFAULT_RESERVATION_MINUTES;
};

const normalizeItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw createServiceError(
      "La orden debe contener al menos un producto",
      400,
      "ORDER_ITEMS_REQUIRED"
    );
  }

  const aggregated = new Map();

  for (const item of items) {
    const productId = assertUuid(
      item?.product_id,
      "product_id"
    );

    const quantity = Number(item?.quantity);

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      Math.round(quantity * 1000) !==
        quantity * 1000
    ) {
      throw createServiceError(
        "La cantidad de cada producto debe ser mayor a cero y tener como máximo 3 decimales",
        400,
        "ORDER_ITEM_QUANTITY_INVALID"
      );
    }

    const current = aggregated.get(productId) || 0;
    aggregated.set(
      productId,
      Number((current + quantity).toFixed(3))
    );
  }

  return [...aggregated.entries()]
    .map(([product_id, quantity]) => ({
      product_id,
      quantity,
    }))
    .sort((a, b) =>
      a.product_id.localeCompare(b.product_id)
    );
};

const normalizeDocumentType = (value) => {
  const documentType = String(
    value || "BOLETA"
  )
    .trim()
    .toUpperCase();

  if (
    documentType !== "BOLETA" &&
    documentType !== "FACTURA"
  ) {
    throw createServiceError(
      "document_type debe ser BOLETA o FACTURA",
      400,
      "ORDER_DOCUMENT_TYPE_INVALID"
    );
  }

  return documentType;
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
      "No fue posible calcular los impuestos de la orden",
      409,
      "ORDER_TAX_CALCULATION_INVALID"
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

const assertOrderAccess = ({
  order,
  requesterUserId,
  requesterRole,
}) => {
  if (isAdminRole(requesterRole)) {
    return;
  }

  if (
    !requesterUserId ||
    !order?.user_id ||
    String(order.user_id) !==
      String(requesterUserId)
  ) {
    throw createServiceError(
      "No tienes permiso para acceder a esta orden",
      403,
      "ORDER_ACCESS_DENIED"
    );
  }
};

const resolveBilling = async (
  client,
  {
    documentType,
    requesterUser,
    companyId,
  }
) => {
  const customerName = [
    requesterUser?.first_name,
    requesterUser?.last_name,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (documentType === "BOLETA") {
    return {
      company_id: null,
      document_type: "BOLETA",
      customer_type: "PERSON",
      rut: toOptionalString(requesterUser?.rut),
      legal_name:
        customerName ||
        toOptionalString(requesterUser?.email) ||
        "Cliente Laminatiword",
      trade_name: null,
      business_activity: null,
      billing_email:
        toOptionalString(requesterUser?.email),
      phone:
        toOptionalString(requesterUser?.phone),
      address_line: null,
      commune: null,
      city: null,
      region: null,
      country: "Chile",
      relbase_customer_id: null,
    };
  }

  const normalizedCompanyId = assertUuid(
    companyId,
    "company_id"
  );

  const result = await client.query(
    `
      SELECT
        cc.id,
        cc.legal_name,
        cc.trade_name,
        cc.rut,
        cc.business_activity,
        cc.billing_email,
        cc.phone,
        cc.address_line,
        cc.commune,
        cc.city,
        cc.region,
        cc.country,
        cc.relbase_customer_id
      FROM company_users cu
      INNER JOIN customer_companies cc
        ON cc.id = cu.company_id
      WHERE cu.user_id = $1
        AND cu.company_id = $2
        AND cu.is_active = TRUE
        AND cc.is_active = TRUE
      LIMIT 1
    `,
    [requesterUser.id, normalizedCompanyId]
  );

  if (result.rowCount === 0) {
    throw createServiceError(
      "La empresa indicada no está asociada a tu cuenta",
      403,
      "ORDER_COMPANY_ACCESS_DENIED"
    );
  }

  const company = result.rows[0];

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
    if (!toOptionalString(company[field])) {
      throw createServiceError(
        `La empresa seleccionada no posee ${label} configurado`,
        409,
        "ORDER_INVOICE_COMPANY_INCOMPLETE"
      );
    }
  }

  return {
    company_id: company.id,
    document_type: "FACTURA",
    customer_type: "COMPANY",
    rut: company.rut,
    legal_name: company.legal_name,
    trade_name: company.trade_name,
    business_activity:
      company.business_activity,
    billing_email:
      company.billing_email || requesterUser.email,
    phone:
      company.phone || requesterUser.phone,
    address_line: company.address_line,
    commune: company.commune,
    city: company.city,
    region: company.region,
    country: company.country || "Chile",
    relbase_customer_id:
      String(company.relbase_customer_id),
  };
};

const getOrderSnapshot = async (
  client,
  orderId,
  {
    requesterUserId,
    requesterRole,
    lock = false,
  }
) => {
  const orderResult = await client.query(
    `
      SELECT
        id,
        order_number,
        checkout_idempotency_key,
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
      ${lock ? "FOR UPDATE" : ""}
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

  const order = orderResult.rows[0];

  assertOrderAccess({
    order,
    requesterUserId,
    requesterRole,
  });

  const [
    itemsResult,
    billingResult,
    paymentResult,
    reservationResult,
    taxDocumentResult,
  ] = await Promise.all([
    client.query(
      `
        SELECT
          oi.id,
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
          v.slug,
          v.primary_image_url,
          v.primary_image_alt
        FROM order_items oi
        LEFT JOIN vw_product_catalog v
          ON v.id = oi.product_id
        WHERE oi.order_id = $1
        ORDER BY oi.created_at ASC, oi.id ASC
      `,
      [orderId]
    ),

    client.query(
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
        WHERE order_id = $1
        LIMIT 1
      `,
      [orderId]
    ),

    client.query(
      `
        SELECT
          p.id,
          p.amount,
          p.currency,
          p.status,
          p.customer_reference,
          p.external_reference,
          p.transfer_date,
          p.confirmed_at,
          p.rejected_at,
          p.rejection_reason,
          p.created_at,
          p.updated_at,
          pm.code AS payment_method_code,
          pm.name AS payment_method_name,
          pp.code AS provider_code,
          pp.name AS provider_name
        FROM payments p
        INNER JOIN payment_methods pm
          ON pm.id = p.payment_method_id
        INNER JOIN payment_providers pp
          ON pp.id = p.provider_id
        WHERE p.order_id = $1
        LIMIT 1
      `,
      [orderId]
    ),

    client.query(
      `
        SELECT
          ir.id,
          ir.inventory_id,
          ir.quantity,
          ir.status,
          ir.expires_at,
          ir.confirmed_at,
          ir.created_at,
          i.relbase_warehouse_id,
          i.warehouse_code,
          i.warehouse_name
        FROM inventory_reservations ir
        INNER JOIN inventory i
          ON i.id = ir.inventory_id
        WHERE ir.order_id = $1
        ORDER BY ir.created_at ASC, ir.id ASC
      `,
      [orderId]
    ),

    client.query(
      `
        SELECT
          id,
          document_type,
          sii_code,
          relbase_document_id,
          folio,
          status,
          relbase_status,
          sii_status,
          sii_status_name,
          total_amount,
          issued_at,
          created_at,
          updated_at
        FROM tax_documents
        WHERE order_id = $1
          AND document_type IN ('BOLETA', 'FACTURA')
        LIMIT 1
      `,
      [orderId]
    ),
  ]);

  return {
    order,
    billing:
      billingResult.rows[0] || null,
    items: itemsResult.rows,
    payment:
      paymentResult.rows[0] || null,
    reservations: reservationResult.rows,
    tax_document:
      taxDocumentResult.rows[0] || null,
  };
};

const getExistingByIdempotencyKey = async (
  client,
  idempotencyKey,
  requesterUserId,
  requesterRole
) => {
  const result = await client.query(
    `
      SELECT id
      FROM orders
      WHERE checkout_idempotency_key = $1
      LIMIT 1
    `,
    [idempotencyKey]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return getOrderSnapshot(
    client,
    result.rows[0].id,
    {
      requesterUserId,
      requesterRole,
    }
  );
};

export const createWebOrder = async ({
  requesterUser,
  payload,
}) => {
  if (!requesterUser?.id) {
    throw createServiceError(
      "Autenticación requerida",
      401,
      "AUTH_REQUIRED"
    );
  }

  const items = normalizeItems(payload?.items);
  const documentType = normalizeDocumentType(
    payload?.document_type
  );

  const suppliedIdempotencyKey =
    toOptionalString(payload?.idempotency_key);

  if (!suppliedIdempotencyKey) {
    throw createServiceError(
      "idempotency_key es obligatorio para crear una orden",
      400,
      "ORDER_IDEMPOTENCY_KEY_REQUIRED"
    );
  }

  const idempotencyKey = assertUuid(
    suppliedIdempotencyKey,
    "idempotency_key"
  );

  const notes =
    toOptionalString(payload?.notes) ||
    "Pedido web Laminatiword";

  const reservationMinutes =
    getReservationMinutes();

  const warehouseId =
    getDefaultWarehouseId();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing =
      await getExistingByIdempotencyKey(
        client,
        idempotencyKey,
        requesterUser.id,
        requesterUser.role
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

    const billing = await resolveBilling(
      client,
      {
        documentType,
        requesterUser,
        companyId: payload?.company_id,
      }
    );

    const resolvedItems = [];
    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;
    let total = 0;

    for (const requestedItem of items) {
      const productResult = await client.query(
        `
          SELECT
            p.id AS product_id,
            p.relbase_product_id,
            p.sku,
            p.internal_code,
            p.name,
            p.description,
            p.base_price,
            p.tax_rate,
            p.finish,
            p.collection_id,
            p.is_active,
            p.is_published,
            p.allow_sale,
            v.promotion_id,
            v.promotion_name,
            v.promotional_price,
            v.final_price,
            v.has_promotion,
            i.id AS inventory_id,
            i.relbase_warehouse_id,
            i.warehouse_code,
            i.warehouse_name,
            i.stock_quantity,
            i.reserved_quantity,
            i.safety_stock,
            i.last_sync_at
          FROM products p
          INNER JOIN vw_product_catalog v
            ON v.id = p.id
          INNER JOIN inventory i
            ON i.product_id = p.id
           AND i.relbase_warehouse_id = $2
          WHERE p.id = $1
            AND p.is_active = TRUE
            AND p.is_published = TRUE
            AND p.allow_sale = TRUE
          LIMIT 1
          FOR UPDATE OF i
        `,
        [requestedItem.product_id, warehouseId]
      );

      if (productResult.rowCount === 0) {
        throw createServiceError(
          "Uno de los productos no está disponible para venta web en la bodega configurada",
          409,
          "ORDER_PRODUCT_NOT_AVAILABLE"
        );
      }

      const product = productResult.rows[0];

      if (!product.relbase_product_id) {
        throw createServiceError(
          `El producto ${product.sku} no está vinculado con Relbase`,
          409,
          "ORDER_PRODUCT_RELBASE_ID_REQUIRED"
        );
      }

      /*
       * El precio se vuelve a resolver SIEMPRE en backend.
       *
       * Prioridad comercial:
       * 1. Regla PRODUCT de la lista asignada.
       * 2. Regla COLLECTION.
       * 3. Promoción pública.
       *
       * Lista y promoción NO se acumulan:
       * se utiliza el mejor precio disponible.
       */
      const pricing =
        await resolveCustomerProductPrice({
          client,
          userId: requesterUser.id,
          product,
          quantity:
            requestedItem.quantity,
        });

      const basePrice =
        roundMoney(
          pricing.base_price
        );

      const finalPrice =
        roundMoney(
          pricing.final_price
        );

      if (
        basePrice === null ||
        finalPrice === null ||
        basePrice <= 0 ||
        finalPrice <= 0 ||
        finalPrice > basePrice
      ) {
        throw createServiceError(
          `El producto ${product.sku} no posee un precio web válido`,
          409,
          "ORDER_PRODUCT_PRICE_INVALID"
        );
      }

      const activeReservationResult =
        await client.query(
          `
            SELECT
              COALESCE(SUM(quantity), 0) AS quantity
            FROM inventory_reservations
            WHERE inventory_id = $1
              AND status = 'ACTIVE'
              AND (
                expires_at IS NULL
                OR expires_at > NOW()
              )
          `,
          [product.inventory_id]
        );

      const stockQuantity = Number(
        product.stock_quantity
      );
      const confirmedReserved = Number(
        product.reserved_quantity
      );
      const activeReserved = Number(
        activeReservationResult.rows[0].quantity
      );
      const safetyStock = Number(
        product.safety_stock
      );

      const available =
        stockQuantity -
        confirmedReserved -
        activeReserved -
        safetyStock;

      if (available < requestedItem.quantity) {
        throw createServiceError(
          `Stock insuficiente para ${product.sku}. Disponible: ${Math.max(available, 0)}`,
          409,
          "ORDER_INSUFFICIENT_STOCK"
        );
      }

      const grossSubtotal = roundMoney(
        basePrice * requestedItem.quantity
      );

      const grossFinal = roundMoney(
        finalPrice * requestedItem.quantity
      );

      const discountAmount = roundMoney(
        grossSubtotal - grossFinal
      );

      const tax = calculateGrossTax({
        grossTotal: grossFinal,
        taxRate: product.tax_rate,
      });

      subtotal = roundMoney(
        subtotal + grossSubtotal
      );
      discountTotal = roundMoney(
        discountTotal + discountAmount
      );
      taxTotal = roundMoney(
        taxTotal + tax.tax_amount
      );
      total = roundMoney(
        total + grossFinal
      );

      resolvedItems.push({
        ...product,
        quantity: requestedItem.quantity,
        unit_price: basePrice,
        final_unit_price: finalPrice,
        discount_amount: discountAmount,
        line_subtotal: grossSubtotal,
        line_total: grossFinal,
        tax_amount: tax.tax_amount,
        available_before: available,

        /*
         * Snapshot operativo en memoria.
         * order_items persiste el precio base y el monto
         * descontado; en una etapa posterior añadiremos
         * metadatos comerciales explícitos para DTE/UI.
         */
        pricing,
      });
    }

    const customerName = [
      requesterUser.first_name,
      requesterUser.last_name,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    const orderResult = await client.query(
      `
        INSERT INTO orders (
          checkout_idempotency_key,
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
          notes
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          'WEB',
          'PENDING',
          'PENDING',
          'PENDING',
          $8,
          $9,
          0,
          $10,
          $11,
          'CLP',
          $12
        )
        RETURNING
          id,
          order_number,
          checkout_idempotency_key,
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
      `,
      [
        idempotencyKey,
        requesterUser.id,
        billing.company_id,
        requesterUser.email,
        customerName || requesterUser.email,
        requesterUser.rut || null,
        requesterUser.phone || null,
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

    const expiresAt = new Date(
      Date.now() +
        reservationMinutes * 60 * 1000
    );

    for (const item of resolvedItems) {
      const itemResult = await client.query(
        `
          INSERT INTO order_items (
            order_id,
            product_id,
            sku,
            product_name,
            product_code,
            finish,
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
            $12,
            $13
          )
          RETURNING
            id,
            order_id,
            product_id,
            sku,
            product_name,
            product_code,
            finish,
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
          item.sku,
          item.finish || null,
          item.internal_code || null,
          item.quantity,
          item.unit_price,
          item.discount_amount,
          item.tax_rate,
          item.line_subtotal,
          item.line_total,
        ]
      );

      insertedItems.push(itemResult.rows[0]);

      await captureOrderItemItalyPriceSnapshot({
        client,
        orderId:
          order.id,
        orderItemId:
          itemResult.rows[0].id,
        productId:
          item.product_id,
        quantity:
          item.quantity,
      });

      const reservationResult =
        await client.query(
          `
            INSERT INTO inventory_reservations (
              inventory_id,
              order_id,
              quantity,
              status,
              expires_at
            )
            VALUES (
              $1,
              $2,
              $3,
              'ACTIVE',
              $4
            )
            RETURNING
              id,
              inventory_id,
              order_id,
              quantity,
              status,
              expires_at,
              confirmed_at,
              created_at,
              updated_at
          `,
          [
            item.inventory_id,
            order.id,
            item.quantity,
            expiresAt.toISOString(),
          ]
        );

      reservations.push(
        reservationResult.rows[0]
      );
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

    await client.query("COMMIT");

    return {
      created: true,
      already_existed: false,
      idempotency_key: idempotencyKey,
      reservation_expires_at:
        expiresAt.toISOString(),
      order,
      billing,
      items: insertedItems,
      reservations,
      next_action:
        "CREATE_MANUAL_BANK_TRANSFER_PAYMENT",
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // La transacción puede haber finalizado.
    }

    if (
      error?.code === "23505" &&
      String(error?.constraint || "") ===
        "uq_orders_checkout_idempotency_key"
    ) {
      const existing =
        await getExistingByIdempotencyKey(
          pool,
          idempotencyKey,
          requesterUser.id,
          requesterUser.role
        );

      if (existing) {
        return {
          created: false,
          already_existed: true,
          idempotency_key: idempotencyKey,
          ...existing,
        };
      }
    }

    throw error;
  } finally {
    client.release();
  }
};

export const listOrders = async ({
  requesterUserId,
  requesterRole,
  query = {},
}) => {
  const page = Math.max(
    Number.parseInt(query.page, 10) ||
      DEFAULT_PAGE,
    1
  );

  const requestedLimit =
    Number.parseInt(query.limit, 10) ||
    DEFAULT_LIMIT;

  const limit = Math.min(
    Math.max(requestedLimit, 1),
    MAX_LIMIT
  );

  const offset = (page - 1) * limit;
  const values = [];
  const conditions = [];

  if (!isAdminRole(requesterRole)) {
    values.push(requesterUserId);
    conditions.push(
      `o.user_id = $${values.length}`
    );
  }

  const filters = [
    ["status", query.status],
    ["payment_status", query.payment_status],
    ["source", query.source],
  ];

  for (const [column, rawValue] of filters) {
    const value = toOptionalString(rawValue);

    if (value) {
      values.push(value.toUpperCase());
      conditions.push(
        `UPPER(o.${column}) = $${values.length}`
      );
    }
  }

  const where =
    conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

  const countResult = await pool.query(
    `
      SELECT COUNT(*) AS total
      FROM orders o
      ${where}
    `,
    values
  );

  const total = Number(
    countResult.rows[0].total
  );

  const listValues = [...values];
  listValues.push(limit);
  const limitParam = `$${listValues.length}`;
  listValues.push(offset);
  const offsetParam = `$${listValues.length}`;

  const result = await pool.query(
    `
      SELECT
        o.id,
        o.order_number,
        o.user_id,
        o.company_id,
        o.email,
        o.customer_name,
        o.source,
        o.status,
        o.payment_status,
        o.fulfillment_status,
        o.subtotal,
        o.discount_total,
        o.shipping_total,
        o.tax_total,
        o.total,
        o.currency,
        o.created_at,
        o.updated_at,
        obd.document_type,
        p.status AS payment_record_status
      FROM orders o
      LEFT JOIN order_billing_data obd
        ON obd.order_id = o.id
      LEFT JOIN payments p
        ON p.order_id = o.id
      ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
    listValues
  );

  const totalPages =
    total === 0
      ? 0
      : Math.ceil(total / limit);

  return {
    pagination: {
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next_page: page < totalPages,
      has_previous_page: page > 1,
    },
    orders: result.rows,
  };
};

export const getOrderById = async ({
  orderId,
  requesterUserId,
  requesterRole,
}) => {
  const normalizedOrderId = assertUuid(
    orderId,
    "orderId"
  );

  return getOrderSnapshot(
    pool,
    normalizedOrderId,
    {
      requesterUserId,
      requesterRole,
    }
  );
};

export const cancelOrder = async ({
  orderId,
  requesterUserId,
  requesterRole,
}) => {
  const normalizedOrderId = assertUuid(
    orderId,
    "orderId"
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const snapshot = await getOrderSnapshot(
      client,
      normalizedOrderId,
      {
        requesterUserId,
        requesterRole,
        lock: true,
      }
    );

    const order = snapshot.order;

    if (
      String(order.status || "")
        .toUpperCase() === "CANCELLED"
    ) {
      await client.query("COMMIT");

      return {
        cancelled: false,
        already_cancelled: true,
        ...snapshot,
      };
    }

    if (
      String(order.payment_status || "")
        .toUpperCase() === "PAID"
    ) {
      throw createServiceError(
        "Una orden pagada no puede cancelarse desde este flujo; requiere gestión de devolución/nota de crédito",
        409,
        "PAID_ORDER_CANCELLATION_NOT_ALLOWED"
      );
    }

    const paymentRecordStatus = String(
      snapshot.payment?.status || ""
    )
      .trim()
      .toUpperCase();

    if (paymentRecordStatus === "PAID") {
      throw createServiceError(
        "Una orden pagada no puede cancelarse desde este flujo",
        409,
        "PAID_ORDER_CANCELLATION_NOT_ALLOWED"
      );
    }

    if (
      paymentRecordStatus ===
        "AWAITING_CONFIRMATION"
    ) {
      throw createServiceError(
        "La transferencia se encuentra en revisión. La orden no puede cancelarse mientras exista un comprobante pendiente",
        409,
        "ORDER_PAYMENT_UNDER_REVIEW"
      );
    }

    await client.query(
      `
        UPDATE inventory_reservations
        SET expires_at = NOW()
        WHERE order_id = $1
          AND status = 'ACTIVE'
      `,
      [normalizedOrderId]
    );

    const orderUpdate = await client.query(
      `
        UPDATE orders
        SET
          status = 'CANCELLED',
          payment_status =
            CASE
              WHEN payment_status = 'PAID'
                THEN payment_status
              ELSE 'FAILED'
            END
        WHERE id = $1
        RETURNING
          id,
          order_number,
          status,
          payment_status,
          fulfillment_status,
          total,
          currency,
          updated_at
      `,
      [normalizedOrderId]
    );

    await client.query("COMMIT");

    return {
      cancelled: true,
      already_cancelled: false,
      order: orderUpdate.rows[0],
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
