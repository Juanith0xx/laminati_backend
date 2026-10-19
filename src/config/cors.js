import "dotenv/config";

const normalizeOrigin = (value) => {
  return String(value || "")
    .trim()
    .replace(/\/$/, "");
};

const configuredOrigins = new Set(
  String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean)
);

const isDevelopment =
  String(process.env.NODE_ENV || "development")
    .trim()
    .toLowerCase() !== "production";

const isLocalDevelopmentOrigin = (origin) => {
  if (!isDevelopment) {
    return false;
  }

  try {
    const url = new URL(origin);

    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "::1"].includes(
        url.hostname
      )
    );
  } catch {
    return false;
  }
};

export const corsOptions = {
  credentials: true,

  origin(origin, callback) {
    /*
     * Requests server-to-server, Insomnia/cURL y health checks
     * pueden venir sin cabecera Origin.
     */
    if (!origin) {
      return callback(null, true);
    }

    const normalized = normalizeOrigin(origin);

    if (
      configuredOrigins.has(normalized) ||
      isLocalDevelopmentOrigin(normalized)
    ) {
      return callback(null, true);
    }

    const error = new Error(
      "Origen no permitido por CORS"
    );
    error.status = 403;
    error.code = "CORS_ORIGIN_DENIED";

    return callback(error, false);
  },
};