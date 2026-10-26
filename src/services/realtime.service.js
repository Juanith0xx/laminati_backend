import { Server } from "socket.io";

import pool from "../config/database.js";
import { corsOptions } from "../config/cors.js";
import {
  verifyToken,
  verifyRealtimeToken,
} from "../utils/jwt.js";
import {
  getAuthTokenFromSocket,
} from "../utils/authCookie.js";
import {
  createAdminNotification,
} from "./adminNotifications.service.js";

const ADMIN_ROOM = "ADMIN";
const BACKOFFICE_ROOM = "BACKOFFICE";

/*
 * Todos los usuarios autenticados pueden mantener una conexión realtime
 * para presencia. Sólo los perfiles internos entran a las salas que
 * reciben eventos administrativos.
 */
const BACKOFFICE_ROLES = new Set([
  "ADMIN",
  "VENDEDOR",
]);

let io = null;

/*
 * userId -> Map(socketId -> sesión activa)
 */
const activeSessionsByUser = new Map();

/*
 * userId -> última sesión desconectada.
 * Se conserva sólo una por usuario para poder mostrar "última actividad"
 * sin acumular sockets antiguos en memoria.
 */
const lastDisconnectedByUser = new Map();

const normalizeText = (value) =>
  String(value ?? "").trim();

const normalizeRole = (value) =>
  normalizeText(value).toUpperCase();

const getRealtimeUserFromToken = async (
  token
) => {
  if (!token) {
    const error = new Error(
      "Autenticación requerida"
    );

    error.data = {
      code: "REALTIME_AUTH_REQUIRED",
    };

    throw error;
  }

  let decoded;

  try {
    /*
     * Producción Vercel -> Railway utiliza un token
     * efímero exclusivo para realtime.
     */
    decoded = verifyRealtimeToken(
      token
    );
  } catch (realtimeError) {
    /*
     * Compatibilidad con desarrollo local y sesiones
     * antiguas que todavía entreguen el JWT principal.
     */
    decoded = verifyToken(token);
  }

  const result = await pool.query(
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
        AND u.deleted_at IS NULL
      LIMIT 1
    `,
    [decoded.sub]
  );

  if (result.rowCount === 0) {
    const error = new Error(
      "Usuario no válido"
    );

    error.data = {
      code: "REALTIME_USER_NOT_FOUND",
    };

    throw error;
  }

  const user = result.rows[0];

  if (user.is_active !== true) {
    const error = new Error(
      "La cuenta se encuentra deshabilitada"
    );

    error.data = {
      code: "REALTIME_USER_DISABLED",
    };

    throw error;
  }

  user.role = normalizeRole(user.role);

  return user;
};

const detectBrowser = (userAgent) => {
  const ua = normalizeText(userAgent);

  const candidates = [
    [/Edg\/([\d.]+)/i, "Edge"],
    [/Firefox\/([\d.]+)/i, "Firefox"],
    [/OPR\/([\d.]+)/i, "Opera"],
    [/Chrome\/([\d.]+)/i, "Chrome"],
    [/Version\/([\d.]+).*Safari/i, "Safari"],
  ];

  for (const [pattern, name] of candidates) {
    const match = ua.match(pattern);
    if (match) {
      return {
        name,
        version: match[1] || null,
      };
    }
  }

  return {
    name: "Desconocido",
    version: null,
  };
};

const detectPlatform = (userAgent) => {
  const ua = normalizeText(userAgent);

  if (/Windows NT/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";

  return "Desconocido";
};

const detectDeviceType = (userAgent) => {
  const ua = normalizeText(userAgent);

  if (/iPad|Tablet/i.test(ua)) {
    return "Tablet";
  }

  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) {
    return "Tablet";
  }

  if (/Mobi|Android|iPhone|iPod/i.test(ua)) {
    return "Móvil";
  }

  return "Desktop";
};

const buildClientInfo = (socket) => {
  const userAgent = normalizeText(
    socket.handshake?.headers?.["user-agent"]
  );

  const browser = detectBrowser(userAgent);

  return {
    device_type: detectDeviceType(userAgent),
    platform: detectPlatform(userAgent),
    browser: browser.name,
    browser_version: browser.version,
    user_agent: userAgent || null,
  };
};

const getActiveSessionMap = (userId) => {
  const key = String(userId);

  if (!activeSessionsByUser.has(key)) {
    activeSessionsByUser.set(
      key,
      new Map()
    );
  }

  return activeSessionsByUser.get(key);
};

const serializeSession = (session) => ({
  connected_at: session.connected_at,
  last_seen_at: session.last_seen_at,
  device_type: session.device_type,
  platform: session.platform,
  browser: session.browser,
  browser_version: session.browser_version,
});

export const getUserPresence = (userId) => {
  const key = String(userId || "");
  const sessionsMap = activeSessionsByUser.get(key);
  const sessions = sessionsMap
    ? [...sessionsMap.values()]
    : [];

  if (sessions.length > 0) {
    const orderedByConnected = [...sessions].sort(
      (a, b) =>
        new Date(a.connected_at).getTime() -
        new Date(b.connected_at).getTime()
    );

    const orderedBySeen = [...sessions].sort(
      (a, b) =>
        new Date(b.last_seen_at).getTime() -
        new Date(a.last_seen_at).getTime()
    );

    const firstSession = orderedByConnected[0];
    const currentSession = orderedBySeen[0];

    return {
      is_online: true,
      connected_at: firstSession?.connected_at || null,
      last_seen_at: currentSession?.last_seen_at || null,
      disconnected_at: null,
      active_sessions: sessions.length,
      device_type: currentSession?.device_type || null,
      platform: currentSession?.platform || null,
      browser: currentSession?.browser || null,
      browser_version: currentSession?.browser_version || null,
      sessions: orderedByConnected.map(serializeSession),
    };
  }

  const lastSession = lastDisconnectedByUser.get(key) || null;

  return {
    is_online: false,
    connected_at: null,
    last_seen_at: lastSession?.last_seen_at || null,
    disconnected_at: lastSession?.disconnected_at || null,
    active_sessions: 0,
    device_type: lastSession?.device_type || null,
    platform: lastSession?.platform || null,
    browser: lastSession?.browser || null,
    browser_version: lastSession?.browser_version || null,
    sessions: [],
  };
};

export const getPresenceForUsers = (
  userIds = []
) => {
  const result = {};

  for (const userId of userIds) {
    const key = String(userId || "");
    if (!key) continue;
    result[key] = getUserPresence(key);
  }

  return result;
};

export const getOnlineUserCount = () => {
  let total = 0;

  for (const sessions of activeSessionsByUser.values()) {
    if (sessions.size > 0) {
      total += 1;
    }
  }

  return total;
};

const emitPresenceUpdate = (userId) => {
  if (!io || !userId) {
    return;
  }

  io.to(ADMIN_ROOM).emit(
    "presence:update",
    {
      user_id: String(userId),
      presence: getUserPresence(userId),
      updated_at: new Date().toISOString(),
    }
  );
};

const registerPresence = (socket) => {
  const userId = normalizeText(
    socket.data?.user?.id
  );

  if (!userId) {
    return;
  }

  const now = new Date().toISOString();
  const clientInfo = buildClientInfo(socket);
  const sessions = getActiveSessionMap(userId);

  const session = {
    socket_id: socket.id,
    user_id: userId,
    connected_at: now,
    last_seen_at: now,
    disconnected_at: null,
    ...clientInfo,
  };

  sessions.set(socket.id, session);
  socket.data.presenceUserId = userId;

  emitPresenceUpdate(userId);
};

const touchPresence = (socket) => {
  const userId = normalizeText(
    socket.data?.presenceUserId ||
      socket.data?.user?.id
  );

  if (!userId) {
    return;
  }

  const sessions = activeSessionsByUser.get(userId);
  const session = sessions?.get(socket.id);

  if (!session) {
    return;
  }

  session.last_seen_at = new Date().toISOString();
};

const unregisterPresence = (
  socket,
  reason = null
) => {
  const userId = normalizeText(
    socket.data?.presenceUserId ||
      socket.data?.user?.id
  );

  if (!userId) {
    return;
  }

  const sessions = activeSessionsByUser.get(userId);
  const session = sessions?.get(socket.id);

  if (session) {
    const now = new Date().toISOString();

    lastDisconnectedByUser.set(
      userId,
      {
        ...session,
        last_seen_at: now,
        disconnected_at: now,
        disconnect_reason:
          normalizeText(reason) || null,
      }
    );

    sessions.delete(socket.id);
  }

  if (sessions && sessions.size === 0) {
    activeSessionsByUser.delete(userId);
  }

  emitPresenceUpdate(userId);
};

export const initializeRealtimeServer = (
  httpServer
) => {
  if (io) {
    return io;
  }

  io = new Server(
    httpServer,
    {
      cors: corsOptions,
      transports: [
        "websocket",
        "polling",
      ],
      pingInterval: 25000,
      pingTimeout: 20000,
    }
  );

  io.use(
    async (socket, next) => {
      try {
        const token = getAuthTokenFromSocket(socket);
        const user = await getRealtimeUserFromToken(token);

        socket.data.user = user;
        return next();
      } catch (error) {
        return next(error);
      }
    }
  );

  io.on(
    "connection",
    (socket) => {
      const user = socket.data?.user || {};
      const userId = normalizeText(user.id);
      const role = normalizeRole(user.role);

      if (userId) {
        socket.join(`USER:${userId}`);
      }

      if (BACKOFFICE_ROLES.has(role)) {
        socket.join(BACKOFFICE_ROOM);
      }

      if (role === "ADMIN") {
        socket.join(ADMIN_ROOM);
      }

      registerPresence(socket);

      socket.emit(
        "presence:ready",
        {
          success: true,
          user: {
            id: userId || null,
            role: role || null,
          },
          presence: userId
            ? getUserPresence(userId)
            : null,
        }
      );

      /* Compatibilidad con el frontend actual del backoffice. */
      if (BACKOFFICE_ROLES.has(role)) {
        socket.emit(
          "admin:realtime:ready",
          {
            success: true,
            user: {
              id: userId || null,
              role: role || null,
            },
          }
        );
      }

      socket.on(
        "presence:heartbeat",
        () => {
          touchPresence(socket);
        }
      );

      socket.on(
        "disconnect",
        (reason) => {
          unregisterPresence(
            socket,
            reason
          );
        }
      );
    }
  );

  return io;
};

export const emitAdminNotification = (
  notification = {}
) => {
  const persistAndEmit =
    async () => {
      const savedNotification =
        await createAdminNotification(
          notification
        );

      if (
        !savedNotification
      ) {
        return null;
      }

      const payload = {
        ...savedNotification,

        data:
          savedNotification.data &&
          typeof savedNotification.data ===
            "object"
            ? savedNotification.data
            : {},
      };

      if (io) {
        io.to(
          BACKOFFICE_ROOM
        ).emit(
          "admin:notification",
          payload
        );
      }

      return payload;
    };

  return persistAndEmit()
    .catch(
      (error) => {
        console.error(
          "No fue posible persistir / emitir la notificación ADMIN:",
          {
            type:
              notification?.type ||
              null,

            message:
              error?.message ||
              "Error desconocido",
          }
        );

        /*
         * Una falla de notificación NO debe
         * invalidar el contacto o pedido que
         * ya fue creado correctamente.
         */
        return null;
      }
    );
};

/* =========================================
   TRACKING DE COTIZACIONES EN TIEMPO REAL

   Este evento NO crea una notificación
   persistente. Su objetivo es avisar al
   backoffice para que refresque los datos
   visibles sin recargar la página.
========================================= */

export const emitQuotationTrackingUpdated = (
  payload = {}
) => {
  const quotationId =
    normalizeText(
      payload.quotation_id
    );

  if (!quotationId) {
    return false;
  }

  const eventPayload = {
    quotation_id:
      quotationId,

    email_message_id:
      normalizeText(
        payload.email_message_id
      ) || null,

    event_type:
      normalizeText(
        payload.event_type
      ).toUpperCase() ||
      "UPDATED",

    event_at:
      payload.event_at ||
      new Date()
        .toISOString(),

    open_count:
      Number.isFinite(
        Number(
          payload.open_count
        )
      )
        ? Number(
            payload.open_count
          )
        : null,

    view_count:
      Number.isFinite(
        Number(
          payload.view_count
        )
      )
        ? Number(
            payload.view_count
          )
        : null,
  };

  if (io) {
    io.to(
      BACKOFFICE_ROOM
    ).emit(
      "quotation:tracking-updated",
      eventPayload
    );
  }

  return true;
};

/* =========================================
   DOCUMENTOS TRIBUTARIOS EN TIEMPO REAL
   Evento efímero para actualizar el backoffice.
   No crea una notificación persistente.
========================================= */

export const emitTaxDocumentUpdated = (
  payload = {}
) => {
  const orderId =
    normalizeText(
      payload.order_id
    );

  const taxDocumentId =
    normalizeText(
      payload.tax_document_id
    );

  if (
    !orderId &&
    !taxDocumentId
  ) {
    return false;
  }

  const eventPayload = {
    job_id:
      normalizeText(
        payload.job_id
      ) || null,

    order_id:
      orderId || null,

    tax_document_id:
      taxDocumentId || null,

    job_status:
      normalizeText(
        payload.job_status
      ).toUpperCase() ||
      null,

    event_type:
      normalizeText(
        payload.event_type
      ).toUpperCase() ||
      "UPDATED",

    attempts:
      Number.isFinite(
        Number(
          payload.attempts
        )
      )
        ? Number(
            payload.attempts
          )
        : null,

    tax_document:
      payload.tax_document &&
      typeof payload.tax_document ===
        "object"
        ? payload.tax_document
        : null,

    timings:
      payload.timings &&
      typeof payload.timings ===
        "object"
        ? payload.timings
        : null,

    error:
      payload.error &&
      typeof payload.error ===
        "object"
        ? payload.error
        : null,

    event_at:
      new Date()
        .toISOString(),
  };

  if (io) {
    io.to(
      ADMIN_ROOM
    ).emit(
      "tax-document:updated",
      eventPayload
    );
  }

  return true;
};