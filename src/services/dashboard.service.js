import pool from "../config/database.js";

/*
 * Dashboard comercial Laminatiword: sólo lectura.
 * Las ventas se contabilizan una sola vez por orden, cuando:
 * - orders.payment_status = PAID;
 * - orders.status != CANCELLED;
 * - existe un pago PAID con confirmed_at;
 * - el origen es WEB o STORE.
 *
 * Se usa la última fecha de confirmación de pago de cada orden
 * y el total bruto consolidado de orders (IVA incluido).
 * No se incluyen devoluciones/refunds en forma neta: una orden
 * totalmente REFUNDED sale del conjunto por payment_status.
 */

const TZ = "America/Santiago";
const DAY_MS = 86_400_000;
const MAX_DAYS = 731;
const SOURCES = new Set(["ALL", "WEB", "STORE"]);
const GRANULARITIES = new Set(["auto", "day", "week", "month"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEGMENT_SLUG = /^[a-z0-9_]{1,40}$/;

const badRequest = (message, code) => {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
};

const todayInChile = () =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const parseDateOnly = (value, label) => {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw badRequest(`${label} debe tener formato YYYY-MM-DD`, "DASHBOARD_INVALID_DATE");
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw badRequest(`${label} no es una fecha válida`, "DASHBOARD_INVALID_DATE");
  }
  return date;
};

const dateOnly = (date) => date.toISOString().slice(0, 10);
const minusDays = (date, days) => new Date(date.getTime() - days * DAY_MS);

export const resolveDashboardFilters = (query = {}) => {
  const preset = String(query.preset || "30d").trim().toLowerCase();
  const today = parseDateOnly(todayInChile(), "hoy");
  const hasRange = query.from !== undefined || query.to !== undefined;
  let from;
  let to;

  if (hasRange) {
    if (!query.from || !query.to) {
      throw badRequest("Debes enviar from y to para un rango personalizado", "DASHBOARD_RANGE_REQUIRED");
    }
    from = parseDateOnly(query.from, "from");
    to = parseDateOnly(query.to, "to");
  } else {
    to = today;
    if (preset === "today") from = today;
    else if (preset === "7d") from = minusDays(today, 6);
    else if (preset === "30d") from = minusDays(today, 29);
    else if (preset === "month") from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    else throw badRequest("preset debe ser today, 7d, 30d o month", "DASHBOARD_INVALID_PRESET");
  }

  const diffDays = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (diffDays < 1) {
    throw badRequest("from debe ser anterior o igual a to", "DASHBOARD_RANGE_ORDER");
  }
  if (diffDays > MAX_DAYS) {
    throw badRequest("El rango máximo es de 731 días", "DASHBOARD_RANGE_TOO_LARGE");
  }
  if (to.getTime() > today.getTime()) {
    throw badRequest("to no puede ser una fecha futura", "DASHBOARD_FUTURE_DATE");
  }

  const channel = String(query.channel || "ALL").trim().toUpperCase();
  if (!SOURCES.has(channel)) {
    throw badRequest("channel debe ser ALL, WEB o STORE", "DASHBOARD_INVALID_CHANNEL");
  }

  const requestedGranularity = String(query.granularity || "auto").trim().toLowerCase();
  if (!GRANULARITIES.has(requestedGranularity)) {
    throw badRequest("granularity debe ser auto, day, week o month", "DASHBOARD_INVALID_GRANULARITY");
  }
  const granularity = requestedGranularity === "auto"
    ? diffDays <= 62 ? "day" : diffDays <= 180 ? "week" : "month"
    : requestedGranularity;
  if (granularity === "day" && diffDays > 120) {
    throw badRequest("La agrupación diaria admite hasta 120 días", "DASHBOARD_DAILY_RANGE_TOO_LARGE");
  }

  // Segmentación comercial: los nombres provienen de BD, no de reglas de precio inferidas.
  const collection = String(query.collection ?? "ALL").trim();
  if (collection !== "ALL" && collection !== "NONE" && !UUID.test(collection)) {
    throw badRequest("collection debe ser ALL, NONE o un UUID de colección", "DASHBOARD_INVALID_COLLECTION");
  }
  const segment = String(query.segment ?? "ALL").trim().toLowerCase();
  if (segment !== "all" && segment !== "unclassified" && !SEGMENT_SLUG.test(segment)) {
    throw badRequest("segment no es válido", "DASHBOARD_INVALID_SEGMENT");
  }

  const limitRaw = query.top === undefined ? 10 : Number(query.top);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 50) {
    throw badRequest("top debe ser un entero entre 1 y 50", "DASHBOARD_INVALID_TOP");
  }

  return {
    from: dateOnly(from),
    to: dateOnly(to),
    channel,
    collection,
    segment: segment === "all" ? "ALL" : segment === "unclassified" ? "UNCLASSIFIED" : segment,
    granularity,
    top: limitRaw,
    timezone: TZ,
    date_basis: "latest_confirmed_paid_payment",
    metric: "gross_clp_including_vat",
  };
};

/*
 * REGLAS DE SEGMENTACIÓN
 * - Sin filtro: mismo total original de orders (se preservan las cifras previas).
 * - Con colección/segmento: NO sumar toda la orden si contiene otros artículos.
 *   Se prorratea orders.total y orders.tax_total usando line_total del ítem
 *   respecto del total de líneas de ESA orden. Esto reparte descuentos globales.
 * - COUNT(*) es número de órdenes con >= 1 ítem coincidente, NO órdenes exclusivas.
 * - Clasificaciones de productos son las ACTUALES: si se cambia la colección
 *   después de vender, la historia se reagrupará; para snapshots inmutables se
 *   requerirían columnas adicionales en order_items en una futura etapa.
 * - Los segmentos son configurables y no tienen reglas de precio automáticas.
 */
const matchProductSql = `
  ($4::text = 'ALL'
    OR ($4::text = 'NONE' AND pr.collection_id IS NULL)
    OR ($4::text NOT IN ('ALL', 'NONE') AND pr.collection_id::text = $4::text))
  AND ($5::text = 'ALL'
    OR ($5::text = 'UNCLASSIFIED' AND pcs.product_id IS NULL)
    OR pcs.segment_slug = $5::text)
`;

const paidOrdersSql = `
  WITH paid_orders AS (
    SELECT
      o.id, o.source, o.total, o.tax_total,
      settlement.paid_at,
      (settlement.paid_at AT TIME ZONE 'America/Santiago')::date AS paid_date
    FROM orders o
    JOIN LATERAL (
      SELECT MAX(p.confirmed_at) AS paid_at
      FROM payments p
      WHERE p.order_id = o.id
        AND p.status = 'PAID'
        AND p.confirmed_at IS NOT NULL
    ) settlement ON settlement.paid_at IS NOT NULL
    WHERE o.payment_status = 'PAID'
      AND o.status <> 'CANCELLED'
      AND o.source IN ('WEB', 'STORE')
      AND ($3::text = 'ALL' OR o.source = $3::text)
      AND settlement.paid_at >= ($1::date::timestamp AT TIME ZONE 'America/Santiago')
      AND settlement.paid_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Santiago')
  ),
  all_lines AS (
    SELECT oi.order_id, SUM(oi.line_total)::numeric AS all_gross
    FROM order_items oi
    JOIN paid_orders po ON po.id = oi.order_id
    GROUP BY oi.order_id
  ),
  selected_lines AS (
    SELECT oi.order_id,
           COUNT(*)::int AS line_count,
           SUM(oi.line_total)::numeric AS selected_gross
    FROM order_items oi
    JOIN paid_orders po ON po.id = oi.order_id
    LEFT JOIN products pr ON pr.id = oi.product_id
    LEFT JOIN product_commercial_segments pcs ON pcs.product_id = oi.product_id
    WHERE ${matchProductSql}
    GROUP BY oi.order_id
  ),
  selected_orders AS (
    SELECT po.id, po.source, po.paid_date,
           CASE WHEN $4::text = 'ALL' AND $5::text = 'ALL' THEN po.total
                WHEN al.all_gross > 0 THEN po.total * sl.selected_gross / al.all_gross
                ELSE 0 END::numeric AS total,
           CASE WHEN $4::text = 'ALL' AND $5::text = 'ALL' THEN po.tax_total
                WHEN al.all_gross > 0 THEN po.tax_total * sl.selected_gross / al.all_gross
                ELSE 0 END::numeric AS tax_total
    FROM paid_orders po
    LEFT JOIN all_lines al ON al.order_id = po.id
    LEFT JOIN selected_lines sl ON sl.order_id = po.id
    WHERE ($4::text = 'ALL' AND $5::text = 'ALL') OR sl.line_count > 0
  )
`;

const summarySql = `${paidOrdersSql}
  SELECT source,
         COUNT(*)::int AS order_count,
         COALESCE(SUM(total), 0)::numeric AS gross_sales,
         COALESCE(SUM(tax_total), 0)::numeric AS tax_total
  FROM selected_orders
  GROUP BY source
  ORDER BY source;
`;

const timelineSql = `${paidOrdersSql},
  daily AS (
    SELECT DATE_TRUNC($6::text, paid_date::timestamp)::date AS bucket,
           source,
           SUM(total)::numeric AS gross_sales,
           COUNT(*)::int AS order_count
    FROM selected_orders
    GROUP BY 1, 2
  ),
  buckets AS (
    SELECT series.bucket::date AS bucket
    FROM generate_series(
      DATE_TRUNC($6::text, $1::date::timestamp),
      DATE_TRUNC($6::text, $2::date::timestamp),
      CASE $6::text
        WHEN 'day' THEN interval '1 day'
        WHEN 'week' THEN interval '1 week'
        ELSE interval '1 month'
      END
    ) AS series(bucket)
  )
  SELECT b.bucket::text AS date,
         COALESCE(MAX(d.gross_sales) FILTER (WHERE d.source = 'WEB'), 0)::numeric AS online,
         COALESCE(MAX(d.gross_sales) FILTER (WHERE d.source = 'STORE'), 0)::numeric AS showroom,
         COALESCE(MAX(d.order_count) FILTER (WHERE d.source = 'WEB'), 0)::int AS online_orders,
         COALESCE(MAX(d.order_count) FILTER (WHERE d.source = 'STORE'), 0)::int AS showroom_orders
  FROM buckets b
  LEFT JOIN daily d ON d.bucket = b.bucket
  GROUP BY b.bucket
  ORDER BY b.bucket;
`;

const topProductsSql = `${paidOrdersSql}
  SELECT
    COALESCE(NULLIF(BTRIM(oi.sku), ''), 'SIN-SKU') AS sku,
    MAX(oi.product_name) AS product_name,
    COALESCE(SUM(oi.quantity), 0)::numeric AS units_sold,
    COALESCE(SUM(CASE WHEN al.all_gross > 0
      THEN po.total * oi.line_total / al.all_gross ELSE 0 END), 0)::numeric AS gross_sales,
    COUNT(DISTINCT oi.order_id)::int AS order_count
  FROM selected_orders so
  JOIN paid_orders po ON po.id = so.id
  JOIN order_items oi ON oi.order_id = so.id
  JOIN all_lines al ON al.order_id = so.id
  LEFT JOIN products pr ON pr.id = oi.product_id
  LEFT JOIN product_commercial_segments pcs ON pcs.product_id = oi.product_id
  WHERE ${matchProductSql}
  GROUP BY COALESCE(NULLIF(BTRIM(oi.sku), ''), 'SIN-SKU')
  ORDER BY units_sold DESC, gross_sales DESC, sku ASC
  LIMIT $6::int;
`;

// Opciones leídas directamente de PostgreSQL; no filtra por ventas para poder
// seleccionar una colección aunque no tenga ventas en el período.
export const getDashboardFilterOptions = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const collections = await client.query(
      `SELECT id::text AS id, name FROM collections ORDER BY name ASC, id ASC`
    );
    const segments = await client.query(
      `SELECT slug, name, is_active FROM commercial_segments WHERE is_active = TRUE ORDER BY name ASC`
    );
    await client.query("COMMIT");
    return { collections: collections.rows, segments: segments.rows };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* no-op */ }
    throw error;
  } finally {
    client.release();
  }
};

const numeric = (value) => Number(value ?? 0);

export const getSalesDashboard = async (filters) => {
  const values = [
    filters.from, filters.to, filters.channel,
    filters.collection, filters.segment,
  ];
  const client = await pool.connect();
  try {
    // Snapshot único: todas las gráficas reflejan el mismo instante de datos.
    // READ ONLY impide accidentalmente mutaciones de inventario, pagos y DTE.
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const summaryResult = await client.query(summarySql, values);
    const timelineResult = await client.query(timelineSql, [...values, filters.granularity]);
    const productsResult = await client.query(topProductsSql, [...values, filters.top]);
    await client.query("COMMIT");

    const channels = {
      WEB: { gross_sales: 0, orders: 0, tax_total: 0 },
      STORE: { gross_sales: 0, orders: 0, tax_total: 0 },
    };
    for (const row of summaryResult.rows) {
      if (channels[row.source]) {
        channels[row.source] = {
          gross_sales: numeric(row.gross_sales),
          orders: numeric(row.order_count),
          tax_total: numeric(row.tax_total),
        };
      }
    }

    const summary = {
      gross_sales: channels.WEB.gross_sales + channels.STORE.gross_sales,
      orders: channels.WEB.orders + channels.STORE.orders,
      tax_total: channels.WEB.tax_total + channels.STORE.tax_total,
      average_order_value: 0,
      channels,
    };
    summary.average_order_value = summary.orders
      ? Math.round((summary.gross_sales / summary.orders) * 100) / 100
      : 0;

    return {
      filters,
      summary,
      timeline: timelineResult.rows.map((row) => ({
        date: row.date,
        online: numeric(row.online),
        showroom: numeric(row.showroom),
        total: numeric(row.online) + numeric(row.showroom),
        online_orders: numeric(row.online_orders),
        showroom_orders: numeric(row.showroom_orders),
      })),
      top_products: productsResult.rows.map((row) => ({
        sku: row.sku,
        product_name: row.product_name,
        units_sold: numeric(row.units_sold),
        gross_sales: numeric(row.gross_sales),
        orders: numeric(row.order_count),
      })),
      notes: [
        "Se incluyen órdenes WEB y STORE pagadas con fecha de confirmación; las cotizaciones no se incluyen.",
        "Los importes son brutos con IVA incluido; no equivalen a ingresos contables netos.",
        "Las órdenes reembolsadas no se incluyen cuando payment_status deja de ser PAID; los reembolsos parciales requieren conciliación adicional.",
        "BACKOFFICE se excluye hasta definir su canal comercial.",
        "Al filtrar colección o segmento, los importes de cada pedido se prorratean por el peso bruto de sus líneas; pedidos mixtos se cuentan en cada filtro al que pertenecen.",
        "Las colecciones y los segmentos corresponden a la clasificación ACTUAL del producto, no a un registro histórico al momento de la venta.",
        "Los segmentos Comodín y Commodity caros no se asignan automáticamente ni se deducen del precio; requieren definición y asignación explícita.",
      ],
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transacción ya cerrada */ }
    throw error;
  } finally {
    client.release();
  }
};
