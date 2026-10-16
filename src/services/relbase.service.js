import pool from "../config/database.js";

import {
  encryptValue,
  decryptValue,
} from "../utils/encryption.js";

const getRelbaseConfig = () => {
  const clientId =
    process.env.RELBASE_CLIENT_ID;

  const clientSecret =
    process.env.RELBASE_CLIENT_SECRET;

  const baseUrl =
    process.env.RELBASE_BASE_URL ||
    "https://api.relbase.cl";

  if (
    !clientId ||
    !clientSecret
  ) {
    throw new Error(
      "Configuración de Relbase incompleta"
    );
  }

  return {
    clientId,
    clientSecret,
    baseUrl,
  };
};

/* =========================================
   OBTENER ACCESS TOKEN VÁLIDO
========================================= */
export const getValidRelbaseAccessToken = async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Bloqueamos la fila para impedir que
     * dos peticiones renueven simultáneamente
     * el mismo refresh_token.
     */
    const result = await client.query(
      `
        SELECT
          id,
          access_token_encrypted,
          refresh_token_encrypted,
          access_expires_at,
          is_active
        FROM relbase_oauth_connections
        WHERE provider = 'RELBASE'
        LIMIT 1
        FOR UPDATE
      `
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");

      throw new Error(
        "Relbase no se encuentra conectado"
      );
    }

    const connection =
      result.rows[0];

    if (!connection.is_active) {
      await client.query("ROLLBACK");

      throw new Error(
        "La conexión con Relbase está desactivada"
      );
    }

    /*
     * Renovamos 60 segundos antes de vencer
     * para evitar utilizar un token al límite.
     */
    const expiresAt =
      new Date(
        connection.access_expires_at
      ).getTime();

    const refreshThreshold =
      Date.now() + 60 * 1000;

    /* =========================================
       TOKEN TODAVÍA VÁLIDO
    ========================================= */
    if (expiresAt > refreshThreshold) {
      const accessToken =
        decryptValue(
          connection.access_token_encrypted
        );

      await client.query("COMMIT");

      return accessToken;
    }

    /* =========================================
       TOKEN VENCIDO O POR VENCER
       RENOVAR
    ========================================= */
    const {
      clientId,
      clientSecret,
      baseUrl,
    } = getRelbaseConfig();

    const refreshToken =
      decryptValue(
        connection.refresh_token_encrypted
      );

    const body =
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      });

    const response =
      await fetch(
        `${baseUrl}/oauth/token`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",
          },

          body:
            body.toString(),
        }
      );

    const tokenData =
      await response.json();

    if (!response.ok) {
      console.error(
        "Error renovando token Relbase:",
        {
          status: response.status,
          error:
            tokenData?.error || null,
          error_description:
            tokenData?.error_description || null,
          message:
            tokenData?.message || null,
        }
      );

      await client.query("ROLLBACK");

      const error =
        new Error(
          "No fue posible renovar el token de Relbase"
        );

      error.status =
        response.status;

      error.relbaseError =
        tokenData?.error || null;

      throw error;
    }

    if (
      !tokenData.access_token ||
      !tokenData.refresh_token
    ) {
      await client.query("ROLLBACK");

      throw new Error(
        "Relbase no devolvió los nuevos tokens"
      );
    }

    const newAccessTokenEncrypted =
      encryptValue(
        tokenData.access_token
      );

    const newRefreshTokenEncrypted =
      encryptValue(
        tokenData.refresh_token
      );

    const expiresIn =
      Number(
        tokenData.expires_in || 900
      );

    /* =========================================
       GUARDAR NUEVO PAR DE TOKENS
    ========================================= */
    await client.query(
      `
        UPDATE relbase_oauth_connections

        SET
          access_token_encrypted = $1,
          refresh_token_encrypted = $2,

          token_type = $3,
          scope = COALESCE($4, scope),

          access_expires_at =
            NOW()
            + ($5 * INTERVAL '1 second'),

          last_refreshed_at = NOW(),

          is_active = TRUE

        WHERE id = $6
      `,
      [
        newAccessTokenEncrypted,
        newRefreshTokenEncrypted,

        tokenData.token_type ||
          "Bearer",

        tokenData.scope ||
          null,

        expiresIn,

        connection.id,
      ]
    );

    await client.query("COMMIT");

    return tokenData.access_token;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // La transacción puede haber finalizado.
    }

    throw error;
  } finally {
    client.release();
  }
};

/* =========================================
   ESPERA
========================================= */
const sleep = (ms) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

/* =========================================
   REQUEST RELBASE

   - Token OAuth válido
   - Manejo 429
   - Retry-After
   - Backoff exponencial
========================================= */
export const relbaseRequest = async (
  path,
  options = {}
) => {
  const { baseUrl } =
    getRelbaseConfig();

  const maxRetries = 4;

  let attempt = 0;

  while (attempt <= maxRetries) {
    const accessToken =
      await getValidRelbaseAccessToken();

    const headers = {
      Accept: "application/json",

      Authorization:
        `Bearer ${accessToken}`,

      ...options.headers,
    };

    const response =
      await fetch(
        `${baseUrl}${path}`,
        {
          ...options,
          headers,
        }
      );

    let data = null;

    try {
      data =
        await response.json();
    } catch {
      data = null;
    }

    const rateLimit = {
      limit:
        response.headers.get(
          "x-ratelimit-limit"
        ),

      remaining:
        response.headers.get(
          "x-ratelimit-remaining"
        ),

      retryAfter:
        response.headers.get(
          "retry-after"
        ),
    };

    /* =====================================
       RATE LIMIT
    ===================================== */
    if (
      response.status === 429 &&
      attempt < maxRetries
    ) {
      const retryAfterHeader =
        Number(
          rateLimit.retryAfter
        );

      /*
       * Si Relbase entrega Retry-After,
       * lo respetamos.
       *
       * Si no viene, usamos:
       * 1s → 2s → 4s → 8s
       */
      const waitSeconds =
        Number.isFinite(
          retryAfterHeader
        ) &&
        retryAfterHeader > 0
          ? retryAfterHeader
          : Math.pow(
              2,
              attempt
            );

      console.warn(
        "Rate limit Relbase alcanzado:",
        {
          attempt:
            attempt + 1,

          wait_seconds:
            waitSeconds,

          remaining:
            rateLimit.remaining,
        }
      );

      await sleep(
        waitSeconds * 1000
      );

      attempt += 1;

      continue;
    }

    /* =====================================
       ERROR RELBASE
    ===================================== */
    if (!response.ok) {
      const error =
        new Error(
          data?.meta?.message ||
          data?.message ||
          "Error consultando Relbase"
        );

      error.status =
        response.status;

      error.relbaseData =
        data;

      error.rateLimit =
        rateLimit;

      throw error;
    }

    /* =====================================
       RESPUESTA OK
    ===================================== */
    return {
      data,
      rateLimit,
    };
  }

  throw new Error(
    "Relbase superó el máximo de reintentos permitido"
  );
};

/* =========================================
   EXTRAER MENSAJE SEGURO DE RELBASE
========================================= */
const getSafeRelbaseMessage = (
  error
) => {
  return (
    error?.relbaseData
      ?.meta
      ?.message ||
    error?.relbaseData
      ?.message ||
    error?.message ||
    null
  );
};

/* =========================================
   PROBE DTE API V1 - SOLO LECTURA

   OBJETIVO:
   comprobar si el access_token OAuth v2
   puede acceder al recurso GET /api/v1/dtes.

   IMPORTANTE:
   - NO crea DTE.
   - NO modifica documentos.
   - NO envía POST.
   - NO expone access_token ni refresh_token.
========================================= */
export const probeRelbaseDteReadAccess =
  async () => {
    const endpoint =
      "/api/v1/dtes?page=1";

    const startedAt =
      Date.now();

    try {
      const result =
        await relbaseRequest(
          endpoint,
          {
            method: "GET",
          }
        );

      const payload =
        result?.data ||
        null;

      /*
       * No devolvemos documentos completos.
       * Para el probe sólo interesa saber
       * si la autenticación fue aceptada.
       */
      return {
        success: true,

        compatible:
          true,

        endpoint:
          `GET ${endpoint}`,

        auth_mode:
          "OAUTH_BEARER",

        http_status:
          200,

        message:
          "El token OAuth pudo acceder al endpoint GET /api/v1/dtes.",

        response_shape: {
          has_data:
            Boolean(
              payload &&
              Object.prototype.hasOwnProperty.call(
                payload,
                "data"
              )
            ),

          has_meta:
            Boolean(
              payload &&
              Object.prototype.hasOwnProperty.call(
                payload,
                "meta"
              )
            ),

          data_type:
            Array.isArray(
              payload?.data
            )
              ? "array"
              : typeof payload?.data,

          top_level_keys:
            payload &&
            typeof payload === "object"
              ? Object.keys(
                  payload
                ).slice(
                  0,
                  20
                )
              : [],
        },

        rate_limit:
          result.rateLimit,

        duration_ms:
          Date.now() -
          startedAt,
      };
    } catch (error) {
      const httpStatus =
        Number(
          error?.status
        ) || 500;

      /*
       * Para este probe, 401/403/404/405
       * son resultados diagnósticos válidos.
       *
       * No queremos convertirlos en un
       * error genérico que oculte qué pasó.
       */
      if (
        [
          401,
          403,
          404,
          405,
        ].includes(
          httpStatus
        )
      ) {
        return {
          success: false,

          compatible:
            false,

          endpoint:
            `GET ${endpoint}`,

          auth_mode:
            "OAUTH_BEARER",

          http_status:
            httpStatus,

          message:
            getSafeRelbaseMessage(
              error
            ) ||
            "Relbase rechazó el acceso al endpoint DTE v1.",

          diagnosis:
            httpStatus === 401
              ? "UNAUTHORIZED"
              : httpStatus === 403
                ? "FORBIDDEN"
                : httpStatus === 404
                  ? "NOT_FOUND"
                  : "METHOD_NOT_ALLOWED",

          rate_limit:
            error?.rateLimit ||
            null,

          duration_ms:
            Date.now() -
            startedAt,
        };
      }

      /*
       * Si fuera 429 después de agotar
       * reintentos, 5xx, error de red, etc.,
       * dejamos que el controller lo trate
       * como error operacional.
       */
      throw error;
    }
  };

  /* =========================================
   PROBE DTE API V2 - SOLO LECTURA

   Busca confirmar la ruta OAuth v2
   para documentos tributarios.

   NO CREA DTE.
========================================= */
export const probeRelbaseDteV2ReadAccess =
  async () => {
    const endpoint =
      "/api/v2/dtes?type_document=39&page=1";

    const startedAt =
      Date.now();

    try {
      const result =
        await relbaseRequest(
          endpoint,
          {
            method: "GET",
          }
        );

      const payload =
        result?.data ||
        null;

      const dataContainer =
        payload?.data ||
        null;

      /*
       * Detectamos automáticamente la colección
       * porque todavía no sabemos si Relbase usa:
       *
       * data.dtes
       * data.documents
       * data.resources
       * o data directamente como array.
       */
      let detectedCollection =
        null;

      let records =
        [];

      if (
        Array.isArray(
          dataContainer
        )
      ) {
        detectedCollection =
          "data";

        records =
          dataContainer;
      } else if (
        Array.isArray(
          dataContainer?.dtes
        )
      ) {
        detectedCollection =
          "data.dtes";

        records =
          dataContainer.dtes;
      } else if (
        Array.isArray(
          dataContainer?.documents
        )
      ) {
        detectedCollection =
          "data.documents";

        records =
          dataContainer.documents;
      } else if (
        Array.isArray(
          dataContainer?.resources
        )
      ) {
        detectedCollection =
          "data.resources";

        records =
          dataContainer.resources;
      }

      const firstRecord =
        records[0] ||
        null;

      /*
       * Muestra sanitizada de un DTE real.
       *
       * No devolvemos datos personales
       * del receptor.
       *
       * Tampoco exponemos el contenido
       * de pdf_file ni xml_inter_file.
       */
      const firstRecordSample =
        firstRecord
          ? {
              id:
                firstRecord.id ??
                null,

              folio:
                firstRecord.folio ??
                null,

              track_id:
                firstRecord.track_id ??
                null,

              type_document:
                firstRecord.type_document ??
                null,

              type_document_name:
                firstRecord.type_document_name ??
                null,

              status:
                firstRecord.status ??
                null,

              sii_status:
                firstRecord.sii_status ??
                null,

              sii_status_name:
                firstRecord.sii_status_name ??
                null,

              start_date:
                firstRecord.start_date ??
                null,

              end_date:
                firstRecord.end_date ??
                null,

              amounts: {
                net:
                  firstRecord.amount_neto ??
                  null,

                iva:
                  firstRecord.amount_iva ??
                  null,

                tax:
                  firstRecord.amount_tax ??
                  null,

                exempt:
                  firstRecord.amount_exempt ??
                  null,

                total:
                  firstRecord.amount_total ??
                  null,
              },

              real_amounts: {
                net:
                  firstRecord.real_amount_neto ??
                  null,

                iva:
                  firstRecord.real_amount_iva ??
                  null,

                tax:
                  firstRecord.real_amount_tax ??
                  null,

                exempt:
                  firstRecord.real_amount_exempt ??
                  null,

                total:
                  firstRecord.real_amount_total ??
                  null,
              },

              mnt_bruto:
                firstRecord.mnt_bruto ??
                null,

              pdf: {
                exists:
                  Boolean(
                    firstRecord.pdf_file
                  ),

                value_type:
                  firstRecord.pdf_file ===
                    null ||
                  firstRecord.pdf_file ===
                    undefined
                    ? null
                    : typeof firstRecord.pdf_file,

                keys:
                  firstRecord.pdf_file &&
                  typeof firstRecord.pdf_file ===
                    "object"
                    ? Object.keys(
                        firstRecord.pdf_file
                      ).slice(
                        0,
                        30
                      )
                    : [],
              },

              xml: {
                exists:
                  Boolean(
                    firstRecord.xml_inter_file
                  ),

                value_type:
                  firstRecord.xml_inter_file ===
                    null ||
                  firstRecord.xml_inter_file ===
                    undefined
                    ? null
                    : typeof firstRecord.xml_inter_file,

                keys:
                  firstRecord.xml_inter_file &&
                  typeof firstRecord.xml_inter_file ===
                    "object"
                    ? Object.keys(
                        firstRecord.xml_inter_file
                      ).slice(
                        0,
                        30
                      )
                    : [],
              },

              integration: {
                channel_id:
                  firstRecord.channel_id ??
                  null,

                type_payment_id:
                  firstRecord.type_payment_id ??
                  null,

                seller_id:
                  firstRecord.seller_id ??
                  null,
              },

              created_at:
                firstRecord.created_at ??
                null,

              updated_at:
                firstRecord.updated_at ??
                null,
            }
          : null;

      return {
        success: true,

        endpoint_exists: true,

        compatible:
          true,

        endpoint:
          `GET ${endpoint}`,

        api_version:
          "v2",

        auth_mode:
          "OAUTH_BEARER",

        http_status:
          200,

        message:
          "El endpoint DTE v2 respondió correctamente mediante OAuth.",

        response_shape: {
          has_data:
            Boolean(
              payload &&
              Object.prototype
                .hasOwnProperty
                .call(
                  payload,
                  "data"
                )
            ),

          has_meta:
            Boolean(
              payload &&
              Object.prototype
                .hasOwnProperty
                .call(
                  payload,
                  "meta"
                )
            ),

          top_level_keys:
            payload &&
            typeof payload ===
              "object"
              ? Object.keys(
                  payload
                ).slice(
                  0,
                  20
                )
              : [],

          data_keys:
            dataContainer &&
            typeof dataContainer ===
              "object" &&
            !Array.isArray(
              dataContainer
            )
              ? Object.keys(
                  dataContainer
                ).slice(
                  0,
                  30
                )
              : [],

          detected_collection:
            detectedCollection,

          records_on_page:
            records.length,

          first_record_keys:
            firstRecord &&
            typeof firstRecord ===
              "object"
              ? Object.keys(
                  firstRecord
                ).slice(
                  0,
                  50
                )
              : [],

          first_record_sample:
            firstRecordSample,
        },

        rate_limit:
          result.rateLimit,

        duration_ms:
          Date.now() -
          startedAt,
      };
    } catch (error) {
      const httpStatus =
        Number(
          error?.status
        ) || 500;

      /*
       * Estos resultados son parte
       * del descubrimiento.
       */
      if (
        [
          401,
          403,
          404,
          405,
        ].includes(
          httpStatus
        )
      ) {
        return {
          success: false,

          endpoint_exists:
            httpStatus !== 404,

          compatible:
            false,

          endpoint:
            `GET ${endpoint}`,

          api_version:
            "v2",

          auth_mode:
            "OAUTH_BEARER",

          http_status:
            httpStatus,

          message:
            error?.relbaseData
              ?.meta
              ?.message ||
            error?.relbaseData
              ?.message ||
            error.message ||
            null,

          debug_info:
            error?.relbaseData
              ?.meta
              ?.debug_info ||
            null,

          diagnosis:
            httpStatus === 401
              ? "UNAUTHORIZED"
              : httpStatus === 403
                ? "FORBIDDEN"
                : httpStatus === 404
                  ? "ENDPOINT_NOT_FOUND"
                  : "METHOD_NOT_ALLOWED",

          rate_limit:
            error?.rateLimit ||
            null,

          duration_ms:
            Date.now() -
            startedAt,
        };
      }

      throw error;
    }
  };

/* =========================================
   PROBE CONTRATO DE ESCRITURA DTE API V2

   PASO 84.6.1

   OBJETIVO:
   - Inspeccionar de forma segura el recurso
     /api/v2/dtes mediante OPTIONS.
   - Buscar headers Allow /
     Access-Control-Allow-Methods.
   - Obtener una pista sobre soporte POST.

   IMPORTANTE:
   - NO envía POST.
   - NO envía body de DTE.
   - NO crea documentos.
   - NO modifica Relbase.
   - NO modifica Laminatiword.
   - OPTIONS puede ser respondido por CORS
     genérico, por lo que POST anunciado es
     una PISTA, no confirmación definitiva.
========================================= */
export const probeRelbaseDteV2WriteContract =
  async () => {
    const endpoint =
      "/api/v2/dtes";

    const {
      baseUrl,
    } = getRelbaseConfig();

    const startedAt =
      Date.now();

    const accessToken =
      await getValidRelbaseAccessToken();

    let response;

    try {
      response =
        await fetch(
          `${baseUrl}${endpoint}`,
          {
            method:
              "OPTIONS",

            headers: {
              Accept:
                "application/json",

              Authorization:
                `Bearer ${accessToken}`,

              /*
               * Simulamos un preflight estándar.
               * Esto NO ejecuta el POST.
               */
              Origin:
                "http://localhost",

              "Access-Control-Request-Method":
                "POST",

              "Access-Control-Request-Headers":
                "authorization,content-type,idempotency-key",
            },
          }
        );
    } catch (error) {
      const wrapped =
        new Error(
          "No fue posible ejecutar el probe OPTIONS contra Relbase"
        );

      wrapped.cause =
        error;

      throw wrapped;
    }

    const responseText =
      await response.text();

    let payload =
      null;

    if (responseText) {
      try {
        payload =
          JSON.parse(
            responseText
          );
      } catch {
        payload =
          null;
      }
    }

    const allowHeader =
      response.headers.get(
        "allow"
      );

    const accessControlAllowMethods =
      response.headers.get(
        "access-control-allow-methods"
      );

    const accessControlAllowHeaders =
      response.headers.get(
        "access-control-allow-headers"
      );

    const parseMethods = (
      value
    ) =>
      String(
        value || ""
      )
        .split(",")
        .map(
          (method) =>
            method
              .trim()
              .toUpperCase()
        )
        .filter(Boolean);

    const advertisedMethods =
      Array.from(
        new Set([
          ...parseMethods(
            allowHeader
          ),

          ...parseMethods(
            accessControlAllowMethods
          ),
        ])
      );

    const postAdvertised =
      advertisedMethods.includes(
        "POST"
      );

    const idempotencyHeaderAdvertised =
      String(
        accessControlAllowHeaders ||
        ""
      )
        .toLowerCase()
        .split(",")
        .map(
          (value) =>
            value.trim()
        )
        .includes(
          "idempotency-key"
        );

    const rateLimit = {
      limit:
        response.headers.get(
          "x-ratelimit-limit"
        ),

      remaining:
        response.headers.get(
          "x-ratelimit-remaining"
        ),

      retryAfter:
        response.headers.get(
          "retry-after"
        ),
    };

    const responseMeta =
      payload?.meta &&
      typeof payload.meta ===
        "object"
        ? {
            code:
              payload.meta.code ??
              null,

            message:
              payload.meta.message ??
              null,

            debug_info:
              payload.meta.debug_info ??
              null,
          }
        : null;

    return {
      success:
        response.ok,

      safe_probe:
        true,

      write_executed:
        false,

      emission_executed:
        false,

      request: {
        method:
          "OPTIONS",

        endpoint,

        requested_method:
          "POST",

        body_sent:
          false,
      },

      http_status:
        response.status,

      endpoint_exists_hint:
        response.status !==
        404,

      post_supported_hint:
        postAdvertised,

      /*
       * Nunca marcamos esto como confirmado
       * sólo por una respuesta OPTIONS.
       */
      post_route_confirmed:
        false,

      idempotency_key_header_hint:
        idempotencyHeaderAdvertised,

      advertised_methods:
        advertisedMethods,

      headers: {
        allow:
          allowHeader,

        access_control_allow_methods:
          accessControlAllowMethods,

        access_control_allow_headers:
          accessControlAllowHeaders,
      },

      response_shape: {
        has_json_body:
          Boolean(
            payload
          ),

        top_level_keys:
          payload &&
          typeof payload ===
            "object" &&
          !Array.isArray(
            payload
          )
            ? Object.keys(
                payload
              ).slice(
                0,
                20
              )
            : [],

        meta:
          responseMeta,
      },

      rate_limit:
        rateLimit,

      diagnosis:
        postAdvertised
          ? "POST_ADVERTISED_BY_OPTIONS"
          : response.status ===
              404
            ? "ENDPOINT_NOT_FOUND"
            : response.status ===
                405
              ? "OPTIONS_NOT_ALLOWED"
              : response.ok
                ? "OPTIONS_OK_WITHOUT_POST_HINT"
                : "OPTIONS_DIAGNOSTIC_RESPONSE",

      note:
        "Una respuesta OPTIONS puede provenir de CORS genérico; no se utilizará como confirmación definitiva del contrato POST.",

      duration_ms:
        Date.now() -
        startedAt,
    };
  };

/* =========================================
   PROBE CONTROL CORS DTE API V2

   PASO 84.6.2

   OBJETIVO:
   Comparar OPTIONS /api/v2/dtes contra un
   endpoint deliberadamente inexistente.

   Si ambos devuelven los mismos métodos CORS,
   entonces Access-Control-Allow-Methods es
   probablemente una política CORS global y
   NO evidencia del contrato real del recurso.

   IMPORTANTE:
   - NO POST.
   - NO body.
   - NO crea documentos.
   - NO modifica Relbase.
========================================= */
export const probeRelbaseDteV2CorsControl =
  async () => {
    const {
      baseUrl,
    } = getRelbaseConfig();

    const accessToken =
      await getValidRelbaseAccessToken();

    const targetEndpoint =
      "/api/v2/dtes";

    const controlEndpoint =
      "/api/v2/__laminatiword_nonexistent_dte_probe__";

    const performOptions =
      async (
        endpoint
      ) => {
        const startedAt =
          Date.now();

        const response =
          await fetch(
            `${baseUrl}${endpoint}`,
            {
              method:
                "OPTIONS",

              headers: {
                Accept:
                  "application/json",

                Authorization:
                  `Bearer ${accessToken}`,

                Origin:
                  "http://localhost",

                "Access-Control-Request-Method":
                  "POST",

                "Access-Control-Request-Headers":
                  "authorization,content-type,idempotency-key",
              },
            }
          );

        const text =
          await response.text();

        let payload =
          null;

        if (text) {
          try {
            payload =
              JSON.parse(
                text
              );
          } catch {
            payload =
              null;
          }
        }

        const normalizeCsv =
          (
            value
          ) =>
            String(
              value ||
              ""
            )
              .split(",")
              .map(
                (item) =>
                  item
                    .trim()
                    .toLowerCase()
              )
              .filter(Boolean)
              .sort();

        return {
          endpoint,

          http_status:
            response.status,

          ok:
            response.ok,

          allow:
            response.headers.get(
              "allow"
            ),

          access_control_allow_methods:
            response.headers.get(
              "access-control-allow-methods"
            ),

          access_control_allow_headers:
            response.headers.get(
              "access-control-allow-headers"
            ),

          normalized_methods:
            normalizeCsv(
              response.headers.get(
                "access-control-allow-methods"
              )
            ),

          normalized_headers:
            normalizeCsv(
              response.headers.get(
                "access-control-allow-headers"
              )
            ),

          has_json_body:
            Boolean(
              payload
            ),

          duration_ms:
            Date.now() -
            startedAt,
        };
      };

    const target =
      await performOptions(
        targetEndpoint
      );

    const control =
      await performOptions(
        controlEndpoint
      );

    const sameStatus =
      target.http_status ===
      control.http_status;

    const sameMethods =
      JSON.stringify(
        target.normalized_methods
      ) ===
      JSON.stringify(
        control.normalized_methods
      );

    const sameHeaders =
      JSON.stringify(
        target.normalized_headers
      ) ===
      JSON.stringify(
        control.normalized_headers
      );

    const looksGlobalCors =
      sameStatus &&
      sameMethods &&
      sameHeaders &&
      target.normalized_methods.length >
        0;

    return {
      success:
        true,

      safe_probe:
        true,

      write_executed:
        false,

      emission_executed:
        false,

      relbase_post_executed:
        false,

      target,

      control,

      comparison: {
        same_http_status:
          sameStatus,

        same_cors_methods:
          sameMethods,

        same_cors_headers:
          sameHeaders,

        looks_like_global_cors:
          looksGlobalCors,
      },

      conclusion:
        looksGlobalCors
          ? "CORS_METHODS_ARE_GLOBAL_HINT_ONLY"
          : "TARGET_DIFFERS_FROM_CONTROL",

      post_route_confirmed:
        false,

      note:
        looksGlobalCors
          ? "El endpoint inexistente recibe la misma política CORS; OPTIONS no confirma que POST /api/v2/dtes exista."
          : "El recurso DTE difiere del endpoint inexistente, lo que entrega una señal adicional, pero todavía no confirma el contrato POST.",
    };
  };

