import {
  listAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
} from "../services/adminNotifications.service.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sendError = (
  res,
  error,
  fallbackMessage
) => {
  const status =
    Number(
      error?.status
    ) || 500;

  if (
    status >= 500
  ) {
    console.error(
      "Error en notificaciones administrativas:",
      {
        message:
          error?.message,

        code:
          error?.code ||
          null,
      }
    );
  }

  return res
    .status(status)
    .json({
      success: false,

      code:
        error?.code ||
        "ADMIN_NOTIFICATION_ERROR",

      message:
        status < 500
          ? error?.message ||
            fallbackMessage
          : fallbackMessage,
    });
};

export const listAdminNotificationsController =
  async (
    req,
    res
  ) => {
    try {
      const result =
        await listAdminNotifications({
          userId:
            req.user.id,

          page:
            req.query.page,

          limit:
            req.query.limit,

          search:
            req.query.search,

          type:
            req.query.type,

          readStatus:
            req.query.read_status,
        });

      return res
        .status(200)
        .json({
          success: true,
          ...result,
        });
    } catch (error) {
      return sendError(
        res,
        error,
        "No fue posible cargar las notificaciones"
      );
    }
  };

export const markAdminNotificationReadController =
  async (
    req,
    res
  ) => {
    try {
      const notificationId =
        String(
          req.params
            .notificationId ||
            ""
        ).trim();

      if (
        !UUID_RE.test(
          notificationId
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            code:
              "ADMIN_NOTIFICATION_INVALID_ID",
            message:
              "Notificación inválida",
          });
      }

      const result =
        await markAdminNotificationRead({
          notificationId,

          userId:
            req.user.id,
        });

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Notificación marcada como leída",

          data:
            result,
        });
    } catch (error) {
      return sendError(
        res,
        error,
        "No fue posible actualizar la notificación"
      );
    }
  };

export const markAllAdminNotificationsReadController =
  async (
    req,
    res
  ) => {
    try {
      const result =
        await markAllAdminNotificationsRead({
          userId:
            req.user.id,
        });

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Notificaciones marcadas como leídas",

          data:
            result,
        });
    } catch (error) {
      return sendError(
        res,
        error,
        "No fue posible actualizar las notificaciones"
      );
    }
  };
