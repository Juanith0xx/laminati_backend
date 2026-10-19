const AUTH_COOKIE_NAME =
  process.env.AUTH_COOKIE_NAME ||
  "laminati_session";

const isProduction = () =>
  String(process.env.NODE_ENV || "development")
    .trim()
    .toLowerCase() === "production";

const parseDurationMs = (value) => {
  const source = String(value || "2h")
    .trim()
    .toLowerCase();

  const match = source.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 2 * 60 * 60 * 1000;

  const amount = Number(match[1]);
  const factors = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * factors[match[2]];
};

export const getAuthCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction(),
  sameSite: isProduction() ? "none" : "lax",
  path: "/",
  maxAge: parseDurationMs(
    process.env.JWT_EXPIRES_IN || "2h"
  ),
});

export const setAuthCookie = (res, token) => {
  res.cookie(
    AUTH_COOKIE_NAME,
    token,
    getAuthCookieOptions()
  );
};

export const clearAuthCookie = (res) => {
  const { maxAge, ...options } =
    getAuthCookieOptions();

  res.clearCookie(
    AUTH_COOKIE_NAME,
    options
  );
};

const decodeCookiePart = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const readCookie = (cookieHeader, name) => {
  const source = String(cookieHeader || "");

  for (const part of source.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;

    const key = part.slice(0, index).trim();
    if (key !== name) continue;

    return decodeCookiePart(
      part.slice(index + 1).trim()
    );
  }

  return null;
};

const normalizeBearer = (value) => {
  const source = String(value || "").trim();
  if (!source) return null;

  if (/^Bearer\s+/i.test(source)) {
    return source.replace(/^Bearer\s+/i, "").trim();
  }

  return null;
};

export const getAuthTokenFromRequest = (req) => {
  const bearer = normalizeBearer(
    req?.headers?.authorization
  );

  if (bearer) return bearer;

  return readCookie(
    req?.headers?.cookie,
    AUTH_COOKIE_NAME
  );
};

export const getAuthTokenFromSocket = (socket) => {
  // Compatibilidad temporal con el handshake legacy.
  const legacyAuthToken = String(
    socket?.handshake?.auth?.token || ""
  )
    .replace(/^Bearer\s+/i, "")
    .replace(/^"|"$/g, "")
    .trim();

  if (legacyAuthToken) {
    return legacyAuthToken;
  }

  const bearer = normalizeBearer(
    socket?.handshake?.headers?.authorization
  );

  if (bearer) return bearer;

  return readCookie(
    socket?.handshake?.headers?.cookie,
    AUTH_COOKIE_NAME
  );
};
