import pool from "../config/database.js";

const PRICE_STATUS = new Set([
  "ALL",
  "WITH_PRICE",
  "WITHOUT_PRICE",
]);

const STOCK_STATUS = new Set([
  "ALL",
  "WITH_STOCK",
  "WITHOUT_STOCK",
]);

const GERENCIA_TARGET_BRAND =
  "ABET LAMINATI";

const normalizeText = (value) =>
  String(value || "")
    .trim();

const normalizeEnum = (
  value,
  allowed,
  fallback = "ALL"
) => {
  const normalized =
    normalizeText(value)
      .toUpperCase();

  return allowed.has(
    normalized
  )
    ? normalized
    : fallback;
};

const toNumber = (
  value,
  fallback = 0
) => {
  const parsed =
    Number(value);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
};

const toNullableNumber = (
  value
) => {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed =
    Number(value);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : null;
};

const buildStockBaseCte = () => `
  WITH stock_base AS (
    SELECT
      v.id,
      v.sku,
      v.name,
      v.brand,
      v.brand_slug,
      v.collection,
      v.collection_slug,
      v.finish,
      v.texture,
      v.color,
      v.thickness_mm,
      COALESCE(
        v.stock_quantity,
        0
      ) AS stock_quantity,
      italy_price.price_usd
        AS italy_price_usd

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

    WHERE v.is_active = TRUE
      AND UPPER(
        BTRIM(
          COALESCE(
            v.brand,
            ''
          )
        )
      ) = '${GERENCIA_TARGET_BRAND}'
  )
`;





const DEFAULT_PROJECT_QUOTES_PAGE =
  1;

const DEFAULT_PROJECT_QUOTES_LIMIT =
  20;

const MAX_PROJECT_QUOTES_LIMIT =
  100;

const PROJECT_QUOTE_STATUSES =
  new Set([
    "DRAFT",
    "SENT",
    "REVIEW",
    "NEGOTIATION",
    "APPROVED",
    "WON",
    "LOST",
  ]);

const buildProjectQuotationBaseCte = () => `
  WITH italy_price_rollout AS (
    SELECT
      MIN(valid_from)
        AS started_at
    FROM product_italy_prices
  ),

  project_quote_base AS (
    SELECT
      q.id
        AS quotation_id,
      q.quote_number,
      q.project_name,
      q.project_reference,

      q.status
        AS quotation_status,

      COALESCE(
        qpm.stage,
        CASE UPPER(
          BTRIM(
            COALESCE(
              q.status,
              'DRAFT'
            )
          )
        )
          WHEN 'DRAFT' THEN 'DRAFT'
          WHEN 'SENT' THEN 'SENT'
          WHEN 'ACCEPTED' THEN 'APPROVED'
          WHEN 'CONVERTED' THEN 'WON'
          WHEN 'REJECTED' THEN 'LOST'
          WHEN 'EXPIRED' THEN 'LOST'
          WHEN 'CANCELLED' THEN 'LOST'
          ELSE 'DRAFT'
        END
      )
        AS status,

      qpm.stage
        AS board_stage,

      q.created_at,
      q.valid_until,

      qpl.id
        AS project_line_id,
      qpl.product_id,
      qpl.description,
      qpl.code,
      qpl.brand
        AS line_brand,
      qpl.collection
        AS line_collection,
      qpl.italy_price_usd
        AS line_italy_price_usd,
      qpl.italy_price_source
        AS line_italy_price_source,
      qpl.finish
        AS line_finish,
      qpl.thickness_mm,
      qpl.quantity,
      qpl.unit,
      qpl.format_label,
      qpl.width_cm,
      qpl.height_cm,
      qpl.sort_order,

      COALESCE(
        v.sku,
        qpl.code
      ) AS sku,

      COALESCE(
        v.name,
        qpl.description
      ) AS product_name,

      COALESCE(
        NULLIF(
          BTRIM(
            qpl.collection
          ),
          ''
        ),
        v.collection
      ) AS collection,

      COALESCE(
        NULLIF(
          BTRIM(
            qpl.collection
          ),
          ''
        ),
        v.collection_slug
      ) AS collection_slug,

      COALESCE(
        qpl.finish,
        v.finish
      ) AS product_finish,

      COALESCE(
        qpl.italy_price_usd,
        snapshot.price_usd,
        historical_price.price_usd,
        CASE
          WHEN
            rollout.started_at IS NOT NULL
            AND q.created_at < rollout.started_at
          THEN
            current_price.price_usd
          ELSE
            NULL
        END
      ) AS italy_unit_price_usd,

      CASE
        WHEN qpl.italy_price_usd IS NOT NULL
          THEN COALESCE(
            qpl.italy_price_source,
            CASE
              WHEN qpl.product_id IS NULL
                THEN 'MANUAL'
              ELSE 'LINE_SNAPSHOT'
            END
          )

        WHEN snapshot.price_usd IS NOT NULL
          THEN 'SNAPSHOT'

        WHEN historical_price.price_usd IS NOT NULL
          THEN 'HISTORICAL_PRICE'

        WHEN
          rollout.started_at IS NOT NULL
          AND q.created_at < rollout.started_at
          AND current_price.price_usd IS NOT NULL
          THEN 'CURRENT_PRICE_FALLBACK'

        ELSE
          'MISSING'
      END AS valuation_source

    FROM quotations q

    LEFT JOIN quotation_project_management qpm
      ON qpm.quotation_id = q.id

    INNER JOIN quotation_project_lines qpl
      ON qpl.quotation_id = q.id
      AND qpl.line_type = 'PRODUCT'

    LEFT JOIN vw_product_catalog v
      ON v.id = qpl.product_id

    CROSS JOIN italy_price_rollout rollout

    LEFT JOIN quotation_project_line_italy_price_snapshots snapshot
      ON snapshot.project_line_id = qpl.id

    LEFT JOIN LATERAL (
      SELECT
        pip.price_usd
      FROM product_italy_prices pip
      WHERE pip.product_id = qpl.product_id
        AND pip.valid_from <= q.created_at
        AND (
          pip.valid_until IS NULL
          OR pip.valid_until > q.created_at
        )
      ORDER BY
        pip.valid_from DESC
      LIMIT 1
    ) historical_price
      ON TRUE

    LEFT JOIN LATERAL (
      SELECT
        pip.price_usd
      FROM product_italy_prices pip
      WHERE pip.product_id = qpl.product_id
        AND pip.valid_until IS NULL
      ORDER BY
        pip.valid_from DESC
      LIMIT 1
    ) current_price
      ON TRUE

    WHERE UPPER(
      BTRIM(
        COALESCE(
          q.quotation_type,
          ''
        )
      )
    ) = 'PROJECT'

      AND q.visible_to_italy = TRUE

      AND REGEXP_REPLACE(
        UPPER(
          BTRIM(
            COALESCE(
              NULLIF(
                qpl.brand,
                ''
              ),
              v.brand,
              ''
            )
          )
        ),
        '\\s+',
        ' ',
        'g'
      ) IN (
        '${GERENCIA_TARGET_BRAND}',
        'ABET'
      )
  ),

  /*
   * Fletes de cotizaciones de proyecto visibles para Italia.
   *
   * El monto Chile (unit_price_gross / line_total_gross) permanece
   * en CLP y NO se mezcla con los valores Italia. Para Gerencia sólo
   * se utiliza italy_price_usd, que actúa como snapshot manual USD
   * del flete acordado para esa cotización.
   */
  project_quote_freight AS (
    SELECT
      q.id
        AS quotation_id,
      qpl.id
        AS project_line_id,
      qpl.description,
      qpl.code,
      qpl.quantity,
      qpl.unit,
      qpl.italy_price_usd
        AS italy_unit_price_usd,
      qpl.italy_price_source
        AS valuation_source,
      qpl.sort_order,

      CASE
        WHEN UPPER(COALESCE(qpl.description, '')) LIKE '%AÉREO%'
          OR UPPER(COALESCE(qpl.description, '')) LIKE '%AEREO%'
          THEN 'AIR'
        WHEN UPPER(COALESCE(qpl.description, '')) LIKE '%MARÍTIMO%'
          OR UPPER(COALESCE(qpl.description, '')) LIKE '%MARITIMO%'
          THEN 'SEA'
        ELSE 'FREIGHT'
      END AS freight_type

    FROM quotations q

    INNER JOIN quotation_project_lines qpl
      ON qpl.quotation_id = q.id
      AND qpl.line_type IN ('SERVICE', 'OTHER')

    WHERE UPPER(
      BTRIM(
        COALESCE(
          q.quotation_type,
          ''
        )
      )
    ) = 'PROJECT'

      AND q.visible_to_italy = TRUE

      AND UPPER(
        BTRIM(
          COALESCE(
            qpl.description,
            ''
          )
        )
      ) LIKE '%FLETE%'
  )
`;

const buildProjectQuotationFilters =
  ({
    search,
    collection,
    status,
    fromDate,
    toDate,
  }) => {
    const values =
      [];

    const filters =
      [];

    if (
      search
    ) {
      values.push(
        `%${search}%`
      );

      const index =
        values.length;

      filters.push(`
        (
          quote_number ILIKE $${index}
          OR project_name ILIKE $${index}
          OR project_reference ILIKE $${index}
          OR sku ILIKE $${index}
          OR product_name ILIKE $${index}
          OR description ILIKE $${index}
          OR code ILIKE $${index}
        )
      `);
    }

    if (
      collection
    ) {
      values.push(
        collection
      );

      const index =
        values.length;

      filters.push(`
        (
          collection_slug = $${index}
          OR collection = $${index}
        )
      `);
    }

    if (
      status
    ) {
      values.push(
        status
      );

      filters.push(`
        status = $${values.length}
      `);
    }

    if (
      fromDate
    ) {
      values.push(
        fromDate
      );

      filters.push(`
        (
          created_at AT TIME ZONE 'America/Santiago'
        )::date >= $${values.length}::date
      `);
    }

    if (
      toDate
    ) {
      values.push(
        toDate
      );

      filters.push(`
        (
          created_at AT TIME ZONE 'America/Santiago'
        )::date <= $${values.length}::date
      `);
    }

    return {
      values,
      whereClause:
        filters.length >
        0
          ? `WHERE ${filters.join(
              " AND "
            )}`
          : "",
    };
  };

const DEFAULT_SALES_PAGE =
  1;

const DEFAULT_SALES_LIMIT =
  20;

const MAX_SALES_LIMIT =
  100;

const normalizeDate = (
  value
) => {
  const normalized =
    normalizeText(
      value
    );

  if (
    !normalized
  ) {
    return null;
  }

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(
      normalized
    )
  ) {
    return null;
  }

  return normalized;
};

const normalizeUuid = (
  value
) => {
  const normalized =
    normalizeText(
      value
    );

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalized
  )
    ? normalized
    : null;
};

const buildSalesBaseCte = () => `
  WITH italy_price_rollout AS (
    SELECT
      MIN(valid_from)
        AS started_at
    FROM product_italy_prices
  ),

  sales_base AS (
    SELECT
      o.id
        AS order_id,
      o.order_number,
      o.created_at,
      o.source,

      oi.id
        AS order_item_id,
      oi.product_id,
      oi.sku,
      oi.product_name,
      oi.quantity,

      v.collection,
      v.collection_slug,
      v.finish,

      COALESCE(
        snapshot.price_usd,
        historical_price.price_usd,
        CASE
          WHEN
            rollout.started_at IS NOT NULL
            AND o.created_at < rollout.started_at
          THEN
            current_price.price_usd
          ELSE
            NULL
        END
      ) AS italy_unit_price_usd,

      CASE
        WHEN snapshot.price_usd IS NOT NULL
          THEN 'SNAPSHOT'

        WHEN historical_price.price_usd IS NOT NULL
          THEN 'HISTORICAL_PRICE'

        WHEN
          rollout.started_at IS NOT NULL
          AND o.created_at < rollout.started_at
          AND current_price.price_usd IS NOT NULL
          THEN 'CURRENT_PRICE_FALLBACK'

        ELSE
          'MISSING'
      END AS valuation_source

    FROM orders o

    INNER JOIN order_items oi
      ON oi.order_id = o.id

    INNER JOIN vw_product_catalog v
      ON v.id = oi.product_id

    CROSS JOIN italy_price_rollout rollout

    LEFT JOIN order_item_italy_price_snapshots snapshot
      ON snapshot.order_item_id = oi.id

    LEFT JOIN LATERAL (
      SELECT
        pip.price_usd
      FROM product_italy_prices pip
      WHERE pip.product_id = oi.product_id
        AND pip.valid_from <= o.created_at
        AND (
          pip.valid_until IS NULL
          OR pip.valid_until > o.created_at
        )
      ORDER BY
        pip.valid_from DESC
      LIMIT 1
    ) historical_price
      ON TRUE

    LEFT JOIN LATERAL (
      SELECT
        pip.price_usd
      FROM product_italy_prices pip
      WHERE pip.product_id = oi.product_id
        AND pip.valid_until IS NULL
      ORDER BY
        pip.valid_from DESC
      LIMIT 1
    ) current_price
      ON TRUE

    WHERE o.status = 'COMPLETED'
      AND o.payment_status = 'PAID'
      AND UPPER(
        BTRIM(
          COALESCE(
            v.brand,
            ''
          )
        )
      ) = '${GERENCIA_TARGET_BRAND}'
  )
`;

const buildSalesFilters = ({
  search,
  collection,
  fromDate,
  toDate,
}) => {
  const values =
    [];

  const filters =
    [];

  if (
    search
  ) {
    values.push(
      `%${search}%`
    );

    const index =
      values.length;

    filters.push(`
      (
        order_number ILIKE $${index}
        OR sku ILIKE $${index}
        OR product_name ILIKE $${index}
      )
    `);
  }

  if (
    collection
  ) {
    values.push(
      collection
    );

    const index =
      values.length;

    filters.push(`
      (
        collection_slug = $${index}
        OR collection = $${index}
      )
    `);
  }

  if (
    fromDate
  ) {
    values.push(
      fromDate
    );

    filters.push(`
      (
        created_at AT TIME ZONE 'America/Santiago'
      )::date >= $${values.length}::date
    `);
  }

  if (
    toDate
  ) {
    values.push(
      toDate
    );

    filters.push(`
      (
        created_at AT TIME ZONE 'America/Santiago'
      )::date <= $${values.length}::date
    `);
  }

  return {
    values,
    whereClause:
      filters.length > 0
        ? `WHERE ${filters.join(
            " AND "
          )}`
        : "",
  };
};

/* =========================================
   RESUMEN GERENCIA ITALIA

   Consolida únicamente métricas autorizadas:
   - Stock ABET LAMINATI valorizado en USD
   - Ventas ABET LAMINATI valorizadas en USD
   - PROJECT visibles a Italia, sólo PRODUCT ABET

   No selecciona ni devuelve CLP, IVA, descuentos,
   márgenes, clientes, RUT ni medios de pago.
========================================= */
export const getGerenciaSummary = async (
  req,
  res
) => {
  try {
    const [
      stockResult,
      salesResult,
      projectQuotesResult,
      stockByCollectionResult,
      salesMonthlyResult,
      projectRankingResult,
    ] = await Promise.all([
      pool.query(
        `
          ${buildStockBaseCte()}

          SELECT
            COUNT(*)::int AS total_products,
            COUNT(*) FILTER (
              WHERE stock_quantity > 0
            )::int AS products_with_stock,
            COUNT(*) FILTER (
              WHERE italy_price_usd IS NOT NULL
            )::int AS products_with_italy_price,
            COUNT(*) FILTER (
              WHERE italy_price_usd IS NULL
            )::int AS products_without_italy_price,
            COALESCE(
              SUM(stock_quantity),
              0
            ) AS total_stock_units,
            COALESCE(
              SUM(
                stock_quantity * italy_price_usd
              ) FILTER (
                WHERE italy_price_usd IS NOT NULL
              ),
              0
            ) AS total_stock_value_usd,
            COALESCE(
              SUM(stock_quantity) FILTER (
                WHERE italy_price_usd IS NULL
              ),
              0
            ) AS unpriced_stock_units
          FROM stock_base
        `
      ),

      pool.query(
        `
          ${buildSalesBaseCte()}

          SELECT
            COUNT(DISTINCT order_id)::int AS total_orders,
            COALESCE(SUM(quantity), 0) AS total_units,
            COALESCE(
              SUM(
                quantity * italy_unit_price_usd
              ) FILTER (
                WHERE italy_unit_price_usd IS NOT NULL
              ),
              0
            ) AS total_value_usd,
            COALESCE(
              SUM(quantity) FILTER (
                WHERE italy_unit_price_usd IS NULL
              ),
              0
            ) AS unpriced_units,
            COUNT(DISTINCT order_id) FILTER (
              WHERE italy_unit_price_usd IS NULL
            )::int AS orders_with_unpriced_items
          FROM sales_base
        `
      ),

      pool.query(
        `
          ${buildProjectQuotationBaseCte()}

          SELECT
            COUNT(DISTINCT quotation_id)::int AS total_projects,
            COALESCE(SUM(quantity), 0) AS total_units,
            COALESCE(
              SUM(
                quantity * italy_unit_price_usd
              ) FILTER (
                WHERE italy_unit_price_usd IS NOT NULL
              ),
              0
            ) AS total_value_usd,
            COALESCE(
              SUM(quantity) FILTER (
                WHERE italy_unit_price_usd IS NULL
              ),
              0
            ) AS unpriced_units,
            COUNT(DISTINCT quotation_id) FILTER (
              WHERE italy_unit_price_usd IS NULL
            )::int AS projects_with_unpriced_items
          FROM project_quote_base
        `
      ),

      pool.query(
        `
          ${buildStockBaseCte()}

          SELECT
            COALESCE(
              NULLIF(BTRIM(collection), ''),
              'Sin colección'
            ) AS collection,
            COALESCE(
              NULLIF(BTRIM(collection_slug), ''),
              'sin-coleccion'
            ) AS collection_slug,
            COALESCE(
              SUM(stock_quantity),
              0
            ) AS total_units,
            COALESCE(
              SUM(
                stock_quantity * italy_price_usd
              ) FILTER (
                WHERE italy_price_usd IS NOT NULL
              ),
              0
            ) AS total_value_usd
          FROM stock_base
          WHERE stock_quantity > 0
          GROUP BY
            COALESCE(
              NULLIF(BTRIM(collection), ''),
              'Sin colección'
            ),
            COALESCE(
              NULLIF(BTRIM(collection_slug), ''),
              'sin-coleccion'
            )
          ORDER BY
            total_units DESC,
            collection ASC
          LIMIT 6
        `
      ),

      pool.query(
        `
          ${buildSalesBaseCte()},

          months AS (
            SELECT
              generate_series(
                date_trunc(
                  'month',
                  NOW() AT TIME ZONE 'America/Santiago'
                ) - INTERVAL '5 months',
                date_trunc(
                  'month',
                  NOW() AT TIME ZONE 'America/Santiago'
                ),
                INTERVAL '1 month'
              )::date AS month_start
          ),

          monthly_sales AS (
            SELECT
              date_trunc(
                'month',
                created_at AT TIME ZONE 'America/Santiago'
              )::date AS month_start,
              COALESCE(
                SUM(quantity),
                0
              ) AS total_units,
              COALESCE(
                SUM(
                  quantity * italy_unit_price_usd
                ) FILTER (
                  WHERE italy_unit_price_usd IS NOT NULL
                ),
                0
              ) AS total_value_usd
            FROM sales_base
            WHERE
              created_at >= (
                date_trunc(
                  'month',
                  NOW() AT TIME ZONE 'America/Santiago'
                ) - INTERVAL '5 months'
              ) AT TIME ZONE 'America/Santiago'
            GROUP BY 1
          )

          SELECT
            TO_CHAR(
              months.month_start,
              'YYYY-MM-DD'
            ) AS month,
            COALESCE(
              monthly_sales.total_units,
              0
            ) AS total_units,
            COALESCE(
              monthly_sales.total_value_usd,
              0
            ) AS total_value_usd
          FROM months
          LEFT JOIN monthly_sales
            ON monthly_sales.month_start = months.month_start
          ORDER BY months.month_start ASC
        `
      ),

      pool.query(
        `
          ${buildProjectQuotationBaseCte()}

          SELECT
            quotation_id,
            quote_number,
            COALESCE(
              NULLIF(BTRIM(project_name), ''),
              quote_number
            ) AS project_name,
            COALESCE(
              SUM(quantity),
              0
            ) AS total_units,
            COALESCE(
              SUM(
                quantity * italy_unit_price_usd
              ) FILTER (
                WHERE italy_unit_price_usd IS NOT NULL
              ),
              0
            ) AS total_value_usd
          FROM project_quote_base
          GROUP BY
            quotation_id,
            quote_number,
            project_name
          ORDER BY
            total_value_usd DESC,
            project_name ASC
          LIMIT 5
        `
      ),
    ]);

    const stockRow = stockResult.rows[0] || {};
    const salesRow = salesResult.rows[0] || {};
    const projectQuotesRow = projectQuotesResult.rows[0] || {};

    return res.status(200).json({
      success: true,
      currency: "USD",
      brand_scope: GERENCIA_TARGET_BRAND,

      stock: {
        total_products: toNumber(stockRow.total_products),
        products_with_stock: toNumber(stockRow.products_with_stock),
        products_with_italy_price: toNumber(stockRow.products_with_italy_price),
        products_without_italy_price: toNumber(stockRow.products_without_italy_price),
        total_units: toNumber(stockRow.total_stock_units),
        total_value_usd: toNumber(stockRow.total_stock_value_usd),
        unpriced_units: toNumber(stockRow.unpriced_stock_units),
      },

      sales: {
        total_orders: toNumber(salesRow.total_orders),
        total_units: toNumber(salesRow.total_units),
        total_value_usd: toNumber(salesRow.total_value_usd),
        unpriced_units: toNumber(salesRow.unpriced_units),
        orders_with_unpriced_items: toNumber(salesRow.orders_with_unpriced_items),
      },

      project_quotations: {
        total_projects: toNumber(projectQuotesRow.total_projects),
        total_units: toNumber(projectQuotesRow.total_units),
        total_value_usd: toNumber(projectQuotesRow.total_value_usd),
        unpriced_units: toNumber(projectQuotesRow.unpriced_units),
        projects_with_unpriced_items: toNumber(projectQuotesRow.projects_with_unpriced_items),
      },

      charts: {
        stock_by_collection: stockByCollectionResult.rows.map((row) => ({
          collection: row.collection,
          collection_slug: row.collection_slug,
          total_units: toNumber(row.total_units),
          total_value_usd: toNumber(row.total_value_usd),
        })),

        sales_monthly: salesMonthlyResult.rows.map((row) => ({
          month: row.month,
          total_units: toNumber(row.total_units),
          total_value_usd: toNumber(row.total_value_usd),
        })),

        project_ranking: projectRankingResult.rows.map((row) => ({
          quotation_id: row.quotation_id,
          quote_number: row.quote_number,
          project_name: row.project_name,
          total_units: toNumber(row.total_units),
          total_value_usd: toNumber(row.total_value_usd),
        })),
      },

      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "Error obteniendo Resumen Gerencia Italia:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "No fue posible obtener el resumen de Gerencia Italia",
    });
  }
};

/* =========================================
   STOCK DISTRIBUCIÓN CHILE

   Sólo GERENCIA_ITALIA puede llegar a este
   controlador por gerencia.routes.js.

   IMPORTANTE:
   No se seleccionan ni se devuelven precios
   comerciales de Chile, promociones, IVA,
   descuentos ni información de clientes.
========================================= */
export const getGerenciaStock = async (
  req,
  res
) => {
  const search =
    normalizeText(
      req.query.search
    );

  const collection =
    normalizeText(
      req.query.collection
    );

  const priceStatus =
    normalizeEnum(
      req.query.price_status,
      PRICE_STATUS
    );

  const stockStatus =
    normalizeEnum(
      req.query.stock_status,
      STOCK_STATUS
    );

  try {
    const summaryResult =
      await pool.query(
        `
          ${buildStockBaseCte()}

          SELECT
            COUNT(*)::int
              AS total_products,

            COUNT(*) FILTER (
              WHERE stock_quantity > 0
            )::int
              AS products_with_stock,

            COUNT(*) FILTER (
              WHERE italy_price_usd IS NOT NULL
            )::int
              AS products_with_italy_price,

            COUNT(*) FILTER (
              WHERE italy_price_usd IS NULL
            )::int
              AS products_without_italy_price,

            COALESCE(
              SUM(stock_quantity),
              0
            ) AS total_stock_units,

            COALESCE(
              SUM(stock_quantity)
                FILTER (
                  WHERE italy_price_usd IS NOT NULL
                ),
              0
            ) AS priced_stock_units,

            COALESCE(
              SUM(stock_quantity)
                FILTER (
                  WHERE italy_price_usd IS NULL
                ),
              0
            ) AS unpriced_stock_units,

            COALESCE(
              SUM(
                stock_quantity *
                italy_price_usd
              ) FILTER (
                WHERE italy_price_usd IS NOT NULL
              ),
              0
            ) AS total_stock_value_usd

          FROM stock_base
        `
      );

    const collectionsResult =
      await pool.query(
        `
          ${buildStockBaseCte()},

          collection_options AS (
            SELECT
              collection,
              collection_slug,
              COALESCE(
                NULLIF(
                  BTRIM(collection_slug),
                  ''
                ),
                BTRIM(collection)
              ) AS collection_key
            FROM stock_base
            WHERE collection IS NOT NULL
              AND BTRIM(collection) <> ''
          )

          SELECT DISTINCT ON (
            collection_key
          )
            collection,
            collection_slug,
            collection_key
          FROM collection_options
          ORDER BY
            collection_key ASC,
            collection ASC
        `
      );

    const values = [];
    const filters = [];

    if (search) {
      values.push(
        `%${search}%`
      );

      const index =
        values.length;

      filters.push(`
        (
          sku ILIKE $${index}
          OR name ILIKE $${index}
          OR COALESCE(collection, '') ILIKE $${index}
          OR COALESCE(finish, '') ILIKE $${index}
          OR COALESCE(texture, '') ILIKE $${index}
          OR COALESCE(color, '') ILIKE $${index}
        )
      `);
    }

    if (collection) {
      values.push(
        collection
      );

      const index =
        values.length;

      filters.push(`
        (
          collection_slug = $${index}
          OR collection = $${index}
        )
      `);
    }

    if (
      priceStatus ===
      "WITH_PRICE"
    ) {
      filters.push(
        "italy_price_usd IS NOT NULL"
      );
    }

    if (
      priceStatus ===
      "WITHOUT_PRICE"
    ) {
      filters.push(
        "italy_price_usd IS NULL"
      );
    }

    if (
      stockStatus ===
      "WITH_STOCK"
    ) {
      filters.push(
        "stock_quantity > 0"
      );
    }

    if (
      stockStatus ===
      "WITHOUT_STOCK"
    ) {
      filters.push(
        "stock_quantity <= 0"
      );
    }

    const whereClause =
      filters.length > 0
        ? `WHERE ${filters.join(
            " AND "
          )}`
        : "";

    const productsResult =
      await pool.query(
        `
          ${buildStockBaseCte()}

          SELECT
            id,
            sku,
            name,
            collection,
            collection_slug,
            finish,
            texture,
            color,
            thickness_mm,
            stock_quantity,
            italy_price_usd,

            CASE
              WHEN italy_price_usd IS NULL
                THEN NULL
              ELSE
                stock_quantity *
                italy_price_usd
            END AS stock_value_usd

          FROM stock_base

          ${whereClause}

          ORDER BY
            CASE
              WHEN stock_quantity > 0
                THEN 0
              ELSE 1
            END ASC,
            stock_quantity DESC,
            name ASC,
            sku ASC
        `,
        values
      );

    const summaryRow =
      summaryResult.rows[0] ||
      {};

    const summary = {
      total_products:
        toNumber(
          summaryRow.total_products
        ),

      products_with_stock:
        toNumber(
          summaryRow.products_with_stock
        ),

      products_with_italy_price:
        toNumber(
          summaryRow.products_with_italy_price
        ),

      products_without_italy_price:
        toNumber(
          summaryRow.products_without_italy_price
        ),

      total_stock_units:
        toNumber(
          summaryRow.total_stock_units
        ),

      priced_stock_units:
        toNumber(
          summaryRow.priced_stock_units
        ),

      unpriced_stock_units:
        toNumber(
          summaryRow.unpriced_stock_units
        ),

      total_stock_value_usd:
        toNumber(
          summaryRow.total_stock_value_usd
        ),
    };

    const products =
      productsResult.rows.map(
        (row) => ({
          id:
            row.id,
          sku:
            row.sku,
          name:
            row.name,
          collection:
            row.collection ||
            null,
          collection_slug:
            row.collection_slug ||
            null,
          finish:
            row.finish ||
            null,
          texture:
            row.texture ||
            null,
          color:
            row.color ||
            null,
          thickness_mm:
            toNullableNumber(
              row.thickness_mm
            ),
          stock_quantity:
            toNumber(
              row.stock_quantity
            ),
          italy_price_usd:
            toNullableNumber(
              row.italy_price_usd
            ),
          stock_value_usd:
            toNullableNumber(
              row.stock_value_usd
            ),
        })
      );

    return res.status(200).json({
      success: true,
      currency:
        "USD",
      brand_scope:
        GERENCIA_TARGET_BRAND,
      valuation_basis:
        "CURRENT_ITALY_PRICE",
      summary,
      filters: {
        collections:
          collectionsResult.rows.map(
            (row) => ({
              name:
                row.collection,
              slug:
                row.collection_key,
            })
          ),
      },
      count:
        products.length,
      products,
    });
  } catch (error) {
    console.error(
      "Error obteniendo Stock Distribución Chile:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "No fue posible obtener el Stock Distribución Chile",
    });
  }
};

/* =========================================
   VENTAS DISTRIBUCIÓN CHILE

   Sólo expone:
   - pedido
   - fecha
   - producto ABET
   - cantidad
   - Precio Italia USD
   - total USD

   No selecciona ni devuelve:
   - precios CLP
   - IVA
   - descuentos
   - clientes / RUT
   - pagos
========================================= */
export const getGerenciaSales = async (
  req,
  res
) => {
  const search =
    normalizeText(
      req.query.search
    );

  const collection =
    normalizeText(
      req.query.collection
    );

  const fromDate =
    normalizeDate(
      req.query.from
    );

  const toDate =
    normalizeDate(
      req.query.to
    );

  const page =
    Math.max(
      Number.parseInt(
        req.query.page,
        10
      ) ||
        DEFAULT_SALES_PAGE,
      1
    );

  const requestedLimit =
    Number.parseInt(
      req.query.limit,
      10
    ) ||
    DEFAULT_SALES_LIMIT;

  const limit =
    Math.min(
      Math.max(
        requestedLimit,
        1
      ),
      MAX_SALES_LIMIT
    );

  const offset =
    (
      page -
      1
    ) *
    limit;

  try {
    const {
      values,
      whereClause,
    } =
      buildSalesFilters({
        search,
        collection,
        fromDate,
        toDate,
      });

    const summaryResult =
      await pool.query(
        `
          ${buildSalesBaseCte()}

          SELECT
            COUNT(
              DISTINCT order_id
            )::int
              AS total_orders,

            COALESCE(
              SUM(quantity),
              0
            )
              AS total_units,

            COALESCE(
              SUM(
                quantity
              ) FILTER (
                WHERE italy_unit_price_usd IS NOT NULL
              ),
              0
            )
              AS priced_units,

            COALESCE(
              SUM(
                quantity
              ) FILTER (
                WHERE italy_unit_price_usd IS NULL
              ),
              0
            )
              AS unpriced_units,

            COALESCE(
              SUM(
                quantity *
                italy_unit_price_usd
              ) FILTER (
                WHERE italy_unit_price_usd IS NOT NULL
              ),
              0
            )
              AS total_value_usd,

            COUNT(
              DISTINCT order_id
            ) FILTER (
              WHERE italy_unit_price_usd IS NULL
            )::int
              AS orders_with_unpriced_items

          FROM sales_base

          ${whereClause}
        `,
        values
      );

    const collectionsResult =
      await pool.query(
        `
          ${buildSalesBaseCte()},

          collection_options AS (
            SELECT
              collection,
              COALESCE(
                NULLIF(
                  BTRIM(
                    collection_slug
                  ),
                  ''
                ),
                BTRIM(
                  collection
                )
              ) AS collection_key

            FROM sales_base

            WHERE collection IS NOT NULL
              AND BTRIM(
                collection
              ) <> ''
          )

          SELECT DISTINCT ON (
            collection_key
          )
            collection,
            collection_key

          FROM collection_options

          ORDER BY
            collection_key ASC,
            collection ASC
        `
      );

    const countResult =
      await pool.query(
        `
          ${buildSalesBaseCte()}

          SELECT
            COUNT(
              DISTINCT order_id
            )::int
              AS total

          FROM sales_base

          ${whereClause}
        `,
        values
      );

    const listValues =
      [
        ...values,
        limit,
        offset,
      ];

    const limitParam =
      `$${values.length + 1}`;

    const offsetParam =
      `$${values.length + 2}`;

    const salesResult =
      await pool.query(
        `
          ${buildSalesBaseCte()}

          SELECT
            order_id,
            order_number,
            MIN(created_at)
              AS created_at,

            MIN(source)
              AS source,

            COUNT(*)::int
              AS item_count,

            COALESCE(
              SUM(quantity),
              0
            )
              AS total_units,

            COALESCE(
              SUM(
                quantity *
                italy_unit_price_usd
              ) FILTER (
                WHERE italy_unit_price_usd IS NOT NULL
              ),
              0
            )
              AS total_value_usd,

            COUNT(*) FILTER (
              WHERE italy_unit_price_usd IS NULL
            )::int
              AS unpriced_items,

            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'sku',
                sku,
                'name',
                product_name,
                'quantity',
                quantity
              )
              ORDER BY
                product_name ASC,
                sku ASC
            )
              AS items_preview

          FROM sales_base

          ${whereClause}

          GROUP BY
            order_id,
            order_number

          ORDER BY
            MIN(created_at) DESC,
            order_id DESC

          LIMIT ${limitParam}
          OFFSET ${offsetParam}
        `,
        listValues
      );

    const summaryRow =
      summaryResult.rows[0] ||
      {};

    const total =
      toNumber(
        countResult.rows[0]
          ?.total
      );

    const totalPages =
      total ===
        0
        ? 0
        : Math.ceil(
            total /
              limit
          );

    return res.status(
      200
    ).json({
      success:
        true,

      currency:
        "USD",

      brand_scope:
        GERENCIA_TARGET_BRAND,

      valuation_basis:
        "SALE_TIME_ITALY_PRICE",

      summary: {
        total_orders:
          toNumber(
            summaryRow.total_orders
          ),

        total_units:
          toNumber(
            summaryRow.total_units
          ),

        priced_units:
          toNumber(
            summaryRow.priced_units
          ),

        unpriced_units:
          toNumber(
            summaryRow.unpriced_units
          ),

        total_value_usd:
          toNumber(
            summaryRow.total_value_usd
          ),

        orders_with_unpriced_items:
          toNumber(
            summaryRow.orders_with_unpriced_items
          ),
      },

      filters: {
        collections:
          collectionsResult.rows.map(
            (
              row
            ) => ({
              name:
                row.collection,
              slug:
                row.collection_key,
            })
          ),
      },

      pagination: {
        page,
        limit,
        total,
        total_pages:
          totalPages,
        has_next_page:
          page <
          totalPages,
        has_previous_page:
          page >
          1,
      },

      sales:
        salesResult.rows.map(
          (
            row
          ) => ({
            id:
              row.order_id,

            order_number:
              row.order_number,

            created_at:
              row.created_at,

            source:
              row.source,

            item_count:
              toNumber(
                row.item_count
              ),

            total_units:
              toNumber(
                row.total_units
              ),

            total_value_usd:
              toNumber(
                row.total_value_usd
              ),

            unpriced_items:
              toNumber(
                row.unpriced_items
              ),

            items_preview:
              Array.isArray(
                row.items_preview
              )
                ? row.items_preview.map(
                    (
                      item
                    ) => ({
                      sku:
                        item.sku ||
                        null,

                      name:
                        item.name ||
                        null,

                      quantity:
                        toNumber(
                          item.quantity
                        ),
                    })
                  )
                : [],
          })
        ),
    });
  } catch (
    error
  ) {
    console.error(
      "Error obteniendo Ventas Distribución Chile:",
      error
    );

    return res.status(
      500
    ).json({
      success:
        false,
      message:
        "No fue posible obtener las Ventas Distribución Chile",
    });
  }
};

export const getGerenciaSaleDetail = async (
  req,
  res
) => {
  const orderId =
    normalizeUuid(
      req.params.orderId
    );

  if (
    !orderId
  ) {
    return res.status(
      400
    ).json({
      success:
        false,
      message:
        "El pedido solicitado no es válido",
    });
  }

  try {
    const result =
      await pool.query(
        `
          ${buildSalesBaseCte()}

          SELECT
            order_id,
            order_number,
            created_at,
            source,
            order_item_id,
            product_id,
            sku,
            product_name,
            collection,
            finish,
            quantity,
            italy_unit_price_usd,
            valuation_source,

            CASE
              WHEN italy_unit_price_usd IS NULL
                THEN NULL
              ELSE
                quantity *
                italy_unit_price_usd
            END
              AS italy_line_total_usd

          FROM sales_base

          WHERE order_id = $1

          ORDER BY
            product_name ASC,
            sku ASC,
            order_item_id ASC
        `,
        [
          orderId,
        ]
      );

    if (
      result.rowCount ===
      0
    ) {
      return res.status(
        404
      ).json({
        success:
          false,
        message:
          "La venta no existe o no contiene productos ABET LAMINATI",
      });
    }

    const first =
      result.rows[0];

    const items =
      result.rows.map(
        (
          row
        ) => ({
          order_item_id:
            row.order_item_id,

          product_id:
            row.product_id,

          sku:
            row.sku,

          name:
            row.product_name,

          collection:
            row.collection ||
            null,

          finish:
            row.finish ||
            null,

          quantity:
            toNumber(
              row.quantity
            ),

          italy_unit_price_usd:
            toNullableNumber(
              row.italy_unit_price_usd
            ),

          italy_total_usd:
            toNullableNumber(
              row.italy_line_total_usd
            ),

          valuation_source:
            row.valuation_source,
        })
      );

    const totalUnits =
      items.reduce(
        (
          sum,
          item
        ) =>
          sum +
          item.quantity,
        0
      );

    const totalValueUsd =
      items.reduce(
        (
          sum,
          item
        ) =>
          sum +
          (
            item.italy_total_usd ||
            0
          ),
        0
      );

    const unpricedItems =
      items.filter(
        (
          item
        ) =>
          item.italy_unit_price_usd ===
          null
      ).length;

    return res.status(
      200
    ).json({
      success:
        true,

      currency:
        "USD",

      brand_scope:
        GERENCIA_TARGET_BRAND,

      sale: {
        id:
          first.order_id,

        order_number:
          first.order_number,

        created_at:
          first.created_at,

        source:
          first.source,

        total_units:
          totalUnits,

        total_value_usd:
          totalValueUsd,

        unpriced_items:
          unpricedItems,

        items,
      },
    });
  } catch (
    error
  ) {
    console.error(
      "Error obteniendo detalle de Venta Distribución Chile:",
      error
    );

    return res.status(
      500
    ).json({
      success:
        false,
      message:
        "No fue posible obtener el detalle de la venta",
    });
  }
};

/* =========================================
   COTIZACIONES PROYECTOS CHILE

   Sólo PROJECT + ABET LAMINATI.

   No expone:
   - cliente / RUT
   - precios CLP
   - IVA
   - descuentos
   - pagos
========================================= */
export const getGerenciaProjectQuotations =
  async (
    req,
    res
  ) => {
    const search =
      normalizeText(
        req.query.search
      );

    const collection =
      normalizeText(
        req.query.collection
      );

    const requestedStatus =
      normalizeText(
        req.query.status
      ).toUpperCase();

    const status =
      PROJECT_QUOTE_STATUSES.has(
        requestedStatus
      )
        ? requestedStatus
        : "";

    const fromDate =
      normalizeDate(
        req.query.from
      );

    const toDate =
      normalizeDate(
        req.query.to
      );

    const page =
      Math.max(
        Number.parseInt(
          req.query.page,
          10
        ) ||
          DEFAULT_PROJECT_QUOTES_PAGE,
        1
      );

    const requestedLimit =
      Number.parseInt(
        req.query.limit,
        10
      ) ||
      DEFAULT_PROJECT_QUOTES_LIMIT;

    const limit =
      Math.min(
        Math.max(
          requestedLimit,
          1
        ),
        MAX_PROJECT_QUOTES_LIMIT
      );

    const offset =
      (
        page -
        1
      ) *
      limit;

    try {
      const {
        values,
        whereClause,
      } =
        buildProjectQuotationFilters({
          search,
          collection,
          status,
          fromDate,
          toDate,
        });

      const summaryResult =
        await pool.query(
          `
            ${buildProjectQuotationBaseCte()}

            SELECT
              COUNT(
                DISTINCT quotation_id
              )::int
                AS total_quotations,

              COALESCE(
                SUM(quantity),
                0
              )
                AS total_units,

              COALESCE(
                SUM(
                  quantity
                ) FILTER (
                  WHERE italy_unit_price_usd IS NOT NULL
                ),
                0
              )
                AS priced_units,

              COALESCE(
                SUM(
                  quantity
                ) FILTER (
                  WHERE italy_unit_price_usd IS NULL
                ),
                0
              )
                AS unpriced_units,

              COALESCE(
                SUM(
                  quantity *
                  italy_unit_price_usd
                ) FILTER (
                  WHERE italy_unit_price_usd IS NOT NULL
                ),
                0
              )
                AS product_total_value_usd,

              COALESCE(
                (
                  SELECT SUM(
                    f.quantity *
                    f.italy_unit_price_usd
                  )
                  FROM project_quote_freight f
                  WHERE f.italy_unit_price_usd IS NOT NULL
                    AND f.quotation_id IN (
                      SELECT DISTINCT quotation_id
                      FROM project_quote_base
                      ${whereClause}
                    )
                ),
                0
              )
                AS freight_total_usd,

              COALESCE(
                SUM(
                  quantity *
                  italy_unit_price_usd
                ) FILTER (
                  WHERE italy_unit_price_usd IS NOT NULL
                ),
                0
              )
              +
              COALESCE(
                (
                  SELECT SUM(
                    f.quantity *
                    f.italy_unit_price_usd
                  )
                  FROM project_quote_freight f
                  WHERE f.italy_unit_price_usd IS NOT NULL
                    AND f.quotation_id IN (
                      SELECT DISTINCT quotation_id
                      FROM project_quote_base
                      ${whereClause}
                    )
                ),
                0
              )
                AS total_value_usd,

              COUNT(
                DISTINCT quotation_id
              ) FILTER (
                WHERE italy_unit_price_usd IS NULL
              )::int
                AS quotations_with_unpriced_items,

              COALESCE(
                (
                  SELECT COUNT(*)
                  FROM project_quote_freight f
                  WHERE f.italy_unit_price_usd IS NULL
                    AND f.quotation_id IN (
                      SELECT DISTINCT quotation_id
                      FROM project_quote_base
                      ${whereClause}
                    )
                ),
                0
              )::int
                AS unpriced_freight_items

            FROM project_quote_base

            ${whereClause}
          `,
          values
        );

      const collectionsResult =
        await pool.query(
          `
            ${buildProjectQuotationBaseCte()},

            collection_options AS (
              SELECT
                collection,

                COALESCE(
                  NULLIF(
                    BTRIM(
                      collection_slug
                    ),
                    ''
                  ),
                  BTRIM(
                    collection
                  )
                ) AS collection_key

              FROM project_quote_base

              WHERE collection IS NOT NULL
                AND BTRIM(
                  collection
                ) <> ''
            )

            SELECT DISTINCT ON (
              collection_key
            )
              collection,
              collection_key

            FROM collection_options

            ORDER BY
              collection_key ASC,
              collection ASC
          `
        );

      const countResult =
        await pool.query(
          `
            ${buildProjectQuotationBaseCte()}

            SELECT
              COUNT(
                DISTINCT quotation_id
              )::int
                AS total

            FROM project_quote_base

            ${whereClause}
          `,
          values
        );

      const listValues =
        [
          ...values,
          limit,
          offset,
        ];

      const limitParam =
        `$${values.length + 1}`;

      const offsetParam =
        `$${values.length + 2}`;

      const result =
        await pool.query(
          `
            ${buildProjectQuotationBaseCte()}

            SELECT
              quotation_id,
              quote_number,
              MIN(project_name)
                AS project_name,
              MIN(project_reference)
                AS project_reference,
              MIN(status)
                AS status,
              MIN(quotation_status)
                AS quotation_status,
              MIN(board_stage)
                AS board_stage,
              MIN(created_at)
                AS created_at,
              MIN(valid_until)
                AS valid_until,

              COUNT(*)::int
                AS item_count,

              COALESCE(
                SUM(quantity),
                0
              )
                AS total_units,

              COALESCE(
                SUM(
                  quantity *
                  italy_unit_price_usd
                ) FILTER (
                  WHERE italy_unit_price_usd IS NOT NULL
                ),
                0
              )
                AS product_total_value_usd,

              COALESCE(
                (
                  SELECT SUM(
                    f.quantity *
                    f.italy_unit_price_usd
                  )
                  FROM project_quote_freight f
                  WHERE f.quotation_id =
                    project_quote_base.quotation_id
                    AND f.italy_unit_price_usd IS NOT NULL
                ),
                0
              )
                AS freight_total_usd,

              COALESCE(
                SUM(
                  quantity *
                  italy_unit_price_usd
                ) FILTER (
                  WHERE italy_unit_price_usd IS NOT NULL
                ),
                0
              )
              +
              COALESCE(
                (
                  SELECT SUM(
                    f.quantity *
                    f.italy_unit_price_usd
                  )
                  FROM project_quote_freight f
                  WHERE f.quotation_id =
                    project_quote_base.quotation_id
                    AND f.italy_unit_price_usd IS NOT NULL
                ),
                0
              )
                AS total_value_usd,

              COUNT(*) FILTER (
                WHERE italy_unit_price_usd IS NULL
              )::int
              +
              COALESCE(
                (
                  SELECT COUNT(*)
                  FROM project_quote_freight f
                  WHERE f.quotation_id =
                    project_quote_base.quotation_id
                    AND f.italy_unit_price_usd IS NULL
                ),
                0
              )::int
                AS unpriced_items,

              JSONB_AGG(
                JSONB_BUILD_OBJECT(
                  'sku',
                  sku,
                  'name',
                  COALESCE(
                    product_name,
                    description
                  ),
                  'quantity',
                  quantity
                )
                ORDER BY
                  sort_order ASC,
                  product_name ASC,
                  sku ASC
              )
                AS items_preview

            FROM project_quote_base

            ${whereClause}

            GROUP BY
              quotation_id,
              quote_number

            ORDER BY
              MIN(created_at) DESC,
              quotation_id DESC

            LIMIT ${limitParam}
            OFFSET ${offsetParam}
          `,
          listValues
        );

      const row =
        summaryResult.rows[0] ||
        {};

      const total =
        toNumber(
          countResult.rows[0]
            ?.total
        );

      const totalPages =
        total ===
          0
          ? 0
          : Math.ceil(
              total /
                limit
            );

      return res.status(
        200
      ).json({
        success:
          true,

        currency:
          "USD",

        brand_scope:
          GERENCIA_TARGET_BRAND,

        quotation_type:
          "PROJECT",

        summary: {
          total_quotations:
            toNumber(
              row.total_quotations
            ),

          total_units:
            toNumber(
              row.total_units
            ),

          priced_units:
            toNumber(
              row.priced_units
            ),

          unpriced_units:
            toNumber(
              row.unpriced_units
            ),

          product_total_value_usd:
            toNumber(
              row.product_total_value_usd
            ),

          freight_total_usd:
            toNumber(
              row.freight_total_usd
            ),

          total_value_usd:
            toNumber(
              row.total_value_usd
            ),

          unpriced_freight_items:
            toNumber(
              row.unpriced_freight_items
            ),

          quotations_with_unpriced_items:
            toNumber(
              row.quotations_with_unpriced_items
            ),
        },

        filters: {
          collections:
            collectionsResult.rows.map(
              (
                collectionRow
              ) => ({
                name:
                  collectionRow.collection,

                slug:
                  collectionRow.collection_key,
              })
            ),

          statuses:
            Array.from(
              PROJECT_QUOTE_STATUSES
            ),
        },

        pagination: {
          page,
          limit,
          total,

          total_pages:
            totalPages,

          has_next_page:
            page <
            totalPages,

          has_previous_page:
            page >
            1,
        },

        quotations:
          result.rows.map(
            (
              quote
            ) => ({
              id:
                quote.quotation_id,

              quote_number:
                quote.quote_number,

              project_name:
                quote.project_name ||
                "Proyecto sin nombre",

              project_reference:
                quote.project_reference ||
                null,

              status:
                quote.status,

              board_stage:
                quote.board_stage ||
                null,

              quotation_status:
                quote.quotation_status ||
                null,

              created_at:
                quote.created_at,

              valid_until:
                quote.valid_until,

              item_count:
                toNumber(
                  quote.item_count
                ),

              total_units:
                toNumber(
                  quote.total_units
                ),

              product_total_value_usd:
                toNumber(
                  quote.product_total_value_usd
                ),

              freight_total_usd:
                toNumber(
                  quote.freight_total_usd
                ),

              total_value_usd:
                toNumber(
                  quote.total_value_usd
                ),

              unpriced_items:
                toNumber(
                  quote.unpriced_items
                ),

              items_preview:
                Array.isArray(
                  quote.items_preview
                )
                  ? quote.items_preview.map(
                      (
                        item
                      ) => ({
                        sku:
                          item.sku ||
                          null,

                        name:
                          item.name ||
                          null,

                        quantity:
                          toNumber(
                            item.quantity
                          ),
                      })
                    )
                  : [],
            })
          ),
      });
    } catch (
      error
    ) {
      console.error(
        "Error obteniendo Cotizaciones Proyectos Chile:",
        error
      );

      return res.status(
        500
      ).json({
        success:
          false,

        message:
          "No fue posible obtener las Cotizaciones Proyectos Chile",
      });
    }
  };

export const getGerenciaProjectQuotationDetail =
  async (
    req,
    res
  ) => {
    const quotationId =
      normalizeUuid(
        req.params
          .quotationId
      );

    if (
      !quotationId
    ) {
      return res.status(
        400
      ).json({
        success:
          false,

        message:
          "La cotización solicitada no es válida",
      });
    }

    try {
      const result =
        await pool.query(
          `
            ${buildProjectQuotationBaseCte()}

            SELECT
              quotation_id,
              quote_number,
              project_name,
              project_reference,
              status,
              quotation_status,
              board_stage,
              created_at,
              valid_until,

              project_line_id,
              product_id,
              sku,

              COALESCE(
                product_name,
                description
              ) AS name,

              description,
              code,
              collection,

              COALESCE(
                line_finish,
                product_finish
              ) AS finish,

              thickness_mm,
              quantity,
              unit,
              format_label,
              width_cm,
              height_cm,
              italy_unit_price_usd,
              valuation_source,

              CASE
                WHEN italy_unit_price_usd IS NULL
                  THEN NULL
                ELSE
                  quantity *
                  italy_unit_price_usd
              END
                AS italy_line_total_usd,

              sort_order

            FROM project_quote_base

            WHERE quotation_id = $1

            ORDER BY
              sort_order ASC,
              project_line_id ASC
          `,
          [
            quotationId,
          ]
        );

      const freightResult =
        await pool.query(
          `
            ${buildProjectQuotationBaseCte()}

            SELECT
              quotation_id,
              project_line_id,
              description,
              code,
              quantity,
              unit,
              italy_unit_price_usd,
              valuation_source,
              freight_type,
              sort_order,

              CASE
                WHEN italy_unit_price_usd IS NULL
                  THEN NULL
                ELSE
                  quantity *
                  italy_unit_price_usd
              END
                AS italy_line_total_usd

            FROM project_quote_freight

            WHERE quotation_id = $1

            ORDER BY
              sort_order ASC,
              project_line_id ASC
          `,
          [
            quotationId,
          ]
        );

      if (
        result.rowCount ===
        0
      ) {
        return res.status(
          404
        ).json({
          success:
            false,

          message:
            "La cotización no existe o no contiene productos ABET LAMINATI",
        });
      }

      const first =
        result.rows[0];

      const items =
        result.rows.map(
          (
            row
          ) => ({
            project_line_id:
              row.project_line_id,

            product_id:
              row.product_id,

            sku:
              row.sku ||
              row.code ||
              null,

            name:
              row.name,

            description:
              row.description,

            collection:
              row.collection ||
              null,

            finish:
              row.finish ||
              null,

            thickness_mm:
              toNullableNumber(
                row.thickness_mm
              ),

            quantity:
              toNumber(
                row.quantity
              ),

            unit:
              row.unit,

            format_label:
              row.format_label ||
              null,

            width_cm:
              toNullableNumber(
                row.width_cm
              ),

            height_cm:
              toNullableNumber(
                row.height_cm
              ),

            italy_unit_price_usd:
              toNullableNumber(
                row.italy_unit_price_usd
              ),

            italy_total_usd:
              toNullableNumber(
                row.italy_line_total_usd
              ),

            valuation_source:
              row.valuation_source,
          })
        );

      const freightLines =
        freightResult.rows.map(
          (
            row
          ) => ({
            project_line_id:
              row.project_line_id,

            description:
              row.description,

            code:
              row.code ||
              null,

            freight_type:
              row.freight_type ||
              "FREIGHT",

            quantity:
              toNumber(
                row.quantity
              ),

            unit:
              row.unit ||
              "UN",

            italy_unit_price_usd:
              toNullableNumber(
                row.italy_unit_price_usd
              ),

            italy_total_usd:
              toNullableNumber(
                row.italy_line_total_usd
              ),

            valuation_source:
              row.valuation_source ||
              null,
          })
        );

      const totalUnits =
        items.reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.quantity,
          0
        );

      const productTotalValueUsd =
        items.reduce(
          (
            sum,
            item
          ) =>
            sum +
            (
              item.italy_total_usd ||
              0
            ),
          0
        );

      const freightTotalValueUsd =
        freightLines.reduce(
          (
            sum,
            line
          ) =>
            sum +
            (
              line.italy_total_usd ||
              0
            ),
          0
        );

      const totalValueUsd =
        productTotalValueUsd +
        freightTotalValueUsd;

      const unpricedProductItems =
        items.filter(
          (
            item
          ) =>
            item.italy_unit_price_usd ===
            null
        ).length;

      const unpricedFreightItems =
        freightLines.filter(
          (
            line
          ) =>
            line.italy_unit_price_usd ===
            null
        ).length;

      const unpricedItems =
        unpricedProductItems +
        unpricedFreightItems;

      return res.status(
        200
      ).json({
        success:
          true,

        currency:
          "USD",

        brand_scope:
          GERENCIA_TARGET_BRAND,

        quotation: {
          id:
            first.quotation_id,

          quote_number:
            first.quote_number,

          project_name:
            first.project_name ||
            "Proyecto sin nombre",

          project_reference:
            first.project_reference ||
            null,

          status:
            first.status,

          board_stage:
            first.board_stage ||
            null,

          quotation_status:
            first.quotation_status ||
            null,

          created_at:
            first.created_at,

          valid_until:
            first.valid_until,

          total_units:
            totalUnits,

          product_total_usd:
            productTotalValueUsd,

          freight_total_usd:
            freightTotalValueUsd,

          total_value_usd:
            totalValueUsd,

          unpriced_items:
            unpricedItems,

          unpriced_freight_items:
            unpricedFreightItems,

          freight_lines:
            freightLines,

          items,
        },
      });
    } catch (
      error
    ) {
      console.error(
        "Error obteniendo detalle de Cotización Proyecto Chile:",
        error
      );

      return res.status(
        500
      ).json({
        success:
          false,

        message:
          "No fue posible obtener el detalle de la cotización de proyecto",
      });
    }
  };

