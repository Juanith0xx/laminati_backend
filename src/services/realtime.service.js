import { Server } from "socket.io";

import pool from "../config/database.js";
import { corsOptions } from "../config/cors.js";
import { verifyToken } from "../utils/jwt.js";
import {
  getAuthTokenFromSocket,
} from "../utils/authCookie.js";
import {
  createAdminNotification,
} from "./adminNotifications.service.js";

const ADMIN_ROOM = "ADMIN";
const BACKOFFICE_ROOM = "BACKOFFICE";

const REALTIME_ALLOWED_ROLES = new Set([
  "ADMIN",
  "VENDEDOR",
]);

let io = null;

const normalizeText = (value) =>
  String(value ?? "").trim();

const getAdminUserFromToken = async (
  token
) => {
  if (!token) {
    const error =
      new Error(
        "Autenticación requerida"
      );

    error.data = {
      code:
        "REALTIME_AUTH_REQUIRED",
    };

    throw error;
  }

  const decoded =
    verifyToken(token);

  const result =
    await pool.query(
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
        LIMIT 1
      `,
      [decoded.sub]
    );

  if (
    result.rowCount === 0
  ) {
    const error =
      new Error(
        "Usuario no válido"
      );

    error.data = {
      code:
        "REALTIME_USER_NOT_FOUND",
    };

    throw error;
  }

  const user =
    result.rows[0];

  if (
    user.is_active !== true
  ) {
    const error =
      new Error(
        "La cuenta se encuentra deshabilitada"
      );

    error.data = {
      code:
        "REALTIME_USER_DISABLED",
    };

    throw error;
  }

  const normalizedRole =
    String(
      user.role || ""
    )
      .trim()
      .toUpperCase();

  if (
    !REALTIME_ALLOWED_ROLES.has(
      normalizedRole
    )
  ) {
    const error =
      new Error(
        "Acceso backoffice requerido"
      );

    error.data = {
      code:
        "REALTIME_BACKOFFICE_REQUIRED",
    };

    throw error;
  }

  user.role =
    normalizedRole;

  return user;
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
      cors:
        corsOptions,

      transports: [
        "websocket",
        "polling",
      ],

      pingInterval:
        25000,

      pingTimeout:
        20000,
    }
  );

  io.use(
    async (
      socket,
      next
    ) => {
      try {
        const token =
          getAuthTokenFromSocket(
            socket
          );

        const user =
          await getAdminUserFromToken(
            token
          );

        socket.data.user =
          user;

        return next();
      } catch (error) {
        return next(
          error
        );
      }
    }
  );

  io.on(
    "connection",
    (socket) => {
      const role =
        String(
          socket.data
            ?.user?.role ||
            ""
        )
          .trim()
          .toUpperCase();

      socket.join(
        BACKOFFICE_ROOM
      );

      if (
        role === "ADMIN"
      ) {
        socket.join(
          ADMIN_ROOM
        );
      }

      socket.emit(
        "admin:realtime:ready",
        {
          success: true,

          user: {
            id:
              socket.data
                ?.user?.id ||
              null,

            role:
              socket.data
                ?.user?.role ||
              null,
          },
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