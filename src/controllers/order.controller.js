import {
  cancelOrder,
  createWebOrder,
  getOrderById,
  listOrders,
} from "../services/order.service.js";
import {
  emitAdminNotification,
} from "../services/realtime.service.js";

const sendServiceError = (
  res,
  error,
  fallbackMessage
) => {
  const status = Number(error?.status) || 500;

  return res.status(status).json({
    success: false,
    message:
      error?.message || fallbackMessage,
    code:
      error?.code || "ORDER_INTERNAL_ERROR",
  });
};

export const createWebOrderController =
  async (req, res) => {
    try {
      const result = await createWebOrder({
        requesterUser: req.user,
        payload: req.body,
      });

      if (
        result?.created ===
          true &&
        result?.order?.id
      ) {
        const order =
          result.order;

        emitAdminNotification({
          type:
            "ORDER_NEW",

          title:
            "Nuevo pedido online",

          message:
            `${order.order_number} · ${
              order.customer_name ||
              order.email ||
              "Cliente web"
            }`,

          entity_id:
            order.id,

          href:
            `/admin/pedidos/${order.id}`,

          created_at:
            order.created_at,

          data: {
            order_id:
              order.id,

            order_number:
              order.order_number,

            customer_name:
              order.customer_name,

            total:
              Number(
                order.total
              ) || 0,

            currency:
              order.currency ||
              "CLP",

            source:
              order.source ||
              "WEB",

            payment_status:
              order.payment_status ||
              null,
          },
        });
      }

      return res
        .status(result.created ? 201 : 200)
        .json({
          success: true,
          message: result.created
            ? "Orden creada correctamente"
            : "La orden ya había sido creada",
          data: result,
        });
    } catch (error) {
      console.error(
        "Error creando orden web:",
        {
          message: error?.message,
          code: error?.code || null,
          status: error?.status || null,
        }
      );

      return sendServiceError(
        res,
        error,
        "No fue posible crear la orden"
      );
    }
  };

export const listOrdersController =
  async (req, res) => {
    try {
      const result = await listOrders({
        requesterUserId: req.user.id,
        requesterRole: req.user.role,
        query: req.query,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener las órdenes"
      );
    }
  };

export const getOrderController =
  async (req, res) => {
    try {
      const result = await getOrderById({
        orderId: req.params.orderId,
        requesterUserId: req.user.id,
        requesterRole: req.user.role,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible obtener la orden"
      );
    }
  };

export const cancelOrderController =
  async (req, res) => {
    try {
      const result = await cancelOrder({
        orderId: req.params.orderId,
        requesterUserId: req.user.id,
        requesterRole: req.user.role,
      });

      return res.status(200).json({
        success: true,
        message: result.already_cancelled
          ? "La orden ya estaba cancelada"
          : "Orden cancelada correctamente",
        data: result,
      });
    } catch (error) {
      return sendServiceError(
        res,
        error,
        "No fue posible cancelar la orden"
      );
    }
  };