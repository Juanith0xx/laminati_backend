import pool from "../config/database.js";

/**
 * Lecturas administrativas aisladas. No altera el checkout, el inventario,
 * las reservas, los pagos, el servicio existente ni la emisión de DTE.
 */
const SOURCES = new Set(["ALL", "WEB", "STORE"]);
const STATUSES = new Set([
  "ALL", "PENDING", "CONFIRMED", "PROCESSING", "COMPLETED", "CANCELLED",
]);
const PAYMENTS = new Set([
  "ALL", "PENDING", "AWAITING_CONFIRMATION", "AUTHORIZED", "PAID",
  "FAILED", "REFUNDED", "CANCELLED",
]);
const FULFILLMENT = new Set([
  "ALL", "PENDING", "PREPARING", "READY_FOR_PICKUP", "DELIVERED", "CANCELLED",
]);

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "ORDER_MANAGEMENT_INVALID_FILTER";
  return error;
}

function getChoice(raw, values, label) {
  const value = String(raw ?? "ALL").trim().toUpperCase();
  if (!values.has(value)) {
    throw invalid(`${label} no es un valor permitido`);
  }
  return value;
}

function getNumber(raw, fallback, min, max, label) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    throw invalid(`${label} debe ser un entero entre ${min} y ${max}`);
  }
  return num;
}

function getDate(raw, label) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid(`${label} debe tener formato YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw invalid(`${label} no es una fecha válida`);
  }
  return value;
}

export function normalizeOrderManagementFilters(query = {}) {
  const from = getDate(query.from, "from");
  const to = getDate(query.to, "to");
  if (from && to && from > to) throw invalid("from no puede ser posterior a to");

  const search = String(query.search ?? "").trim().replace(/\s+/g, " ");
  if (search.length > 120) throw invalid("La búsqueda admite hasta 120 caracteres");

  return {
    search,
    source: getChoice(query.source, SOURCES, "source"),
    status: getChoice(query.status, STATUSES, "status"),
    payment_status: getChoice(query.payment_status, PAYMENTS, "payment_status"),
    fulfillment_status: getChoice(query.fulfillment_status, FULFILLMENT, "fulfillment_status"),
    from,
    to,
    page: getNumber(query.page, 1, 1, 100000, "page"),
    limit: getNumber(query.limit, 20, 1, 100, "limit"),
    timezone: "America/Santiago",
    date_basis: "order_created_at",
  };
}

export async function listAdminOrders(filters) {
  const values = [];
  const conditions = ["o.source IN ('WEB', 'STORE')"];
  const add = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.source !== "ALL") {
    conditions.push(`o.source = ${add(filters.source)}`);
  }
  for (const field of ["status", "payment_status", "fulfillment_status"]) {
    if (filters[field] !== "ALL") conditions.push(`o.${field} = ${add(filters[field])}`);
  }
  if (filters.from) {
    conditions.push(`o.created_at >= (${add(filters.from)}::date::timestamp AT TIME ZONE 'America/Santiago')`);
  }
  if (filters.to) {
    conditions.push(`o.created_at < ((${add(filters.to)}::date + 1)::timestamp AT TIME ZONE 'America/Santiago')`);
  }
  if (filters.search) {
    const term = add(`%${filters.search}%`);
    conditions.push(`(
      o.order_number ILIKE ${term}
      OR o.customer_name ILIKE ${term}
      OR o.customer_rut ILIKE ${term}
      OR o.email ILIKE ${term}
      OR EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id = o.id
          AND (
            oi.sku ILIKE ${term}
            OR oi.product_name ILIKE ${term}
            OR oi.product_code ILIKE ${term}
            OR oi.reference_code ILIKE ${term}
          )
      )
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limitParam = add(filters.limit);
  const offsetParam = add((filters.page - 1) * filters.limit);
  const countParams = values.slice(0, -2);

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const count = await client.query(
      `SELECT COUNT(*)::int AS total FROM orders o ${where}`,
      countParams
    );
    const result = await client.query(
      `SELECT
        o.id, o.order_number, o.customer_name, o.customer_rut, o.email,
        o.source, o.status, o.payment_status, o.fulfillment_status,
        o.total, o.currency, o.created_at, o.updated_at,
        COALESCE(products.skus, ARRAY[]::text[]) AS product_skus,
        COALESCE(products.items_count, 0)::int AS items_count,
        COALESCE(products.units, 0)::numeric AS total_units
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT
          ARRAY_AGG(DISTINCT oi.sku) FILTER (WHERE NULLIF(BTRIM(oi.sku), '') IS NOT NULL) AS skus,
          COUNT(*)::int AS items_count,
          SUM(oi.quantity)::numeric AS units
        FROM order_items oi
        WHERE oi.order_id = o.id
      ) products ON TRUE
      ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values
    );
    await client.query("COMMIT");

    const total = Number(count.rows[0]?.total || 0);
    const totalPages = Math.ceil(total / filters.limit);
    return {
      filters,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        total_pages: totalPages,
        has_next_page: filters.page < totalPages,
        has_previous_page: filters.page > 1,
      },
      orders: result.rows,
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* conexión cerrada */ }
    throw error;
  } finally {
    client.release();
  }
}
