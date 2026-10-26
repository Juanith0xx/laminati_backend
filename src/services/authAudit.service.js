import pool from "../config/database.js";

const ALLOWED_EVENT_TYPES = new Set([
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGOUT",
]);

const normalizeText = (value) =>
  String(value ?? "").trim();

const normalizeEmail = (value) => {
  const email = normalizeText(value).toLowerCase();
  return email || null;
};

const normalizeIp = (value) => {
  const ip = normalizeText(value);

  if (!ip) {
    return null;
  }

  return ip.replace(/^::ffff:/i, "").slice(0, 100);
};

const getRequestIp = (req) => {
  const forwarded = req?.headers?.["x-forwarded-for"];

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return normalizeIp(forwarded[0]);
  }

  if (typeof forwarded === "string" && forwarded.trim()) {
    return normalizeIp(forwarded.split(",")[0]);
  }

  return normalizeIp(
    req?.headers?.["x-real-ip"] ||
      req?.ip ||
      req?.socket?.remoteAddress
  );
};

const detectDeviceType = (userAgent) => {
  const ua = normalizeText(userAgent);

  if (
    /iPad|Tablet/i.test(ua) ||
    (/Android/i.test(ua) && !/Mobile/i.test(ua))
  ) {
    return "TABLET";
  }

  if (/Android|iPhone|iPod|Mobile/i.test(ua)) {
    return "MOBILE";
  }

  return "DESKTOP";
};

const detectBrowser = (userAgent) => {
  const ua = normalizeText(userAgent);

  if (/Edg\//i.test(ua)) return "Microsoft Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/CriOS\//i.test(ua)) return "Chrome iOS";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/FxiOS\//i.test(ua)) return "Firefox iOS";
  if (/Safari\//i.test(ua) && /Version\//i.test(ua)) {
    return "Safari";
  }

  return ua ? "Otro" : null;
};

const detectOperatingSystem = (userAgent) => {
  const ua = normalizeText(userAgent);

  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS / iPadOS";
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";

  return ua ? "Otro" : null;
};

const resolveEmailForUser = async (userId, email) => {
  const normalizedEmail = normalizeEmail(email);

  if (normalizedEmail || !userId) {
    return normalizedEmail;
  }

  const result = await pool.query(
    `
      SELECT email
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  );

  return normalizeEmail(result.rows[0]?.email);
};

export const recordAuthEvent = async ({
  userId = null,
  email = null,
  eventType,
  success = true,
  req = null,
  failureReason = null,
} = {}) => {
  const normalizedEventType = normalizeText(eventType).toUpperCase();

  if (!ALLOWED_EVENT_TYPES.has(normalizedEventType)) {
    throw new Error(
      `Tipo de evento de autenticación no permitido: ${normalizedEventType || "VACÍO"}`
    );
  }

  const userAgent = normalizeText(
    req?.headers?.["user-agent"]
  );

  const resolvedEmail = await resolveEmailForUser(
    userId,
    email
  );

  const result = await pool.query(
    `
      INSERT INTO auth_login_events (
        user_id,
        email,
        event_type,
        success,
        ip_address,
        user_agent,
        device_type,
        browser,
        operating_system,
        failure_reason
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
        $10
      )
      RETURNING id, created_at
    `,
    [
      userId || null,
      resolvedEmail,
      normalizedEventType,
      Boolean(success),
      getRequestIp(req),
      userAgent || null,
      detectDeviceType(userAgent),
      detectBrowser(userAgent),
      detectOperatingSystem(userAgent),
      normalizeText(failureReason).slice(0, 100) || null,
    ]
  );

  return result.rows[0] || null;
};

/*
 * La auditoría nunca debe impedir que el usuario inicie o cierre sesión.
 * Si PostgreSQL o la tabla de auditoría presentan un problema, registramos
 * el error en servidor y continuamos con el flujo normal de autenticación.
 */
export const recordAuthEventSafely = async (payload) => {
  try {
    return await recordAuthEvent(payload);
  } catch (error) {
    console.error(
      "No fue posible registrar el evento de autenticación:",
      {
        eventType: payload?.eventType || null,
        userId: payload?.userId || null,
        message: error?.message || "Error desconocido",
      }
    );

    return null;
  }
};
