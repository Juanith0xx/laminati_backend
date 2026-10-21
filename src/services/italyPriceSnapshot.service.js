const GERENCIA_TARGET_BRAND =
  "ABET LAMINATI";

const roundUsd = (
  value
) => {
  const number =
    Number(value);

  if (
    !Number.isFinite(
      number
    )
  ) {
    return null;
  }

  return (
    Math.round(
      (
        number +
        Number.EPSILON
      ) *
        10000
    ) /
    10000
  );
};

export const captureOrderItemItalyPriceSnapshot =
  async ({
    client,
    orderId,
    orderItemId,
    productId,
    quantity,
  }) => {
    if (
      !client ||
      !orderId ||
      !orderItemId ||
      !productId
    ) {
      return {
        captured:
          false,
        reason:
          "MISSING_REQUIRED_DATA",
      };
    }

    const normalizedQuantity =
      Number(
        quantity
      );

    if (
      !Number.isFinite(
        normalizedQuantity
      ) ||
      normalizedQuantity <=
        0
    ) {
      return {
        captured:
          false,
        reason:
          "INVALID_QUANTITY",
      };
    }

    const productResult =
      await client.query(
        `
          SELECT
            v.id,
            v.brand,
            italy_price.id
              AS italy_price_id,
            italy_price.price_usd
              AS price_usd

          FROM vw_product_catalog v

          LEFT JOIN LATERAL (
            SELECT
              pip.id,
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
          productId,
        ]
      );

    if (
      productResult.rowCount ===
      0
    ) {
      return {
        captured:
          false,
        reason:
          "PRODUCT_NOT_FOUND",
      };
    }

    const product =
      productResult.rows[0];

    const brand =
      String(
        product.brand ||
          ""
      )
        .trim()
        .toUpperCase();

    if (
      brand !==
      GERENCIA_TARGET_BRAND
    ) {
      return {
        captured:
          false,
        reason:
          "OUTSIDE_BRAND_SCOPE",
      };
    }

    if (
      product.price_usd ===
        null ||
      product.price_usd ===
        undefined
    ) {
      return {
        captured:
          false,
        reason:
          "ITALY_PRICE_NOT_CONFIGURED",
      };
    }

    const priceUsd =
      roundUsd(
        product.price_usd
      );

    const totalUsd =
      roundUsd(
        priceUsd *
          normalizedQuantity
      );

    const result =
      await client.query(
        `
          INSERT INTO order_item_italy_price_snapshots (
            order_id,
            order_item_id,
            product_id,
            source_italy_price_id,
            price_usd,
            quantity,
            total_usd,
            currency
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            'USD'
          )
          ON CONFLICT (
            order_item_id
          )
          DO NOTHING
          RETURNING
            id,
            order_id,
            order_item_id,
            product_id,
            source_italy_price_id,
            price_usd,
            quantity,
            total_usd,
            currency,
            captured_at
        `,
        [
          orderId,
          orderItemId,
          productId,
          product.italy_price_id ||
            null,
          priceUsd,
          normalizedQuantity,
          totalUsd,
        ]
      );

    if (
      result.rowCount ===
      0
    ) {
      return {
        captured:
          false,
        reason:
          "ALREADY_CAPTURED",
      };
    }

    return {
      captured:
        true,
      snapshot:
        result.rows[0],
    };
  };
