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

// Tope de sesiones nuevas por origen y ventana, transaccional en PostgreSQL.
// Se aplica solo si Vercel puede enviar una huella diaria HMAC anónima.
const SESSION_WINDOW_LIMIT = Math.min(
  Math.max(Number(process.env.ANALYTICS_MAX_NEW_SESSIONS_PER_10_MIN) || 40, 5),
  10000
);

// Clasificacion conservadora de oleadas en URLs con filtros heredados.
// NO se usa el pais, el User-Agent o dos eventos de forma aislada.
// El umbral exige numerosas sesiones nuevas con el MISMO patron en 30 minutos.
const BOT_BURST_MIN_SESSIONS = Math.min(
  Math.max(Number(process.env.ANALYTICS_BOT_BURST_MIN_SESSIONS) || 12, 10),
  500
);

// Detecta crawling distribuido entre varios países. Se mantiene conservador:
// exige muchas sesiones nuevas, varios países y el mismo patrón facetado.
const DISTRIBUTED_BOT_BURST_MIN_SESSIONS = Math.min(
  Math.max(Number(process.env.ANALYTICS_DISTRIBUTED_BOT_BURST_MIN_SESSIONS) || 20, 12),
  1000
);

const DISTRIBUTED_BOT_BURST_MIN_COUNTRIES = Math.min(
  Math.max(Number(process.env.ANALYTICS_DISTRIBUTED_BOT_BURST_MIN_COUNTRIES) || 4, 3),
  50
);

const isLegacyFacetedCatalogPath = (value) => {
  if (!value || !value.startsWith("/productos/laminados?")) return false;
  try {
    const url = new URL(value, "https://laminati.cl");
    return (
      url.pathname === "/productos/laminados" &&
      (url.searchParams.get("q") || "").length >= 70 &&
      ["order", "productListView", "resultsPerPage"].some((key) =>
        url.searchParams.has(key)
      )
    );
  } catch {
    return false;
  }
};

// Detecta una oleada de sesiones independientes con exactamente PAGE_VIEW y
// COLLECTION_VIEW. Marca exclusivamente el subconjunto que coincide; las
// sesiones normales y las conversiones se conservan. Se ejecuta tras insertar
// cada evento relevante y dentro de la transaccion.
const markSuspiciousLegacyCatalogBurst = async (client, countryCode, threshold) => {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT s.id
       FROM analytics_sessions s
       JOIN analytics_events e ON e.session_id = s.id
       WHERE s.first_seen_at >= NOW() - INTERVAL '30 minutes'
         AND s.country_code = $1
         AND s.device_type = 'desktop'
         AND s.landing_page LIKE '/productos/laminados?%'
         AND s.landing_page ~ '[?&]q='
         AND s.landing_page ~ '[?&](order|productListView|resultsPerPage)='
         AND length(s.landing_page) >= 140
       GROUP BY s.id
       HAVING COUNT(*) = 2
          AND COUNT(*) FILTER (WHERE e.event_type = 'PAGE_VIEW') = 1
          AND COUNT(*) FILTER (WHERE e.event_type = 'COLLECTION_VIEW') = 1
     ), burst AS (
       SELECT COUNT(*) >= $2::integer AS detected FROM candidates
     )
     UPDATE analytics_sessions s
     SET is_suspected_bot = TRUE,
         bot_reason = 'legacy_catalog_burst_30m',
         bot_detected_at = NOW()
     FROM candidates c, burst b
     WHERE b.detected AND s.id = c.id AND s.is_suspected_bot = FALSE
     RETURNING s.id`,
    [countryCode, threshold]
  );
  return result.rowCount;
};


const markSuspiciousDistributedCatalogBurst = async (
  client,
  threshold,
  minCountries
) => {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT s.id, s.country_code
       FROM analytics_sessions s
       JOIN analytics_events e ON e.session_id = s.id
       WHERE s.first_seen_at >= NOW() - INTERVAL '30 minutes'
         AND s.device_type = 'desktop'
         AND s.landing_page LIKE '/productos/laminados?%'
         AND s.landing_page ~ '[?&]q='
         AND s.landing_page ~ '[?&](order|productListView|resultsPerPage|page)='
         AND length(s.landing_page) >= 140
       GROUP BY s.id, s.country_code
       HAVING COUNT(*) = 2
          AND COUNT(*) FILTER (WHERE e.event_type = 'PAGE_VIEW') = 1
          AND COUNT(*) FILTER (WHERE e.event_type = 'COLLECTION_VIEW') = 1
     ), burst AS (
       SELECT
         COUNT(*) >= $1::integer AS enough_sessions,
         COUNT(DISTINCT country_code) >= $2::integer AS enough_countries
       FROM candidates
     )
     UPDATE analytics_sessions s
     SET is_suspected_bot = TRUE,
         bot_reason = 'distributed_faceted_catalog_burst_30m',
         bot_detected_at = NOW()
     FROM candidates c, burst b
     WHERE b.enough_sessions
       AND b.enough_countries
       AND s.id = c.id
       AND s.is_suspected_bot = FALSE
     RETURNING s.id`,
    [threshold, minCountries]
  );

  return result.rowCount;
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

  const visitorHash = cleanText(payload.visitor_hash, 64);
  const validVisitorHash =
    visitorHash && /^[a-f0-9]{64}$/i.test(visitorHash) ? visitorHash : null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Solo contamos sesiones nuevas, no cada evento de una sesión existente.
    // La tabla de límite evita que nuevas sesiones masivas inflen el dashboard.
    if (validVisitorHash) {
      const existing = await client.query(
        "SELECT id FROM analytics_sessions WHERE session_key = $1",
        [sessionKey]
      );
      if (existing.rowCount === 0) {
        const quota = await client.query(
          `INSERT INTO analytics_ingest_limits (
             visitor_hash, window_start, new_sessions, updated_at
           ) VALUES (
             $1, to_timestamp(floor(extract(epoch from now()) / 600) * 600), 1, now()
           )
           ON CONFLICT (visitor_hash, window_start)
           DO UPDATE SET new_sessions = analytics_ingest_limits.new_sessions + 1,
                         updated_at = now()
           WHERE analytics_ingest_limits.new_sessions < $2
           RETURNING new_sessions`,
          [validVisitorHash, SESSION_WINDOW_LIMIT]
        );
        if (quota.rowCount === 0) {
          await client.query("ROLLBACK");
          return { filtered: true, reason: "new_session_rate_limit" };
        }
      }
    }

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

    // Clasificamos despues del segundo evento, sin frenar ventas ni SEO.
    // La ubicacion es una senal de agrupacion, NUNCA criterio unico.
    if (
      session.countryCode &&
      session.deviceType === "desktop" &&
      (eventType === "PAGE_VIEW" || eventType === "COLLECTION_VIEW") &&
      isLegacyFacetedCatalogPath(session.landingPage)
    ) {
      await markSuspiciousLegacyCatalogBurst(
        client,
        session.countryCode,
        BOT_BURST_MIN_SESSIONS
      );

      await markSuspiciousDistributedCatalogBurst(
        client,
        DISTRIBUTED_BOT_BURST_MIN_SESSIONS,
        DISTRIBUTED_BOT_BURST_MIN_COUNTRIES
      );
    }

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

// Todas las metricas excluyen sesiones marcadas como sospechosas; los datos se conservan.
export const getAnalyticsOverview = async ({ days = 30 } = {}) => {
  const periodDays = normalizeDays(days);

  const [summaryResult, trafficResult, audienceResult] = await Promise.all([
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
        JOIN analytics_events e ON e.session_id = s.id
        WHERE e.created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND s.is_suspected_bot = FALSE
      `,
      [periodDays]
    ),
    pool.query(
      `
        SELECT
          DATE(s.first_seen_at AT TIME ZONE 'America/Santiago') AS day,
          COUNT(*) FILTER (WHERE s.is_suspected_bot = FALSE)::int AS sessions,
          COUNT(*) FILTER (WHERE s.is_suspected_bot = FALSE AND s.country_code = 'CL')::int AS chile_sessions,
          COUNT(*) FILTER (WHERE s.is_suspected_bot = FALSE AND COALESCE(s.country_code, '') <> 'CL')::int AS international_sessions,
          COUNT(*) FILTER (WHERE s.is_suspected_bot = TRUE)::int AS suspected_bot_sessions
        FROM analytics_sessions s
        WHERE s.first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY DATE(s.first_seen_at AT TIME ZONE 'America/Santiago')
        ORDER BY day ASC
      `,
      [periodDays]
    ),
    pool.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE is_suspected_bot = FALSE)::int AS human_sessions,
          COUNT(*) FILTER (WHERE is_suspected_bot = FALSE AND country_code = 'CL')::int AS chile_sessions,
          COUNT(*) FILTER (WHERE is_suspected_bot = FALSE AND COALESCE(country_code, '') <> 'CL')::int AS international_sessions,
          COUNT(*) FILTER (WHERE is_suspected_bot = TRUE)::int AS suspected_bot_sessions
        FROM analytics_sessions
        WHERE first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
      `,
      [periodDays]
    ),
  ]);

  const summary = summaryResult.rows[0] || {};
  const audience = audienceResult.rows[0] || {};
  const sessions = Number(summary.sessions || 0);
  const quotesCreated = Number(summary.quotes_created || 0);
  const ordersCreated = Number(summary.orders_created || 0);

  return {
    days: periodDays,
    summary: {
      ...summary,
      conversion_rate: sessions > 0 ? Number(((quotesCreated / sessions) * 100).toFixed(2)) : 0,
      order_conversion_rate: sessions > 0 ? Number(((ordersCreated / sessions) * 100).toFixed(2)) : 0,
    },
    audience,
    traffic: trafficResult.rows,
  };
};

export const getAnalyticsProducts = async ({ days = 30, limit = 20 } = {}) => {
  const periodDays = normalizeDays(days);
  const rowLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const result = await pool.query(
    `
      SELECT
        e.product_id,
        e.product_code,
        COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_VIEW')::int AS views,
        COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_CLICK')::int AS clicks,
        COUNT(*) FILTER (WHERE e.event_type = 'WHATSAPP_CLICK')::int AS whatsapp_clicks,
        COUNT(*) FILTER (
          WHERE e.event_type = 'PRODUCT_CLICK'
            AND NULLIF(TRIM(e.search_term), '') IS NOT NULL
        )::int AS search_clicks,
        COUNT(DISTINCT e.session_id)::int AS unique_sessions,
        (
          COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_VIEW')
          + (COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_CLICK') * 3)
          + (COUNT(*) FILTER (WHERE e.event_type = 'WHATSAPP_CLICK') * 8)
        )::int AS engagement_score
      FROM analytics_events e
      JOIN analytics_sessions s ON s.id = e.session_id
      WHERE e.created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND s.is_suspected_bot = FALSE
        AND e.product_code IS NOT NULL
        AND e.event_type IN (
          'PRODUCT_VIEW',
          'PRODUCT_CLICK',
          'WHATSAPP_CLICK'
        )
      GROUP BY e.product_id, e.product_code
      ORDER BY engagement_score DESC, views DESC, clicks DESC, e.product_code ASC
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
        e.collection_slug,
        COUNT(*)::int AS interactions,
        COUNT(*) FILTER (WHERE e.event_type = 'COLLECTION_VIEW')::int AS views,
        COUNT(*) FILTER (WHERE e.event_type = 'COLLECTION_CLICK')::int AS clicks,
        COUNT(DISTINCT e.session_id)::int AS unique_sessions,
        (
          COUNT(*) FILTER (WHERE e.event_type = 'COLLECTION_VIEW')
          + (COUNT(*) FILTER (WHERE e.event_type = 'COLLECTION_CLICK') * 3)
        )::int AS engagement_score
      FROM analytics_events e
      JOIN analytics_sessions s ON s.id = e.session_id
      WHERE e.created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND s.is_suspected_bot = FALSE
        AND e.collection_slug IS NOT NULL
      GROUP BY e.collection_slug
      ORDER BY engagement_score DESC, views DESC, clicks DESC, interactions DESC, e.collection_slug ASC
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

  const [legacyResult, summaryResult, countriesResult, regionsResult, locationsResult] = await Promise.all([
    pool.query(
      `
        SELECT country_code, region_code, city, commune, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND is_suspected_bot = FALSE
        GROUP BY country_code, region_code, city, commune
        ORDER BY sessions DESC, city ASC NULLS LAST, commune ASC NULLS LAST
        LIMIT $2
      `,
      [periodDays, rowLimit]
    ),
    pool.query(
      `
        SELECT
          COUNT(*)::int AS total_sessions,
          COUNT(*) FILTER (WHERE country_code = 'CL')::int AS chile_sessions,
          COUNT(*) FILTER (WHERE COALESCE(country_code, '') <> 'CL')::int AS international_sessions
        FROM analytics_sessions
        WHERE first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND is_suspected_bot = FALSE
      `,
      [periodDays]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(country_code, ''), 'UNKNOWN') AS country_code, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND is_suspected_bot = FALSE
        GROUP BY COALESCE(NULLIF(country_code, ''), 'UNKNOWN')
        ORDER BY sessions DESC, country_code ASC
        LIMIT $2
      `,
      [periodDays, rowLimit]
    ),
    pool.query(
      `
        SELECT COALESCE(NULLIF(region_code, ''), 'UNKNOWN') AS region_code, COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND is_suspected_bot = FALSE
          AND country_code = 'CL'
        GROUP BY COALESCE(NULLIF(region_code, ''), 'UNKNOWN')
        ORDER BY sessions DESC, region_code ASC
      `,
      [periodDays]
    ),
    pool.query(
      `
        SELECT
          region_code,
          city,
          commune,
          CASE
            WHEN region_code = 'RM' AND city = 'Santiago' AND commune = 'Santiago'
              THEN 'Santiago / ubicación aproximada'
            ELSE COALESCE(NULLIF(commune, ''), NULLIF(city, ''), 'Sin ubicación precisa')
          END AS location_label,
          CASE
            WHEN region_code = 'RM' AND city = 'Santiago' AND commune = 'Santiago' THEN TRUE
            ELSE FALSE
          END AS is_approximate,
          COUNT(*)::int AS sessions
        FROM analytics_sessions
        WHERE first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND is_suspected_bot = FALSE
          AND country_code = 'CL'
        GROUP BY region_code, city, commune
        ORDER BY sessions DESC, location_label ASC
        LIMIT $2
      `,
      [periodDays, rowLimit]
    ),
  ]);

  return {
    days: periodDays,
    summary: summaryResult.rows[0] || { total_sessions: 0, chile_sessions: 0, international_sessions: 0 },
    countries: countriesResult.rows,
    chile_regions: regionsResult.rows,
    chile_locations: locationsResult.rows,
    items: legacyResult.rows,
  };
};

export const getAnalyticsSearches = async ({ days = 30, limit = 50 } = {}) => {
  const periodDays = normalizeDays(days);
  const rowLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const termsResult = await pool.query(
    `
      SELECT
        e.search_term,
        COUNT(*) FILTER (WHERE e.event_type = 'SEARCH')::int AS searches,
        COUNT(*) FILTER (WHERE e.event_type = 'SEARCH_NO_RESULTS')::int AS no_results,
        COUNT(DISTINCT e.session_id)::int AS unique_sessions
      FROM analytics_events e
      JOIN analytics_sessions s ON s.id = e.session_id
      WHERE e.created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND s.is_suspected_bot = FALSE
        AND NULLIF(TRIM(e.search_term), '') IS NOT NULL
        AND e.event_type IN ('SEARCH', 'SEARCH_NO_RESULTS')
      GROUP BY e.search_term
      ORDER BY searches DESC, no_results DESC, e.search_term ASC
      LIMIT $2
    `,
    [periodDays, rowLimit]
  );

  let productLinks = [];

  try {
    const productLinksResult = await pool.query(
      `
        SELECT
          e.search_term,
          e.product_id,
          e.product_code,
          COUNT(*)::int AS clicks,
          COUNT(DISTINCT e.session_id)::int AS unique_sessions
        FROM analytics_events e
        JOIN analytics_sessions s ON s.id = e.session_id
        WHERE e.created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND s.is_suspected_bot = FALSE
          AND e.event_type = 'PRODUCT_CLICK'
          AND NULLIF(TRIM(e.search_term), '') IS NOT NULL
          AND e.product_code IS NOT NULL
        GROUP BY e.search_term, e.product_id, e.product_code
        ORDER BY clicks DESC, unique_sessions DESC, e.search_term ASC
        LIMIT $2
      `,
      [periodDays, Math.min(rowLimit * 5, 500)]
    );

    productLinks = productLinksResult.rows;
  } catch (error) {
    // El cruce busqueda -> producto es complementario. No debe impedir
    // que el dashboard cargue las metricas historicas de busquedas.
    console.error('[analytics] product_links search query failed:', error?.message || error);
  }

  return {
    days: periodDays,
    items: termsResult.rows,
    product_links: productLinks,
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
        AND is_suspected_bot = FALSE
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
        AND is_suspected_bot = FALSE
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


export const getAnalyticsVisitors = async ({ days = 30, limit = 50 } = {}) => {
  const periodDays = normalizeDays(days);
  const rowLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const result = await pool.query(
    `
      SELECT
        s.id AS session_id,
        CONCAT('#', UPPER(LEFT(REPLACE(s.session_key, '-', ''), 8))) AS visitor_label,
        s.country_code,
        s.region_code,
        s.city,
        s.commune,
        s.device_type,
        s.landing_page,
        s.referrer,
        s.first_seen_at,
        s.last_seen_at,
        COUNT(e.id)::int AS events,
        COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_VIEW')::int AS product_views,
        COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_CLICK')::int AS product_clicks,
        COUNT(*) FILTER (WHERE e.event_type = 'SEARCH')::int AS searches,
        COUNT(*) FILTER (WHERE e.event_type = 'WHATSAPP_CLICK')::int AS whatsapp_clicks,
        COUNT(DISTINCT e.product_code) FILTER (
          WHERE e.product_code IS NOT NULL
            AND e.event_type IN ('PRODUCT_VIEW', 'PRODUCT_CLICK', 'WHATSAPP_CLICK')
        )::int AS unique_products,
        COALESCE(
          ARRAY_AGG(DISTINCT e.product_code) FILTER (
            WHERE e.event_type = 'PRODUCT_CLICK'
              AND NULLIF(TRIM(e.product_code), '') IS NOT NULL
          ),
          ARRAY[]::varchar[]
        ) AS clicked_products,
        COALESCE(
          ARRAY_AGG(DISTINCT e.search_term) FILTER (
            WHERE e.event_type = 'SEARCH'
              AND NULLIF(TRIM(e.search_term), '') IS NOT NULL
          ),
          ARRAY[]::text[]
        ) AS search_terms,
        (
          COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_VIEW')
          + (COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_CLICK') * 3)
          + (COUNT(*) FILTER (WHERE e.event_type = 'SEARCH') * 2)
          + (COUNT(*) FILTER (WHERE e.event_type = 'WHATSAPP_CLICK') * 8)
        )::int AS engagement_score
      FROM analytics_sessions s
      LEFT JOIN analytics_events e
        ON e.session_id = s.id
       AND e.created_at >= NOW() - ($1::int * INTERVAL '1 day')
      WHERE s.first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND s.is_suspected_bot = FALSE
      GROUP BY
        s.id,
        s.session_key,
        s.country_code,
        s.region_code,
        s.city,
        s.commune,
        s.device_type,
        s.landing_page,
        s.referrer,
        s.first_seen_at,
        s.last_seen_at
      HAVING COUNT(*) FILTER (
        WHERE e.event_type IN ('PRODUCT_VIEW', 'PRODUCT_CLICK', 'SEARCH', 'WHATSAPP_CLICK')
      ) > 0
      ORDER BY engagement_score DESC, product_clicks DESC, s.last_seen_at DESC
      LIMIT $2
    `,
    [periodDays, rowLimit]
  );

  return {
    days: periodDays,
    items: result.rows,
  };
};

export const getAnalyticsVisitorDetail = async ({ sessionId, days = 30 } = {}) => {
  const periodDays = normalizeDays(days);
  const normalizedSessionId = cleanUuid(sessionId);

  if (!normalizedSessionId) {
    const error = new Error('Sesión de Analytics inválida');
    error.statusCode = 400;
    throw error;
  }

  const [sessionResult, eventsResult, productsResult] = await Promise.all([
    pool.query(
      `
        SELECT
          s.id AS session_id,
          CONCAT('#', UPPER(LEFT(REPLACE(s.session_key, '-', ''), 8))) AS visitor_label,
          s.country_code,
          s.region_code,
          s.city,
          s.commune,
          s.device_type,
          s.landing_page,
          s.referrer,
          s.utm_source,
          s.utm_medium,
          s.utm_campaign,
          s.first_seen_at,
          s.last_seen_at
        FROM analytics_sessions s
        WHERE s.id = $1
          AND s.is_suspected_bot = FALSE
          AND s.first_seen_at >= NOW() - ($2::int * INTERVAL '1 day')
        LIMIT 1
      `,
      [normalizedSessionId, periodDays]
    ),
    pool.query(
      `
        SELECT
          e.id,
          e.event_type,
          e.page_path,
          e.product_id,
          e.product_code,
          e.collection_slug,
          e.search_term,
          e.metadata,
          e.created_at
        FROM analytics_events e
        JOIN analytics_sessions s ON s.id = e.session_id
        WHERE e.session_id = $1
          AND e.created_at >= NOW() - ($2::int * INTERVAL '1 day')
          AND s.is_suspected_bot = FALSE
        ORDER BY e.created_at ASC
        LIMIT 250
      `,
      [normalizedSessionId, periodDays]
    ),
    pool.query(
      `
        SELECT
          e.product_code,
          COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_VIEW')::int AS views,
          COUNT(*) FILTER (WHERE e.event_type = 'PRODUCT_CLICK')::int AS clicks,
          COUNT(*) FILTER (WHERE e.event_type = 'WHATSAPP_CLICK')::int AS whatsapp_clicks,
          MAX(e.created_at) AS last_interaction_at
        FROM analytics_events e
        JOIN analytics_sessions s ON s.id = e.session_id
        WHERE e.session_id = $1
          AND e.created_at >= NOW() - ($2::int * INTERVAL '1 day')
          AND s.is_suspected_bot = FALSE
          AND NULLIF(TRIM(e.product_code), '') IS NOT NULL
          AND e.event_type IN ('PRODUCT_VIEW', 'PRODUCT_CLICK', 'WHATSAPP_CLICK')
        GROUP BY e.product_code
        ORDER BY clicks DESC, views DESC, whatsapp_clicks DESC, last_interaction_at DESC
      `,
      [normalizedSessionId, periodDays]
    ),
  ]);

  if (!sessionResult.rows[0]) {
    const error = new Error('Sesión de Analytics no encontrada');
    error.statusCode = 404;
    throw error;
  }

  return {
    days: periodDays,
    session: sessionResult.rows[0],
    products: productsResult.rows,
    events: eventsResult.rows,
  };
};
