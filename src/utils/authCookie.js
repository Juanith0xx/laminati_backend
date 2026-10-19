import jwt from "jsonwebtoken";

const AUTH_COOKIE_NAME =
  process.env.AUTH_COOKIE_NAME ||
  "laminati_session";

const FALLBACK_MAX_AGE_MS =
  2 * 60 * 60 * 1000;

const isProduction = () =>
  String(process.env.NODE_ENV || "development")
    .trim()
    .toLowerCase() === "production";

const getTokenRemainingMs = (token) => {
  try {
    const decoded = jwt.decode(token);
    const expiresAt =
      Number(decoded?.exp || 0) * 1000;

    if (!expiresAt) {
      return FALLBACK_MAX_AGE_MS;
    }

    return Math.max(
      expiresAt - Date.now(),
      1000
    );
  } catch {
    return FALLBACK_MAX_AGE_MS;
  }
};

export const getAuthCookieOptions = (token) => ({
  httpOnly: true,
  secure: isProduction(),
  sameSite: isProduction() ? "none" : "lax",
  path: "/",
  ...(token
    ? { maxAge: getTokenRemainingMs(token) }
    : {}),
});

export const setAuthCookie = (res, token) => {
  res.cookie(
    AUTH_COOKIE_NAME,
    token,
    getAuthCookieOptions(token)
  );
};

export const clearAuthCookie = (res) => {
  res.clearCookie(
    AUTH_COOKIE_NAME,
    getAuthCookieOptions()
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
    return source
      .replace(/^Bearer\s+/i, "")
      .trim();
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
