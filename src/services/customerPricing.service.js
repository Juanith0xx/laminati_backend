import pool from "../config/database.js";

import {
  resolveProductPrice,
} from "./productPricing.service.js";

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

const normalizeBoolean = (value) =>
  value === true ||
  value === "true" ||
  value === "t" ||
  value === 1 ||
  value === "1";

const isValidDateWindow = (row) => {
  if (!row) return false;

  const today = new Date();
  const todayDate = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  if (row.valid_from) {
    const from = new Date(`${String(row.valid_from).slice(0, 10)}T00:00:00`);
    if (!Number.isNaN(from.getTime()) && todayDate < from) {
      return false;
    }
  }

  if (row.valid_until) {
    const until = new Date(`${String(row.valid_until).slice(0, 10)}T23:59:59`);
    if (!Number.isNaN(until.getTime()) && todayDate > until) {
      return false;
    }
  }

  return true;
};

const getAssignedPriceList = async ({
  db,
  userId,
}) => {
  if (!userId) {
    return null;
  }

  const result = await db.query(
    `
      SELECT
        pl.id,
        pl.name,
        pl.description,
        pl.is_active,
        pl.valid_from,
        pl.valid_until
      FROM user_price_lists upl
      INNER JOIN price_lists pl
        ON pl.id = upl.price_list_id
      WHERE upl.user_id = $1
      LIMIT 1
    `,
    [userId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const priceList = result.rows[0];

  if (
    !normalizeBoolean(priceList.is_active) ||
    !isValidDateWindow(priceList)
  ) {
    return null;
  }

  return priceList;
};

const getBestPriceListRule = async ({
  db,
  priceListId,
  productId,
  collectionId,
}) => {
  if (!priceListId || !productId) {
    return null;
  }

  const result = await db.query(
    `
      SELECT
        r.id,
        r.price_list_id,
        r.scope_type,
        r.product_id,
        r.collection_id,
        r.discount_type,
        r.discount_value,
        r.is_active
      FROM price_list_rules r
      WHERE r.price_list_id = $1
        AND r.is_active = TRUE
        AND (
          (
            r.scope_type = 'PRODUCT'
            AND r.product_id = $2
          )
          OR
          (
            r.scope_type = 'COLLECTION'
            AND $3::uuid IS NOT NULL
            AND r.collection_id = $3
          )
        )
      ORDER BY
        CASE
          WHEN r.scope_type = 'PRODUCT' THEN 0
          WHEN r.scope_type = 'COLLECTION' THEN 1
          ELSE 2
        END ASC,
        r.created_at DESC
      LIMIT 1
    `,
    [
      priceListId,
      productId,
      collectionId || null,
    ]
  );

  return result.rows[0] || null;
};

const calculatePriceListPrice = ({
  basePrice,
  rule,
}) => {
  if (!rule) {
    return null;
  }

  const discountValue =
    roundMoney(rule.discount_value);

  if (
    discountValue === null ||
    discountValue <= 0
  ) {
    throw createServiceError(
      "La regla de lista de precios posee un descuento inválido",
      409,
      "CUSTOMER_PRICING_RULE_INVALID"
    );
  }

  if (rule.discount_type === "PERCENTAGE") {
    if (discountValue > 100) {
      throw createServiceError(
        "La regla porcentual supera el 100%",
        409,
        "CUSTOMER_PRICING_PERCENTAGE_INVALID"
      );
    }

    return roundMoney(
      basePrice * (1 - discountValue / 100)
    );
  }

  if (rule.discount_type === "FIXED_AMOUNT") {
    if (discountValue >= basePrice) {
      throw createServiceError(
        "El descuento fijo de la lista debe ser menor al precio base",
        409,
        "CUSTOMER_PRICING_FIXED_DISCOUNT_INVALID"
      );
    }

    return roundMoney(
      basePrice - discountValue
    );
  }

  throw createServiceError(
    `Tipo de descuento no soportado: ${rule.discount_type}`,
    409,
    "CUSTOMER_PRICING_DISCOUNT_TYPE_NOT_SUPPORTED"
  );
};

export const resolveCustomerProductPrice = async ({
  client = null,
  userId = null,
  product,
  quantity = 1,
}) => {
  if (!product?.product_id && !product?.id) {
    throw createServiceError(
      "Se requiere un producto válido para resolver el precio",
      400,
      "CUSTOMER_PRICING_PRODUCT_REQUIRED"
    );
  }

  const db = client || pool;
  const productId =
    product.product_id || product.id;

  /*
   * El precio público se resuelve siempre en backend y
   * considerando la cantidad. Esto permite:
   *
   * - FIXED_PRICE
   * - QUANTITY_TIER
   *
   * sin confiar en el precio enviado por frontend.
   */
  const publicPricing =
    await resolveProductPrice({
      productId,
      quantity,
      db,
    });

  const basePrice =
    roundMoney(
      publicPricing.base_price
    );

  if (
    basePrice === null ||
    basePrice <= 0
  ) {
    throw createServiceError(
      `El producto ${product.sku || productId} no posee un precio base válido`,
      409,
      "CUSTOMER_PRICING_BASE_PRICE_INVALID"
    );
  }

  const publicFinalPrice =
    roundMoney(
      publicPricing.unit_price
    );

  const hasPromotion =
    Boolean(
      publicPricing.promotion_applied
    );

  const promotionPrice =
    hasPromotion &&
    publicFinalPrice !== null &&
    publicFinalPrice > 0 &&
    publicFinalPrice < basePrice
      ? publicFinalPrice
      : null;

  const priceList =
    await getAssignedPriceList({
      db,
      userId,
    });

  const rule =
    priceList
      ? await getBestPriceListRule({
          db,
          priceListId: priceList.id,
          productId,
          collectionId:
            product.collection_id || null,
        })
      : null;

  const priceListPrice =
    calculatePriceListPrice({
      basePrice,
      rule,
    });

  let finalPrice = basePrice;
  let pricingSource = "BASE";

  if (
    promotionPrice !== null &&
    promotionPrice < finalPrice
  ) {
    finalPrice = promotionPrice;
    pricingSource =
      publicPricing.promotion_type ===
      "QUANTITY_TIER"
        ? "QUANTITY_PROMOTION"
        : "PROMOTION";
  }

  if (
    priceListPrice !== null &&
    priceListPrice <= finalPrice
  ) {
    finalPrice = priceListPrice;
    pricingSource = "PRICE_LIST";
  }

  finalPrice =
    roundMoney(finalPrice);

  const discountAmount =
    roundMoney(
      basePrice - finalPrice
    );

  const effectiveDiscountPercentage =
    basePrice > 0
      ? roundMoney(
          (discountAmount / basePrice) * 100
        )
      : 0;

  return {
    product_id: productId,
    sku: product.sku || null,

    base_price: basePrice,

    public_price:
      publicFinalPrice !== null &&
      publicFinalPrice > 0
        ? publicFinalPrice
        : basePrice,

    promotion_price:
      promotionPrice,

    promotion: hasPromotion
      ? {
          id:
            publicPricing.promotion_id ||
            null,
          name:
            publicPricing.promotion_name ||
            null,
          type:
            publicPricing.promotion_type ||
            null,
          tier:
            publicPricing.tier ||
            null,
        }
      : null,

    quantity:
      Number(quantity),

    price_list: priceList
      ? {
          id: priceList.id,
          name: priceList.name,
          description:
            priceList.description || null,
          valid_from:
            priceList.valid_from || null,
          valid_until:
            priceList.valid_until || null,
        }
      : null,

    rule: rule
      ? {
          id: rule.id,
          scope_type:
            rule.scope_type,
          discount_type:
            rule.discount_type,
          discount_value:
            roundMoney(
              rule.discount_value
            ),
          product_id:
            rule.product_id || null,
          collection_id:
            rule.collection_id || null,
        }
      : null,

    price_list_price:
      priceListPrice,

    final_price:
      finalPrice,

    discount_amount:
      discountAmount,

    effective_discount_percentage:
      effectiveDiscountPercentage,

    pricing_source:
      pricingSource,
  };
};

export const resolveCustomerProductPriceBySku =
  async ({
    userId,
    sku,
    quantity = 1,
  }) => {
    const normalizedSku =
      String(sku || "").trim();

    if (!normalizedSku) {
      throw createServiceError(
        "SKU obligatorio",
        400,
        "CUSTOMER_PRICING_SKU_REQUIRED"
      );
    }

    const productResult =
      await pool.query(
        `
          SELECT
            v.id AS product_id,
            v.sku,
            v.collection_id,
            v.base_price,
            v.promotional_price,
            v.final_price,
            v.has_promotion
          FROM vw_product_catalog v
          WHERE LOWER(v.sku) = LOWER($1)
          LIMIT 1
        `,
        [normalizedSku]
      );

    if (
      productResult.rowCount === 0
    ) {
      throw createServiceError(
        `Producto ${normalizedSku} no encontrado`,
        404,
        "CUSTOMER_PRICING_PRODUCT_NOT_FOUND"
      );
    }

    return resolveCustomerProductPrice({
      userId,
      quantity,
      product:
        productResult.rows[0],
    });
  };
