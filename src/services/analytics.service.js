import pool from "../config/database.js";

const ALLOWED_EVENT_TYPES = new Set([
  "PAGE_VIEW",
  "COLLECTION_VIEW",
  "COLLECTION_CLICK",
  "PRODUCT_VIEW",
  "PRODUCT_CLICK",
  "SEARCH",
  "SEARCH_NO_RESULTS",
  "WHATSAPP_CLICK",
  "CONTACT_CLICK",
  "QUOTE_START",
  "QUOTE_CREATED",
  "CHECKOUT_START",
  "ORDER_CREATED",
]);

const cleanText = (value, maxLength = 255) => {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();

  if (!text) {
    return null;
  }

  return text.slice(0, maxLength);
};

const cleanUuid = (value) => {
  const text = cleanText(value, 64);

  if (!text) {
    return null;
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    text
  )
    ? text
    : null;
};

const cleanNumber = (value, min, max) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < min || number > max) {
    return null;
  }

  return number;
};

const normalizeMetadata = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const serialized = JSON.stringify(value);

  // Evita guardar payloads desproporcionados en un evento analítico.
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    return {
      truncated: true,
    };
  }

  return value;
};

const normalizeDays = (value, fallback = 30) => {
  const days = Number(value);

  if (!Number.isInteger(days) || days < 1) {
    return fallback;
  }

  return Math.min(days, 365);
};

export const createAnalyticsEvent = async (payload = {}) => {
  const sessionKey = cleanText(payload.session_key, 100);
  const eventType = cleanText(payload.event_type, 50)?.toUpperCase();

  if (!sessionKey) {
    const error = new Error("session_key es obligatorio");
    error.status = 400;
    throw error;
  }

  if (!eventType || !ALLOWED_EVENT_TYPES.has(eventType)) {
    const error = new Error("event_type no es válido");
    error.status = 400;
    throw error;
  }

  const location =
    payload.location && typeof payload.location === "object"
      ? payload.location
      : {};

  const session = {
    countryCode: cleanText(location.country_code, 10),
    regionCode: cleanText(location.region_code, 30),
    city: cleanText(location.city, 150),
    commune: cleanText(location.commune, 150),
    latitude: cleanNumber(location.latitude, -90, 90),
    longitude: cleanNumber(location.longitude, -180, 180),
    deviceType: cleanText(payload.device_type, 30),
    landingPage: cleanText(payload.landing_page, 2000),
    referrer: cleanText(payload.referrer, 2000),
    utmSource: cleanText(payload.utm_source, 150),
    utmMedium: cleanText(payload.utm_medium, 150),
    utmCampaign: cleanText(payload.utm_campaign, 150),
  };

  const event = {
    pagePath: cleanText(payload.page_path, 2000),
    productId: cleanUuid(payload.product_id),
    productCode: cleanText(payload.product_code, 100),
    collectionSlug: cleanText(payload.collection_slug, 150),
    searchTerm: cleanText(payload.search_term, 500),
    metadata: normalizeMetadata(payload.metadata),
  };

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `
        INSERT INTO analytics_sessions (
          session_key,
          country_code,
          region_code,
          city,
          commune,
          latitude,
          longitude,
          device_type,
          landing_page,
          referrer,
          utm_source,
          utm_medium,
          utm_campaign,
          first_seen_at,
          last_seen_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          NOW(), NOW()
        )
        ON CONFLICT (session_key)
        DO UPDATE SET
          country_code = COALESCE(analytics_sessions.country_code, EXCLUDED.country_code),
          region_code = COALESCE(analytics_sessions.region_code, EXCLUDED.region_code),
          city = COALESCE(analytics_sessions.city, EXCLUDED.city),
          commune = COALESCE(analytics_sessions.commune, EXCLUDED.commune),
          latitude = COALESCE(analytics_sessions.latitude, EXCLUDED.latitude),
          longitude = COALESCE(analytics_sessions.longitude, EXCLUDED.longitude),
          device_type = COALESCE(analytics_sessions.device_type, EXCLUDED.device_type),
          landing_page = COALESCE(analytics_sessions.landing_page, EXCLUDED.landing_page),
          referrer = COALESCE(analytics_sessions.referrer, EXCLUDED.referrer),
          utm_source = COALESCE(analytics_sessions.utm_source, EXCLUDED.utm_source),
          utm_medium = COALESCE(analytics_sessions.utm_medium, EXCLUDED.utm_medium),
          utm_campaign = COALESCE(analytics_sessions.utm_campaign, EXCLUDED.utm_campaign),
          last_seen_at = NOW()
        RETURNING id, session_key
      `,
      [
        sessionKey,
        session.countryCode,
        session.regionCode,
        session.city,
        session.commune,
        session.latitude,
        session.longitude,
        session.deviceType,
        session.landingPage,
        session.referrer,
        session.utmSource,
        session.utmMedium,
        session.utmCampaign,
      ]
    );

    const sessionId = sessionResult.rows[0].id;

    const eventResult = await client.query(
      `
        INSERT INTO analytics_events (
          session_id,
          event_type,
          page_path,
          product_id,
          product_code,
          collection_slug,
          search_term,
          metadata,
          created_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW()
        )
        RETURNING
          id,
          session_id,
          event_type,
          created_at
      `,
      [
        sessionId,
        eventType,
        event.pagePath,
        event.productId,
        event.productCode,
        event.collectionSlug,
        event.searchTerm,
        JSON.stringify(event.metadata),
      ]
    );

    await client.query("COMMIT");

    return {
      session: sessionResult.rows[0],
      event: eventResult.rows[0],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getAnalyticsOverview = async ({ days = 30 } = {}) => {
  const periodDays = normalizeDays(days);

  const [summaryResult, trafficResult] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(DISTINCT s.id)::int AS sessions,
          COUNT(e.id)::int AS total_events,
          COUNT(e.id) FILTER (WHERE e.event_type = 'PAGE_VIEW')::int AS page_views,
          COUNT(e.id) FILTER (WHERE e.event_type = 'PRODUCT_VIEW')::int AS product_views,
          COUNT(e.id) FILTER (WHERE e.event_type = 'PRODUCT_CLICK')::int AS product_clicks,
          COUNT(e.id) FILTER (WHERE e.event_type = 'COLLECTION_VIEW')::int AS collection_views,
          COUNT(e.id) FILTER (WHERE e.event_type = 'COLLECTION_CLICK')::int AS collection_clicks,
          COUNT(e.id) FILTER (WHERE e.event_type = 'SEARCH')::int AS searches,
          COUNT(e.id) FILTER (WHERE e.event_type = 'SEARCH_NO_RESULTS')::int AS searches_no_results,
          COUNT(e.id) FILTER (WHERE e.event_type = 'WHATSAPP_CLICK')::int AS whatsapp_clicks,
          COUNT(e.id) FILTER (WHERE e.event_type = 'QUOTE_START')::int AS quote_starts,
          COUNT(e.id) FILTER (WHERE e.event_type = 'QUOTE_CREATED')::int AS quotes_created,
          COUNT(e.id) FILTER (WHERE e.event_type = 'CHECKOUT_START')::int AS checkout_starts,
          COUNT(e.id) FILTER (WHERE e.event_type = 'ORDER_CREATED')::int AS orders_created
        FROM analytics_sessions s
        LEFT JOIN analytics_events e
          ON e.session_id = s.id
         AND e.created_at >= NOW() - ($1::int * INTERVAL '1 day')
        WHERE s.first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
      `,
      [periodDays]
    ),
    pool.query(
      `
        SELECT
          DATE(created_at AT TIME ZONE 'America/Santiago') AS day,
          COUNT(*) FILTER (WHERE event_type = 'PAGE_VIEW')::int AS page_views,
          COUNT(DISTINCT session_id)::int AS sessions
        FROM analytics_events
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY DATE(created_at AT TIME ZONE 'America/Santiago')
        ORDER BY day ASC
      `,
      [periodDays]
    ),
  ]);

  const summary = summaryResult.rows[0] || {};
  const sessions = Number(summary.sessions || 0);
  const quotesCreated = Number(summary.quotes_created || 0);
  const ordersCreated = Number(summary.orders_created || 0);

  return {
    days: periodDays,
    summary: {
      ...summary,
      conversion_rate:
        sessions > 0
          ? Number(((quotesCreated / sessions) * 100).toFixed(2))
          : 0,
      order_conversion_rate:
        sessions > 0
          ? Number(((ordersCreated / sessions) * 100).toFixed(2))
          : 0,
    },
    traffic: trafficResult.rows,
  };
};

export const getAnalyticsProducts = async ({ days = 30, limit = 20 } = {}) => {
  const periodDays = normalizeDays(days);
  const rowLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const result = await pool.query(
    `
      SELECT
        product_id,
        product_code,
        COUNT(*) FILTER (WHERE event_type = 'PRODUCT_VIEW')::int AS views,
        COUNT(*) FILTER (WHERE event_type = 'PRODUCT_CLICK')::int AS clicks,
        COUNT(*) FILTER (WHERE event_type = 'WHATSAPP_CLICK')::int AS whatsapp_clicks,
        COUNT(DISTINCT session_id)::int AS unique_sessions
      FROM analytics_events
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND product_code IS NOT NULL
        AND event_type IN (
          'PRODUCT_VIEW',
          'PRODUCT_CLICK',
          'WHATSAPP_CLICK'
        )
      GROUP BY product_id, product_code
      ORDER BY views DESC, clicks DESC, product_code ASC
      LIMIT $2
    `,
    [periodDays, rowLimit]
  );

  return {
    days: periodDays,
    items: result.rows,
  };
};

export const getAnalyticsCollections = async ({ days = 30, limit = 20 } = {}) => {
  const periodDays = normalizeDays(days);
  const rowLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const result = await pool.query(
    `
      SELECT
        collection_slug,
        COUNT(*)::int AS interactions,
        COUNT(*) FILTER (WHERE event_type = 'COLLECTION_VIEW')::int AS views,
        COUNT(*) FILTER (WHERE event_type = 'COLLECTION_CLICK')::int AS clicks,
        COUNT(DISTINCT session_id)::int AS unique_sessions
      FROM analytics_events
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND collection_slug IS NOT NULL
      GROUP BY collection_slug
      ORDER BY views DESC, clicks DESC, interactions DESC, collection_slug ASC
      LIMIT $2
    `,
    [periodDays, rowLimit]
  );

  return {
    days: periodDays,
    items: result.rows,
  };
};

export const getAnalyticsLocations = async ({ days = 30, limit = 50 } = {}) => {
  const periodDays = normalizeDays(days);
  const rowLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const result = await pool.query(
    `
      SELECT
        country_code,
        region_code,
        city,
        commune,
        COUNT(*)::int AS sessions
      FROM analytics_sessions
      WHERE first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY
        country_code,
        region_code,
        city,
        commune
      ORDER BY sessions DESC, city ASC NULLS LAST, commune ASC NULLS LAST
      LIMIT $2
    `,
    [periodDays, rowLimit]
  );

  return {
    days: periodDays,
    items: result.rows,
  };
};

export const getAnalyticsSearches = async ({ days = 30, limit = 50 } = {}) => {
  const periodDays = normalizeDays(days);
  const rowLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const result = await pool.query(
    `
      SELECT
        search_term,
        COUNT(*) FILTER (WHERE event_type = 'SEARCH')::int AS searches,
        COUNT(*) FILTER (WHERE event_type = 'SEARCH_NO_RESULTS')::int AS no_results,
        COUNT(DISTINCT session_id)::int AS unique_sessions
      FROM analytics_events
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND search_term IS NOT NULL
        AND event_type IN ('SEARCH', 'SEARCH_NO_RESULTS')
      GROUP BY search_term
      ORDER BY searches DESC, no_results DESC, search_term ASC
      LIMIT $2
    `,
    [periodDays, rowLimit]
  );

  return {
    days: periodDays,
    items: result.rows,
  };
};

export const getAnalyticsSources = async ({ days = 30, limit = 30 } = {}) => {
  const periodDays = normalizeDays(days);
  const rowLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);

  const result = await pool.query(
    `
      SELECT
        COALESCE(NULLIF(utm_source, ''), 'direct') AS source,
        NULLIF(utm_medium, '') AS medium,
        NULLIF(utm_campaign, '') AS campaign,
        COUNT(*)::int AS sessions
      FROM analytics_sessions
      WHERE first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY
        COALESCE(NULLIF(utm_source, ''), 'direct'),
        NULLIF(utm_medium, ''),
        NULLIF(utm_campaign, '')
      ORDER BY sessions DESC, source ASC
      LIMIT $2
    `,
    [periodDays, rowLimit]
  );

  return {
    days: periodDays,
    items: result.rows,
  };
};

export const getAnalyticsDevices = async ({ days = 30 } = {}) => {
  const periodDays = normalizeDays(days);

  const result = await pool.query(
    `
      SELECT
        COALESCE(NULLIF(device_type, ''), 'unknown') AS device_type,
        COUNT(*)::int AS sessions
      FROM analytics_sessions
      WHERE first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY COALESCE(NULLIF(device_type, ''), 'unknown')
      ORDER BY sessions DESC, device_type ASC
    `,
    [periodDays]
  );

  return {
    days: periodDays,
    items: result.rows,
  };
};
