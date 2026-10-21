import crypto from "node:crypto";

import pool from "../config/database.js";
import {
  emitAdminNotification,
  emitQuotationTrackingUpdated,
} from "./realtime.service.js";

const cleanText = (value) => String(value ?? "").trim();

const createTrackingError = (
  message,
  status = 400,
  code = "QUOTATION_TRACKING_ERROR"
) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

const isUuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanText(value)
  );

const requireUuid = (value, label) => {
  const normalized = cleanText(value);

  if (!isUuid(normalized)) {
    throw createTrackingError(
      `${label} no posee un UUID válido`,
      400,
      "QUOTATION_TRACKING_INVALID_UUID"
    );
  }

  return normalized;
};

const generateToken = () =>
  crypto.randomBytes(32).toString("hex");

const hashToken = (token) =>
  crypto
    .createHash("sha256")
    .update(String(token))
    .digest("hex");

const hashIp = (ipAddress) => {
  const ip = cleanText(ipAddress);
  const salt = cleanText(
    process.env.TRACKING_IP_HASH_SALT
  );

  if (!ip || !salt) {
    return null;
  }

  return crypto
    .createHmac("sha256", salt)
    .update(ip)
    .digest("hex");
};

const normalizePublicBaseUrl = (
  value,
  {
    addHttpsWhenMissing = false,
  } = {}
) => {
  let normalized =
    cleanText(
      value
    );

  if (
    !normalized
  ) {
    return "";
  }

  if (
    addHttpsWhenMissing &&
    !/^https?:\/\//i.test(
      normalized
    )
  ) {
    normalized =
      `https://${normalized}`;
  }

  if (
    !/^https?:\/\//i.test(
      normalized
    )
  ) {
    return "";
  }

  try {
    const url =
      new URL(
        normalized
      );

    /*
     * La base pública debe ser sólo el origen.
     * Las rutas /api/public/... se agregan más abajo.
     */
    return url.origin.replace(
      /\/+$/,
      ""
    );
  } catch {
    return "";
  }
};

const isTemporaryTunnelUrl = (
  value
) => {
  if (
    !value
  ) {
    return false;
  }

  try {
    const hostname =
      new URL(
        value
      )
        .hostname
        .toLowerCase();

    return (
      hostname.includes(
        "ngrok"
      ) ||
      hostname.includes(
        "loca.lt"
      ) ||
      hostname.includes(
        "localtunnel"
      )
    );
  } catch {
    return false;
  }
};

const getPublicBaseUrl = () => {
  const isProduction =
    String(
      process.env.NODE_ENV ||
        ""
    )
      .trim()
      .toLowerCase() ===
    "production";

  const configuredBaseUrl =
    normalizePublicBaseUrl(
      process.env
        .EMAIL_PUBLIC_BASE_URL
    );

  /*
   * Railway expone normalmente el dominio público
   * sin protocolo. Lo convertimos a HTTPS.
   */
  const railwayBaseUrl =
    normalizePublicBaseUrl(
      process.env
        .RAILWAY_PUBLIC_DOMAIN,
      {
        addHttpsWhenMissing:
          true,
      }
    );

  /*
   * En desarrollo seguimos permitiendo ngrok para
   * pruebas locales.
   */
  if (
    !isProduction
  ) {
    if (
      configuredBaseUrl
    ) {
      return configuredBaseUrl;
    }

    if (
      railwayBaseUrl
    ) {
      return railwayBaseUrl;
    }

    throw createTrackingError(
      "Configura EMAIL_PUBLIC_BASE_URL para generar enlaces públicos de cotización",
      500,
      "QUOTATION_TRACKING_BASE_URL_MISSING"
    );
  }

  /*
   * Producción:
   * - nunca usar ngrok/localtunnel;
   * - si EMAIL_PUBLIC_BASE_URL es permanente, tiene prioridad;
   * - si quedó un ngrok antiguo, usamos automáticamente
   *   RAILWAY_PUBLIC_DOMAIN.
   */
  if (
    configuredBaseUrl &&
    !isTemporaryTunnelUrl(
      configuredBaseUrl
    )
  ) {
    if (
      !/^https:\/\//i.test(
        configuredBaseUrl
      )
    ) {
      throw createTrackingError(
        "EMAIL_PUBLIC_BASE_URL debe usar HTTPS en producción",
        500,
        "QUOTATION_TRACKING_HTTPS_REQUIRED"
      );
    }

    return configuredBaseUrl;
  }

  if (
    railwayBaseUrl
  ) {
    return railwayBaseUrl;
  }

  if (
    configuredBaseUrl &&
    isTemporaryTunnelUrl(
      configuredBaseUrl
    )
  ) {
    throw createTrackingError(
      "EMAIL_PUBLIC_BASE_URL apunta a un túnel temporal. En producción configura la URL permanente de Railway.",
      500,
      "QUOTATION_TRACKING_TEMPORARY_URL_FORBIDDEN"
    );
  }

  throw createTrackingError(
    "No existe una URL pública permanente para el tracking. Configura EMAIL_PUBLIC_BASE_URL o RAILWAY_PUBLIC_DOMAIN.",
    500,
    "QUOTATION_TRACKING_BASE_URL_MISSING"
  );
};

const getAccessTokenDays = () => {
  const value = Number.parseInt(
    String(
      process.env.QUOTATION_ACCESS_TOKEN_DAYS ||
        "60"
    ),
    10
  );

  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 365
  ) {
    return 60;
  }

  return value;
};


const getQuotationViewNotificationCooldownMinutes =
  () => {
    const value =
      Number.parseInt(
        String(
          process.env
            .QUOTATION_VIEW_NOTIFICATION_COOLDOWN_MINUTES ||
            "30"
        ),
        10
      );

    if (
      !Number.isInteger(
        value
      ) ||
      value < 1 ||
      value > 1440
    ) {
      return 30;
    }

    return value;
  };


const shouldCreateQuotationViewNotification =
  async ({
    quotationId,
  }) => {
    const cooldownMinutes =
      getQuotationViewNotificationCooldownMinutes();

    const result =
      await pool.query(
        `
          SELECT
            id
          FROM public.admin_notifications
          WHERE type = 'QUOTATION_VIEWED'
            AND entity_id = $1
            AND created_at >=
              NOW() -
              ($2::int * INTERVAL '1 minute')
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [
          quotationId,
          cooldownMinutes,
        ]
      );

    return (
      result.rowCount ===
      0
    );
  };

export const createQuotationTracking = async ({
  quotationId,
  recipientEmail,
  subject,
}) => {
  const quotationIdNormalized = requireUuid(
    quotationId,
    "quotationId"
  );

  const recipient = cleanText(
    recipientEmail
  ).toLowerCase();

  const normalizedSubject = cleanText(subject);

  if (!recipient) {
    throw createTrackingError(
      "El destinatario es obligatorio",
      400,
      "QUOTATION_TRACKING_EMAIL_REQUIRED"
    );
  }

  if (!normalizedSubject) {
    throw createTrackingError(
      "El asunto es obligatorio",
      400,
      "QUOTATION_TRACKING_SUBJECT_REQUIRED"
    );
  }

  const publicBaseUrl = getPublicBaseUrl();
  const openToken = generateToken();
  const accessToken = generateToken();
  const openTokenHash = hashToken(openToken);
  const accessTokenHash = hashToken(accessToken);
  const accessTokenDays = getAccessTokenDays();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const emailResult = await client.query(
      `
        INSERT INTO quotation_email_messages (
          quotation_id,
          recipient_email,
          subject,
          provider,
          status,
          open_token_hash
        )
        VALUES (
          $1,
          $2,
          $3,
          'smtp',
          'PENDING',
          $4
        )
        RETURNING *
      `,
      [
        quotationIdNormalized,
        recipient,
        normalizedSubject,
        openTokenHash,
      ]
    );

    const emailMessage = emailResult.rows[0];

    const tokenResult = await client.query(
      `
        INSERT INTO quotation_access_tokens (
          quotation_id,
          email_message_id,
          token_hash,
          recipient_email,
          expires_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          NOW() + ($5::int * INTERVAL '1 day')
        )
        RETURNING *
      `,
      [
        quotationIdNormalized,
        emailMessage.id,
        accessTokenHash,
        recipient,
        accessTokenDays,
      ]
    );

    await client.query("COMMIT");

    return {
      email_message_id: emailMessage.id,
      access_token_id: tokenResult.rows[0].id,
      open_pixel_url:
        `${publicBaseUrl}` +
        "/api/public/quotation-tracking/email/open/" +
        `${encodeURIComponent(openToken)}`,
      quotation_url:
        `${publicBaseUrl}` +
        "/api/public/quotation-tracking/view/" +
        `${encodeURIComponent(accessToken)}`,
      expires_at: tokenResult.rows[0].expires_at,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // noop
    }

    throw error;
  } finally {
    client.release();
  }
};

export const markQuotationEmailSent = async ({
  emailMessageId,
  providerMessageId = null,
  providerResponse = null,
}) => {
  const id = requireUuid(
    emailMessageId,
    "emailMessageId"
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        UPDATE quotation_email_messages
        SET
          status = 'SENT',
          provider_message_id = $2,
          sent_at = COALESCE(sent_at, NOW()),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        cleanText(providerMessageId) || null,
      ]
    );

    if (result.rowCount === 0) {
      throw createTrackingError(
        "No se encontró el registro de correo",
        404,
        "QUOTATION_EMAIL_MESSAGE_NOT_FOUND"
      );
    }

    await client.query(
      `
        INSERT INTO quotation_email_events (
          email_message_id,
          event_type,
          metadata
        )
        VALUES (
          $1,
          'SENT',
          $2::jsonb
        )
      `,
      [
        id,
        JSON.stringify({
          provider: "smtp",
          response: providerResponse || null,
        }),
      ]
    );

    await client.query("COMMIT");

    return result.rows[0];
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // noop
    }

    throw error;
  } finally {
    client.release();
  }
};

export const markQuotationEmailFailed = async ({
  emailMessageId,
  error,
}) => {
  const id = requireUuid(
    emailMessageId,
    "emailMessageId"
  );

  const errorMessage =
    cleanText(error?.message) || "Error desconocido";

  const errorCode = cleanText(error?.code) || null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        UPDATE quotation_email_messages
        SET
          status = 'FAILED',
          failed_at = NOW(),
          last_error = $2,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [id, errorMessage]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `
        INSERT INTO quotation_email_events (
          email_message_id,
          event_type,
          metadata
        )
        VALUES (
          $1,
          'FAILED',
          $2::jsonb
        )
      `,
      [
        id,
        JSON.stringify({
          code: errorCode,
          message: errorMessage,
        }),
      ]
    );

    await client.query("COMMIT");

    return result.rows[0];
  } catch (trackingError) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // noop
    }

    throw trackingError;
  } finally {
    client.release();
  }
};

export const registerQuotationEmailOpen = async ({
  token,
  userAgent = null,
  ipAddress = null,
}) => {
  const rawToken = cleanText(token);

  if (!rawToken) {
    return { found: false };
  }

  const tokenHash = hashToken(rawToken);
  const ipHash = hashIp(ipAddress);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const messageResult = await client.query(
      `
        SELECT
          id,
          quotation_id,
          status
        FROM quotation_email_messages
        WHERE open_token_hash = $1
        FOR UPDATE
      `,
      [tokenHash]
    );

    if (messageResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { found: false };
    }

    const message = messageResult.rows[0];

    await client.query(
      `
        UPDATE quotation_email_messages
        SET
          status = CASE
            WHEN status IN (
              'PENDING',
              'SENT',
              'DELIVERED',
              'OPENED'
            ) THEN 'OPENED'
            ELSE status
          END,
          first_opened_at = COALESCE(
            first_opened_at,
            NOW()
          ),
          last_opened_at = NOW(),
          open_count = open_count + 1,
          updated_at = NOW()
        WHERE id = $1
      `,
      [message.id]
    );

    await client.query(
      `
        INSERT INTO quotation_email_events (
          email_message_id,
          event_type,
          user_agent,
          ip_hash,
          metadata
        )
        VALUES (
          $1,
          'OPENED',
          $2,
          $3,
          $4::jsonb
        )
      `,
      [
        message.id,
        cleanText(userAgent) || null,
        ipHash,
        JSON.stringify({
          source: "tracking_pixel",
        }),
      ]
    );

    await client.query("COMMIT");

    emitQuotationTrackingUpdated({
      quotation_id:
        message.quotation_id,

      email_message_id:
        message.id,

      event_type:
        "OPENED",

      event_at:
        new Date()
          .toISOString(),
    });

    return {
      found: true,
      email_message_id: message.id,
      quotation_id: message.quotation_id,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // noop
    }

    throw error;
  } finally {
    client.release();
  }
};

export const registerQuotationView = async ({
  token,
  userAgent = null,
  ipAddress = null,
}) => {
  const rawToken = cleanText(token);

  if (!rawToken) {
    return { found: false };
  }

  const tokenHash = hashToken(rawToken);
  const ipHash = hashIp(ipAddress);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tokenResult = await client.query(
      `
        SELECT
          qat.id,
          qat.quotation_id,
          qat.email_message_id,
          qat.expires_at,
          qat.revoked_at,

          q.quote_number,

          COALESCE(
            NULLIF(
              BTRIM(
                q.legal_name
              ),
              ''
            ),
            q.customer_name
          ) AS customer_name

        FROM quotation_access_tokens qat

        INNER JOIN quotations q
          ON q.id = qat.quotation_id

        WHERE qat.token_hash = $1
          AND qat.revoked_at IS NULL
          AND (
            qat.expires_at IS NULL
            OR qat.expires_at > NOW()
          )
        FOR UPDATE OF qat
      `,
      [tokenHash]
    );

    if (tokenResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { found: false };
    }

    const accessToken = tokenResult.rows[0];

    const tokenUpdateResult =
      await client.query(
        `
          UPDATE quotation_access_tokens
          SET
            first_used_at = COALESCE(
              first_used_at,
              NOW()
            ),
            last_used_at = NOW(),
            view_count = view_count + 1,
            updated_at = NOW()
          WHERE id = $1
          RETURNING
            first_used_at,
            last_used_at,
            view_count
        `,
        [
          accessToken.id,
        ]
      );

    const updatedAccessToken =
      tokenUpdateResult.rows[0];

    const viewCount =
      Number(
        updatedAccessToken
          ?.view_count ||
          0
      );

    if (accessToken.email_message_id) {
      await client.query(
        `
          INSERT INTO quotation_email_events (
            email_message_id,
            event_type,
            user_agent,
            ip_hash,
            metadata
          )
          VALUES (
            $1,
            'CLICKED',
            $2,
            $3,
            $4::jsonb
          )
        `,
        [
          accessToken.email_message_id,
          cleanText(userAgent) || null,
          ipHash,
          JSON.stringify({
            source: "quotation_link",
          }),
        ]
      );
    }

    const eventResult = await client.query(
      `
        INSERT INTO quotation_access_events (
          access_token_id,
          quotation_id,
          email_message_id,
          event_type,
          user_agent,
          ip_hash,
          metadata
        )
        VALUES (
          $1,
          $2,
          $3,
          'VIEWED',
          $4,
          $5,
          $6::jsonb
        )
        RETURNING *
      `,
      [
        accessToken.id,
        accessToken.quotation_id,
        accessToken.email_message_id,
        cleanText(userAgent) || null,
        ipHash,
        JSON.stringify({
          source: "quotation_link",
        }),
      ]
    );

    await client.query("COMMIT");

    const viewEvent =
      eventResult.rows[0];

    /*
     * Todas las visualizaciones actualizan
     * el backoffice en tiempo real.
     */
    emitQuotationTrackingUpdated({
      quotation_id:
        accessToken
          .quotation_id,

      email_message_id:
        accessToken
          .email_message_id,

      event_type:
        "VIEWED",

      event_at:
        viewEvent
          ?.event_at ||
        new Date()
          .toISOString(),

      view_count:
        viewCount,
    });

    /*
     * El centro de notificaciones no debe
     * llenarse con múltiples aperturas
     * consecutivas del mismo cliente.
     *
     * La primera visualización notifica y
     * luego se aplica un cooldown, por
     * defecto de 30 minutos.
     */
    try {
      const shouldNotify =
        await shouldCreateQuotationViewNotification({
          quotationId:
            accessToken
              .quotation_id,
        });

      if (
        shouldNotify
      ) {
        await emitAdminNotification({
          type:
            "QUOTATION_VIEWED",

          title:
            "Cotización visualizada",

          message:
            `${accessToken.customer_name} visualizó ${accessToken.quote_number}.`,

          entity_id:
            accessToken
              .quotation_id,

          href:
            `/admin/showroom/cotizaciones/${accessToken.quotation_id}`,

          data: {
            quotation_id:
              accessToken
                .quotation_id,

            quote_number:
              accessToken
                .quote_number,

            customer_name:
              accessToken
                .customer_name,

            email_message_id:
              accessToken
                .email_message_id,

            event_type:
              "VIEWED",

            event_at:
              viewEvent
                ?.event_at ||
              new Date()
                .toISOString(),

            view_count:
              viewCount,
          },
        });
      }
    } catch (
      notificationError
    ) {
      /*
       * El tracking y el PDF no deben fallar
       * si falla únicamente la notificación
       * administrativa.
       */
      console.error(
        "No fue posible crear la notificación de visualización de cotización:",
        {
          quotation_id:
            accessToken
              .quotation_id,

          message:
            notificationError
              ?.message ||
            "Error desconocido",
        }
      );
    }

    return {
      found: true,
      quotation_id: accessToken.quotation_id,
      email_message_id: accessToken.email_message_id,
      access_token_id: accessToken.id,
      event: viewEvent,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // noop
    }

    throw error;
  } finally {
    client.release();
  }
};

/* =========================================
   TRACKING ADMINISTRATIVO DE COTIZACIÓN
========================================= */

export const getQuotationTracking = async ({
  quotationId,
}) => {
  const id = requireUuid(
    quotationId,
    "quotationId"
  );

  const quotationResult = await pool.query(
    `
      SELECT
        id,
        quote_number,
        customer_name,
        rut,
        email,
        status,
        sent_at,
        created_at
      FROM quotations
      WHERE id = $1
      LIMIT 1
    `,
    [id]
  );

  if (quotationResult.rowCount === 0) {
    throw createTrackingError(
      "Cotización no encontrada",
      404,
      "QUOTATION_NOT_FOUND"
    );
  }

  const summaryResult = await pool.query(
    `
      SELECT
        COUNT(DISTINCT qem.id)::int AS send_count,

        MIN(qem.sent_at)
          FILTER (
            WHERE qem.sent_at IS NOT NULL
          ) AS first_sent_at,

        MAX(qem.sent_at) AS last_sent_at,

        MIN(qem.first_opened_at)
          FILTER (
            WHERE qem.first_opened_at IS NOT NULL
          ) AS first_opened_at,

        MAX(qem.last_opened_at) AS last_opened_at,

        COALESCE(
          SUM(qem.open_count),
          0
        )::int AS open_count,

        MIN(qat.first_used_at)
          FILTER (
            WHERE qat.first_used_at IS NOT NULL
          ) AS first_viewed_at,

        MAX(qat.last_used_at) AS last_viewed_at,

        COALESCE(
          SUM(qat.view_count),
          0
        )::int AS view_count,

        COUNT(DISTINCT
          CASE
            WHEN qae.event_type = 'VIEWED'
            THEN CONCAT(
              COALESCE(qae.ip_hash, ''),
              '|',
              COALESCE(qae.user_agent, '')
            )
            ELSE NULL
          END
        )::int AS distinct_view_environments

      FROM quotation_email_messages qem

      LEFT JOIN quotation_access_tokens qat
        ON qat.email_message_id = qem.id

      LEFT JOIN quotation_access_events qae
        ON qae.email_message_id = qem.id
       AND qae.event_type = 'VIEWED'

      WHERE qem.quotation_id = $1
    `,
    [id]
  );

  /*
   * SUM(view_count) no debe multiplicarse por la cantidad
   * de quotation_access_events. Lo calculamos aparte para
   * conservar el valor exacto de los contadores.
   */
  const countersResult = await pool.query(
    `
      SELECT
        COALESCE(
          (
            SELECT SUM(open_count)::int
            FROM quotation_email_messages
            WHERE quotation_id = $1
          ),
          0
        ) AS open_count,

        COALESCE(
          (
            SELECT SUM(view_count)::int
            FROM quotation_access_tokens
            WHERE quotation_id = $1
          ),
          0
        ) AS view_count,

        (
          SELECT MIN(first_used_at)
          FROM quotation_access_tokens
          WHERE quotation_id = $1
            AND first_used_at IS NOT NULL
        ) AS first_viewed_at,

        (
          SELECT MAX(last_used_at)
          FROM quotation_access_tokens
          WHERE quotation_id = $1
        ) AS last_viewed_at
    `,
    [id]
  );

  const sendsResult = await pool.query(
    `
      SELECT
        qem.id,
        qem.recipient_email,
        qem.subject,
        qem.provider,
        qem.provider_message_id,
        qem.status,
        qem.sent_at,
        qem.delivered_at,
        qem.first_opened_at,
        qem.last_opened_at,
        qem.open_count,
        qem.bounced_at,
        qem.failed_at,
        qem.last_error,
        qem.created_at,

        qat.id AS access_token_id,
        qat.expires_at,
        qat.revoked_at,
        qat.first_used_at,
        qat.last_used_at,
        qat.view_count

      FROM quotation_email_messages qem

      LEFT JOIN quotation_access_tokens qat
        ON qat.email_message_id = qem.id

      WHERE qem.quotation_id = $1

      ORDER BY qem.created_at DESC
    `,
    [id]
  );

  const timelineResult = await pool.query(
    `
      SELECT
        source,
        event_type,
        event_at,
        email_message_id,
        user_agent,
        ip_hash,
        metadata
      FROM (
        SELECT
          'EMAIL'::text AS source,
          qee.event_type,
          qee.event_at,
          qee.email_message_id,
          qee.user_agent,
          qee.ip_hash,
          qee.metadata

        FROM quotation_email_events qee

        INNER JOIN quotation_email_messages qem
          ON qem.id = qee.email_message_id

        WHERE qem.quotation_id = $1

        UNION ALL

        SELECT
          'QUOTATION'::text AS source,
          qae.event_type,
          qae.event_at,
          qae.email_message_id,
          qae.user_agent,
          qae.ip_hash,
          qae.metadata

        FROM quotation_access_events qae

        WHERE qae.quotation_id = $1
      ) activity

      ORDER BY event_at DESC
    `,
    [id]
  );

  const rawSummary =
    summaryResult.rows[0] || {};

  const counters =
    countersResult.rows[0] || {};

  return {
    quotation:
      quotationResult.rows[0],

    summary: {
      send_count:
        Number(
          rawSummary.send_count || 0
        ),

      first_sent_at:
        rawSummary.first_sent_at ||
        null,

      last_sent_at:
        rawSummary.last_sent_at ||
        null,

      first_opened_at:
        rawSummary.first_opened_at ||
        null,

      last_opened_at:
        rawSummary.last_opened_at ||
        null,

      open_count:
        Number(
          counters.open_count || 0
        ),

      first_viewed_at:
        counters.first_viewed_at ||
        null,

      last_viewed_at:
        counters.last_viewed_at ||
        null,

      view_count:
        Number(
          counters.view_count || 0
        ),

      distinct_view_environments:
        Number(
          rawSummary
            .distinct_view_environments ||
            0
        ),

      has_detected_open:
        Number(
          counters.open_count || 0
        ) > 0,

      has_been_viewed:
        Number(
          counters.view_count || 0
        ) > 0,
    },

    sends:
      sendsResult.rows,

    timeline:
      timelineResult.rows,
  };
};
