import pool from "../config/database.js";

/* =========================================
   HELPERS
========================================= */
const roundMoney = (value) =>
  Math.round(
    (
      Number(value) +
      Number.EPSILON
    ) *
      100
  ) / 100;

const normalizeQuantity = (
  value
) => {
  const quantity =
    Number(value);

  if (
    !Number.isFinite(
      quantity
    ) ||
    quantity <= 0
  ) {
    const error =
      new Error(
        "La cantidad debe ser mayor que 0"
      );

    error.status =
      400;

    error.code =
      "PRICING_INVALID_QUANTITY";

    throw error;
  }

  return quantity;
};

const normalizePromotionType = (
  value
) =>
  String(
    value || ""
  )
    .trim()
    .toUpperCase();

const parseTiers = (
  value
) => {
  if (
    Array.isArray(value)
  ) {
    return value;
  }

  if (
    typeof value ===
      "string" &&
    value.trim()
  ) {
    try {
      const parsed =
        JSON.parse(value);

      return Array.isArray(
        parsed
      )
        ? parsed
        : [];
    } catch {
      return [];
    }
  }

  return [];
};

const normalizeTiers = (
  value
) =>
  parseTiers(value)
    .map(
      (
        tier
      ) => ({
        id:
          tier.id || null,

        min_quantity:
          Number(
            tier.min_quantity
          ),

        unit_price:
          Number(
            tier.unit_price
          ),
      })
    )
    .filter(
      (
        tier
      ) =>
        Number.isFinite(
          tier.min_quantity
        ) &&
        tier.min_quantity >
          0 &&
        Number.isFinite(
          tier.unit_price
        ) &&
        tier.unit_price >=
          0
    )
    .sort(
      (
        left,
        right
      ) =>
        left.min_quantity -
        right.min_quantity
    );

const findMatchedTier = ({
  tiers,
  quantity,
}) => {
  let matchedTier =
    null;

  for (
    const tier of
    tiers
  ) {
    if (
      quantity >=
      tier.min_quantity
    ) {
      matchedTier =
        tier;
    } else {
      break;
    }
  }

  return matchedTier;
};

/* =========================================
   RESOLVER PRECIO DE PRODUCTO
========================================= */
export const resolveProductPrice = async ({
  productId,
  quantity,
  db = pool,
}) => {
  const normalizedQuantity =
    normalizeQuantity(
      quantity
    );

  /*
   * El producto se obtiene directamente desde products.
   * No dependemos de la promoción única expuesta por
   * vw_product_catalog, porque ahora un producto puede
   * tener múltiples promociones simultáneas.
   */
  const productResult =
    await db.query(
      `
        SELECT
          id,
          sku,
          name,
          base_price
        FROM products
        WHERE id = $1
        LIMIT 1
      `,
      [
        productId,
      ]
    );

  if (
    productResult.rowCount ===
    0
  ) {
    const error =
      new Error(
        "Producto no encontrado"
      );

    error.status =
      404;

    error.code =
      "PRICING_PRODUCT_NOT_FOUND";

    throw error;
  }

  const product =
    productResult.rows[0];

  const basePrice =
    roundMoney(
      product.base_price
    );

  if (
    !Number.isFinite(
      basePrice
    )
  ) {
    const error =
      new Error(
        "El producto no tiene un precio base válido"
      );

    error.status =
      409;

    error.code =
      "PRICING_BASE_PRICE_INVALID";

    throw error;
  }

  /*
   * Recuperamos TODAS las promociones activas y vigentes
   * del producto. Para QUANTITY_TIER se agregan todos sus
   * tramos en orden ascendente.
   */
  const promotionsResult =
    await db.query(
      `
        SELECT
          pr.id,
          pr.name,
          pr.promotion_type,
          pr.promotional_price,
          pr.starts_at,
          pr.ends_at,
          pr.created_at,

          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'id',
                tier.id,
                'min_quantity',
                tier.min_quantity,
                'unit_price',
                tier.unit_price
              )
              ORDER BY
                tier.min_quantity ASC
            )
            FILTER (
              WHERE tier.id IS NOT NULL
            ),
            '[]'::jsonb
          ) AS tiers

        FROM promotions pr

        LEFT JOIN promotion_price_tiers tier
          ON tier.promotion_id =
            pr.id

        WHERE pr.product_id = $1
          AND pr.is_active = TRUE

          AND (
            pr.starts_at IS NULL
            OR pr.starts_at <= NOW()
          )

          AND (
            pr.ends_at IS NULL
            OR pr.ends_at > NOW()
          )

        GROUP BY
          pr.id,
          pr.name,
          pr.promotion_type,
          pr.promotional_price,
          pr.starts_at,
          pr.ends_at,
          pr.created_at

        ORDER BY
          pr.created_at DESC,
          pr.id DESC
      `,
      [
        productId,
      ]
    );

  /*
   * BASE siempre participa como candidato.
   *
   * Si varias promociones entregan el mismo precio,
   * gana la primera del ORDER BY anterior (la creada
   * más recientemente). El precio final no cambia;
   * esto solo hace determinista la metadata devuelta.
   */
  let bestCandidate = {
    unit_price:
      basePrice,

    promotion_id:
      null,

    promotion_name:
      null,

    promotion_type:
      null,

    tier:
      null,
  };

  for (
    const promotion of
    promotionsResult.rows
  ) {
    const promotionType =
      normalizePromotionType(
        promotion.promotion_type
      );

    if (
      promotionType ===
      "FIXED_PRICE"
    ) {
      const promotionalPrice =
        roundMoney(
          promotion.promotional_price
        );

      if (
        Number.isFinite(
          promotionalPrice
        ) &&
        promotionalPrice >=
          0 &&
        promotionalPrice <
          bestCandidate.unit_price
      ) {
        bestCandidate = {
          unit_price:
            promotionalPrice,

          promotion_id:
            promotion.id,

          promotion_name:
            promotion.name,

          promotion_type:
            "FIXED_PRICE",

          tier:
            null,
        };
      }

      continue;
    }

    if (
      promotionType !==
      "QUANTITY_TIER"
    ) {
      continue;
    }

    const tiers =
      normalizeTiers(
        promotion.tiers
      );

    const matchedTier =
      findMatchedTier({
        tiers,
        quantity:
          normalizedQuantity,
      });

    if (
      !matchedTier
    ) {
      continue;
    }

    const tierPrice =
      roundMoney(
        matchedTier.unit_price
      );

    if (
      Number.isFinite(
        tierPrice
      ) &&
      tierPrice >=
        0 &&
      tierPrice <
        bestCandidate.unit_price
    ) {
      bestCandidate = {
        unit_price:
          tierPrice,

        promotion_id:
          promotion.id,

        promotion_name:
          promotion.name,

        promotion_type:
          "QUANTITY_TIER",

        tier: {
          id:
            matchedTier.id,

          min_quantity:
            matchedTier.min_quantity,

          unit_price:
            tierPrice,
        },
      };
    }
  }

  const promotionApplied =
    Boolean(
      bestCandidate.promotion_id
    );

  return {
    product_id:
      product.id,

    sku:
      product.sku,

    quantity:
      normalizedQuantity,

    base_price:
      basePrice,

    unit_price:
      bestCandidate.unit_price,

    line_total:
      roundMoney(
        bestCandidate.unit_price *
          normalizedQuantity
      ),

    promotion_applied:
      promotionApplied,

    promotion_id:
      bestCandidate.promotion_id,

    promotion_name:
      bestCandidate.promotion_name,

    promotion_type:
      bestCandidate.promotion_type,

    tier:
      bestCandidate.tier,
  };
};

export default {
  resolveProductPrice,
};
