import pool from "../config/database.js";

const EVENT_TYPES = new Set([
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
]);

const DEVICE_TYPES = new Set([
  "DESKTOP",
  "MOBILE",
  "TABLET",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const normalizeText = (value) =>
  String(value ?? "").trim();

const normalizeUpper = (value) =>
  normalizeText(value).toUpperCase();

const parsePositiveInteger = (
  value,
  fallback,
  max = Number.MAX_SAFE_INTEGER
) => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
};

const isValidDateKey = (value) => {
  const text = normalizeText(value);

  if (!DATE_PATTERN.test(text)) {
    return false;
  }

  const [year, month, day] = text
    .split("-")
    .map(Number);

  const date = new Date(
    Date.UTC(year, month - 1, day)
  );

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const parseSuccessFilter = (value) => {
  const normalized = normalizeUpper(value);

  if (!normalized || normalized === "ALL") {
    return null;
  }

  if (
    normalized === "TRUE" ||
    normalized === "1" ||
    normalized === "SUCCESS"
  ) {
    return true;
  }

  if (
    normalized === "FALSE" ||
    normalized === "0" ||
    normalized === "FAILED"
  ) {
    return false;
  }

  const error = new Error(
    "El filtro success debe ser true, false o all"
  );
  error.status = 400;
  error.code = "INVALID_AUTH_HISTORY_SUCCESS_FILTER";
  throw error;
};

const validateFilters = (query = {}) => {
  const search = normalizeText(query.search).slice(0, 160);
  const eventType = normalizeUpper(query.event_type);
  const deviceType = normalizeUpper(query.device_type);
  const dateFrom = normalizeText(query.date_from);
  const dateTo = normalizeText(query.date_to);

  if (
    eventType &&
    eventType !== "ALL" &&
    !EVENT_TYPES.has(eventType)
  ) {
    const error = new Error(
      "Tipo de evento de acceso no válido"
    );
    error.status = 400;
    error.code = "INVALID_AUTH_HISTORY_EVENT_TYPE";
    throw error;
  }

  if (
    deviceType &&
    deviceType !== "ALL" &&
    !DEVICE_TYPES.has(deviceType)
  ) {
    const error = new Error(
      "Tipo de dispositivo no válido"
    );
    error.status = 400;
    error.code = "INVALID_AUTH_HISTORY_DEVICE_TYPE";
    throw error;
  }

  if (dateFrom && !isValidDateKey(dateFrom)) {
    const error = new Error(
      "date_from debe usar formato YYYY-MM-DD"
    );
    error.status = 400;
    error.code = "INVALID_AUTH_HISTORY_DATE_FROM";
    throw error;
  }

  if (dateTo && !isValidDateKey(dateTo)) {
    const error = new Error(
      "date_to debe usar formato YYYY-MM-DD"
    );
    error.status = 400;
    error.code = "INVALID_AUTH_HISTORY_DATE_TO";
    throw error;
  }

  if (
    dateFrom &&
    dateTo &&
    dateFrom > dateTo
  ) {
    const error = new Error(
      "date_from no puede ser posterior a date_to"
    );
    error.status = 400;
    error.code = "INVALID_AUTH_HISTORY_DATE_RANGE";
    throw error;
  }

  return {
    search,
    eventType:
      eventType && eventType !== "ALL"
        ? eventType
        : null,
    success: parseSuccessFilter(query.success),
    deviceType:
      deviceType && deviceType !== "ALL"
        ? deviceType
        : null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    page: parsePositiveInteger(query.page, 1),
    limit: parsePositiveInteger(query.limit, 50, 100),
  };
};

const buildBaseWhere = ({
  search,
  userId,
  deviceType,
  dateFrom,
  dateTo,
}) => {
  const params = [];
  const conditions = ["1 = 1"];

  if (userId) {
    params.push(userId);
    conditions.push(`e.user_id = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    const index = params.length;

    conditions.push(`(
      COALESCE(e.email, '') ILIKE $${index}
      OR COALESCE(e.ip_address, '') ILIKE $${index}
      OR COALESCE(u.first_name, '') ILIKE $${index}
      OR COALESCE(u.last_name, '') ILIKE $${index}
      OR CONCAT_WS(' ', u.first_name, u.last_name) ILIKE $${index}
    )`);
  }

  if (deviceType) {
    params.push(deviceType);
    conditions.push(`e.device_type = $${params.length}`);
  }

  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`
      e.created_at >= (
        $${params.length}::date::timestamp
        AT TIME ZONE 'America/Santiago'
      )
    `);
  }

  if (dateTo) {
    params.push(dateTo);
    conditions.push(`
      e.created_at < (
        ($${params.length}::date + 1)::timestamp
        AT TIME ZONE 'America/Santiago'
      )
    `);
  }

  return {
    params,
    conditions,
  };
};

const getAuthHistory = async ({
  query,
  userId = null,
}) => {
  const filters = validateFilters(query);

  const base = buildBaseWhere({
    ...filters,
    userId,
  });

  const dataParams = [...base.params];
  const dataConditions = [...base.conditions];

  if (filters.eventType) {
    dataParams.push(filters.eventType);
    dataConditions.push(
      `e.event_type = $${dataParams.length}`
    );
  }

  if (filters.success !== null) {
    dataParams.push(filters.success);
    dataConditions.push(
      `e.success = $${dataParams.length}`
    );
  }

  const whereSql = dataConditions.join(" AND ");
  const summaryWhereSql = base.conditions.join(" AND ");

  const countResult = await pool.query(
    `
      SELECT COUNT(*)::int AS total
      FROM auth_login_events e
      LEFT JOIN users u
        ON u.id = e.user_id
      WHERE ${whereSql}
    `,
    dataParams
  );

  const total = Number(
    countResult.rows[0]?.total || 0
  );

  const offset =
    (filters.page - 1) * filters.limit;

  const listParams = [
    ...dataParams,
    filters.limit,
    offset,
  ];

  const limitIndex = listParams.length - 1;
  const offsetIndex = listParams.length;

  const [eventsResult, summaryResult] =
    await Promise.all([
      pool.query(
        `
          SELECT
            e.id,
            e.user_id,
            e.email,
            e.event_type,
            e.success,
            e.ip_address,
            e.user_agent,
            e.device_type,
            e.browser,
            e.operating_system,
            e.failure_reason,
            e.created_at,
            u.first_name,
            u.last_name,
            u.is_active AS user_is_active,
            r.name AS role
          FROM auth_login_events e
          LEFT JOIN users u
            ON u.id = e.user_id
          LEFT JOIN roles r
            ON r.id = u.role_id
          WHERE ${whereSql}
          ORDER BY
            e.created_at DESC,
            e.id DESC
          LIMIT $${limitIndex}
          OFFSET $${offsetIndex}
        `,
        listParams
      ),
      pool.query(
        `
          SELECT
            COUNT(*)::int AS total_events,
            (
              COUNT(*) FILTER (
                WHERE e.event_type = 'LOGIN_SUCCESS'
              )
            )::int AS login_success,
            (
              COUNT(*) FILTER (
                WHERE e.event_type = 'LOGIN_FAILED'
              )
            )::int AS login_failed,
            (
              COUNT(*) FILTER (
                WHERE e.event_type = 'LOGOUT'
              )
            )::int AS logout,
            COUNT(
              DISTINCT e.user_id
            ) FILTER (
              WHERE e.user_id IS NOT NULL
            )::int AS distinct_users,
            MAX(e.created_at) AS last_event_at,
            MAX(e.created_at) FILTER (
              WHERE e.event_type = 'LOGIN_SUCCESS'
            ) AS last_login_success_at,
            MAX(e.created_at) FILTER (
              WHERE e.event_type = 'LOGIN_FAILED'
            ) AS last_login_failed_at
          FROM auth_login_events e
          LEFT JOIN users u
            ON u.id = e.user_id
          WHERE ${summaryWhereSql}
        `,
        base.params
      ),
    ]);

  return {
    data: eventsResult.rows,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      total_pages: Math.max(
        1,
        Math.ceil(total / filters.limit)
      ),
    },
    summary: summaryResult.rows[0] || {
      total_events: 0,
      login_success: 0,
      login_failed: 0,
      logout: 0,
      distinct_users: 0,
      last_event_at: null,
      last_login_success_at: null,
      last_login_failed_at: null,
    },
    filters: {
      search: filters.search || null,
      event_type: filters.eventType,
      success: filters.success,
      device_type: filters.deviceType,
      date_from: filters.dateFrom,
      date_to: filters.dateTo,
      user_id: userId,
    },
  };
};

const sendError = (
  res,
  error,
  fallbackMessage
) => {
  console.error(fallbackMessage, {
    message: error?.message || null,
    code: error?.code || null,
  });

  return res
    .status(error?.status || 500)
    .json({
      success: false,
      message:
        error?.message || fallbackMessage,
      code: error?.code || null,
    });
};

/* =========================================
   HISTORIAL GLOBAL DE ACCESOS
   Sólo ADMIN por protección de admin.routes.js
========================================= */
export const listAdminAuthHistory = async (
  req,
  res
) => {
  try {
    const result = await getAuthHistory({
      query: req.query,
    });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "No fue posible obtener el historial de accesos"
    );
  }
};

/* =========================================
   HISTORIAL DE ACCESOS POR USUARIO
========================================= */
export const listAdminUserAuthHistory = async (
  req,
  res
) => {
  try {
    const userId = normalizeText(
      req.params.userId
    );

    if (!UUID_PATTERN.test(userId)) {
      const error = new Error(
        "El ID de usuario no es válido"
      );
      error.status = 400;
      error.code = "INVALID_AUTH_HISTORY_USER_ID";
      throw error;
    }

    const userResult = await pool.query(
      `
        SELECT
          u.id,
          u.first_name,
          u.last_name,
          u.email,
          u.is_active,
          r.name AS role
        FROM users u
        INNER JOIN roles r
          ON r.id = u.role_id
        WHERE u.id = $1
        LIMIT 1
      `,
      [userId]
    );

    if (userResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Usuario no encontrado",
        code: "AUTH_HISTORY_USER_NOT_FOUND",
      });
    }

    const result = await getAuthHistory({
      query: req.query,
      userId,
    });

    return res.status(200).json({
      success: true,
      user: userResult.rows[0],
      ...result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "No fue posible obtener el historial de accesos del usuario"
    );
  }
};
