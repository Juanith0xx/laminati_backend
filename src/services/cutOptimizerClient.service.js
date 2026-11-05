const DEFAULT_TIMEOUT_MS = 15000;

const cleanBaseUrl = (value) =>
  String(value || "")
    .trim()
    .replace(/\/+$/, "");

const getConfig = () => {
  const baseUrl = cleanBaseUrl(
    process.env.CUT_OPTIMIZER_URL
  );

  const apiKey = String(
    process.env.CUT_OPTIMIZER_API_KEY || ""
  ).trim();

  const timeoutMs = Number(
    process.env.CUT_OPTIMIZER_TIMEOUT_MS ||
      DEFAULT_TIMEOUT_MS
  );

  if (!baseUrl) {
    const error = new Error(
      "CUT_OPTIMIZER_URL no está configurada"
    );

    error.code =
      "CUT_OPTIMIZER_URL_MISSING";

    error.status = 503;

    throw error;
  }

  if (!apiKey) {
    const error = new Error(
      "CUT_OPTIMIZER_API_KEY no está configurada"
    );

    error.code =
      "CUT_OPTIMIZER_API_KEY_MISSING";

    error.status = 503;

    throw error;
  }

  return {
    baseUrl,
    apiKey,
    timeoutMs:
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS,
  };
};

const parseJsonSafely = async (
  response
) => {
  const text =
    await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text,
    };
  }
};

const createUpstreamError = ({
  message,
  code,
  status = 502,
  details = null,
}) => {
  const error =
    new Error(message);

  error.code = code;
  error.status = status;
  error.details = details;

  return error;
};

export const getCutOptimizerHealth =
  async () => {
    const {
      baseUrl,
      timeoutMs,
    } = getConfig();

    const controller =
      new AbortController();

    const timer = setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

    try {
      const response =
        await fetch(
          `${baseUrl}/health`,
          {
            method: "GET",
            headers: {
              Accept:
                "application/json",
            },
            signal:
              controller.signal,
          }
        );

      const body =
        await parseJsonSafely(
          response
        );

      if (!response.ok) {
        throw createUpstreamError({
          message:
            "El optimizador de cortes respondió con error",
          code:
            "CUT_OPTIMIZER_HEALTH_ERROR",
          status: 502,
          details: {
            upstreamStatus:
              response.status,
            upstreamResponse:
              body,
          },
        });
      }

      return body;
    } catch (error) {
      if (
        error?.name ===
        "AbortError"
      ) {
        throw createUpstreamError({
          message:
            "El optimizador de cortes excedió el tiempo de espera",
          code:
            "CUT_OPTIMIZER_TIMEOUT",
          status: 504,
        });
      }

      if (
        error?.code &&
        error?.status
      ) {
        throw error;
      }

      throw createUpstreamError({
        message:
          "No fue posible conectar con el optimizador de cortes",
        code:
          "CUT_OPTIMIZER_UNAVAILABLE",
        status: 503,
        details: {
          reason:
            error?.message ||
            "UNKNOWN_ERROR",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };

export const optimizeBathroomCuts =
  async (payload) => {
    const {
      baseUrl,
      apiKey,
      timeoutMs,
    } = getConfig();

    const controller =
      new AbortController();

    const timer = setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

    try {
      const response =
        await fetch(
          `${baseUrl}/api/v1/bathrooms/optimize`,
          {
            method: "POST",
            headers: {
              Accept:
                "application/json",
              "Content-Type":
                "application/json",
              "x-api-key":
                apiKey,
            },
            body:
              JSON.stringify(
                payload
              ),
            signal:
              controller.signal,
          }
        );

      const body =
        await parseJsonSafely(
          response
        );

      if (!response.ok) {
        /*
         * 4xx del optimizador representa normalmente
         * una entrada inválida. La propagamos como 422
         * al frontend sin revelar la API key.
         */
        if (
          response.status >= 400 &&
          response.status < 500
        ) {
          throw createUpstreamError({
            message:
              body?.message ||
              "El optimizador rechazó los datos del proyecto",
            code:
              body?.code ||
              "CUT_OPTIMIZER_VALIDATION_ERROR",
            status: 422,
            details:
              body?.details ||
              body?.errors ||
              null,
          });
        }

        throw createUpstreamError({
          message:
            "El optimizador de cortes respondió con error",
          code:
            "CUT_OPTIMIZER_UPSTREAM_ERROR",
          status: 502,
          details: {
            upstreamStatus:
              response.status,
            upstreamResponse:
              body,
          },
        });
      }

      if (
        !body ||
        body.ok !== true ||
        !body.data
      ) {
        throw createUpstreamError({
          message:
            "El optimizador devolvió una respuesta inválida",
          code:
            "CUT_OPTIMIZER_INVALID_RESPONSE",
          status: 502,
        });
      }

      return body;
    } catch (error) {
      if (
        error?.name ===
        "AbortError"
      ) {
        throw createUpstreamError({
          message:
            "El optimizador de cortes excedió el tiempo de espera",
          code:
            "CUT_OPTIMIZER_TIMEOUT",
          status: 504,
        });
      }

      if (
        error?.code &&
        error?.status
      ) {
        throw error;
      }

      throw createUpstreamError({
        message:
          "No fue posible conectar con el optimizador de cortes",
        code:
          "CUT_OPTIMIZER_UNAVAILABLE",
        status: 503,
        details: {
          reason:
            error?.message ||
            "UNKNOWN_ERROR",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };
