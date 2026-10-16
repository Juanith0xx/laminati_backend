import {
  activateStorePickup,
  reissueStorePickupCredential,
  getStorePickupByOrder,
  consumeStorePickupQr,
  revokeStorePickup,
} from "../services/pickup.service.js";


const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


const isValidUuid = (value) =>
  UUID_PATTERN.test(
    String(value || "").trim()
  );


const sendServiceError = (
  res,
  error,
  fallbackMessage
) => {
  return res
    .status(
      error.status ||
      500
    )
    .json({
      success: false,
      message:
        error.message ||
        fallbackMessage,
      code:
        error.code ||
        null,
    });
};


/* =========================================
   ADMIN - ACTIVAR RETIRO / GENERAR QR
========================================= */
export const activateStorePickupController =
  async (req, res) => {
    try {
      const orderId =
        String(
          req.params.orderId || ""
        ).trim();

      if (!isValidUuid(orderId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "orderId no es un UUID válido",
            code:
              "INVALID_ORDER_ID",
          });
      }

      const result =
        await activateStorePickup({
          orderId,
          actorUserId:
            req.user?.id ||
            null,
          actorRole:
            req.user?.role ||
            null,
        });

      return res
        .status(
          result.created
            ? 201
            : 200
        )
        .json({
          success: true,
          message:
            result.already_active
              ? "El retiro ya se encontraba activo; se preservó la misma credencial"
              : result.created
                ? "Retiro en tienda activado correctamente"
                : result.rotated
                  ? "Retiro activado con una nueva credencial"
                  : "Retiro en tienda activado correctamente",
          data: result,
        });
    } catch (error) {
      console.error(
        "Error activando retiro en tienda:",
        {
          message:
            error.message,
          code:
            error.code ||
            null,
        }
      );

      return sendServiceError(
        res,
        error,
        "No fue posible activar el retiro en tienda"
      );
    }
  };


/* =========================================
   CLIENTE / ADMIN - REEMITIR CREDENCIAL
========================================= */
export const reissueStorePickupCredentialController =
  async (req, res) => {
    try {
      const orderId =
        String(
          req.params.orderId || ""
        ).trim();

      if (!isValidUuid(orderId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "orderId no es un UUID válido",
            code:
              "INVALID_ORDER_ID",
          });
      }

      const result =
        await reissueStorePickupCredential({
          orderId,
          requesterUserId:
            req.user?.id ||
            null,
          requesterRole:
            req.user?.role ||
            null,
        });

      return res
        .status(200)
        .json({
          success: true,
          message:
            "Nueva credencial de retiro generada correctamente",
          data: result,
        });
    } catch (error) {
      console.error(
        "Error reemitiendo credencial de retiro:",
        {
          message:
            error.message,
          code:
            error.code ||
            null,
        }
      );

      return sendServiceError(
        res,
        error,
        "No fue posible generar una nueva credencial de retiro"
      );
    }
  };


/* =========================================
   CLIENTE / ADMIN - ESTADO RETIRO
========================================= */
export const getStorePickupController =
  async (req, res) => {
    try {
      const orderId =
        String(
          req.params.orderId || ""
        ).trim();

      if (!isValidUuid(orderId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "orderId no es un UUID válido",
            code:
              "INVALID_ORDER_ID",
          });
      }

      const result =
        await getStorePickupByOrder({
          orderId,
          requesterUserId:
            req.user?.id ||
            null,
          requesterRole:
            req.user?.role ||
            null,
        });

      return res
        .status(200)
        .json({
          success: true,
          data: result,
        });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener el retiro"
      );
    }
  };


/* =========================================
   ESCANEAR QR
========================================= */
export const consumeStorePickupQrController =
  async (req, res) => {
    try {
      const token =
        String(
          req.body?.token || ""
        ).trim();

      if (!token) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "token es obligatorio",
            code:
              "PICKUP_TOKEN_REQUIRED",
          });
      }

      const result =
        await consumeStorePickupQr({
          token,
          scannedBy:
            req.user?.id ||
            null,
          scannerRole:
            req.user?.role ||
            null,
          ipAddress:
            req.ip ||
            req.socket?.remoteAddress ||
            null,
          userAgent:
            req.get("user-agent") ||
            null,
        });

      return res
        .status(200)
        .json({
          success: true,
          message:
            "Retiro confirmado correctamente",
          data: result,
        });
    } catch (error) {
      console.error(
        "Error validando QR de retiro:",
        {
          message:
            error.message,
          code:
            error.code ||
            null,
        }
      );

      return sendServiceError(
        res,
        error,
        "No fue posible validar el código de retiro"
      );
    }
  };


/* =========================================
   ADMIN - REVOCAR RETIRO
========================================= */
export const revokeStorePickupController =
  async (req, res) => {
    try {
      const pickupId =
        String(
          req.params.pickupId || ""
        ).trim();

      if (!isValidUuid(pickupId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "pickupId no es un UUID válido",
            code:
              "INVALID_PICKUP_ID",
          });
      }

      const reason =
        String(
          req.body?.reason || ""
        ).trim();

      const result =
        await revokeStorePickup({
          pickupId,
          revokedBy:
            req.user?.id ||
            null,
          requesterRole:
            req.user?.role ||
            null,
          reason,
        });

      return res
        .status(200)
        .json({
          success: true,
          message:
            result.already_revoked
              ? "El retiro ya se encontraba revocado"
              : "Retiro revocado correctamente",
          data: result,
        });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible revocar el retiro"
      );
    }
  };
