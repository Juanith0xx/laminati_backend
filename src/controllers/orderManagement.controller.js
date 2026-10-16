import {
  listAdminOrders,
  normalizeOrderManagementFilters,
} from "../services/orderManagement.service.js";
import { getOrderById } from "../services/order.service.js";

function sendError(res, error, action) {
  if (error.status && error.status < 500) {
    return res.status(error.status).json({
      success: false,
      code: error.code || "ORDER_MANAGEMENT_ERROR",
      message: error.message,
    });
  }
  console.error(`Error en gestión administrativa de pedidos (${action}):`, {
    message: error?.message,
    code: error?.code,
  });
  return res.status(500).json({
    success: false,
    message: "No fue posible consultar los pedidos",
  });
}

export async function listAdminOrdersController(req, res) {
  try {
    const filters = normalizeOrderManagementFilters(req.query);
    const data = await listAdminOrders(filters);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return sendError(res, error, "list");
  }
}

export async function getAdminOrderController(req, res) {
  try {
    const data = await getOrderById({
      orderId: req.params.orderId,
      requesterUserId: req.user?.id,
      requesterRole: "ADMIN", // Ya autorizado por middleware en el router.
    });
    if (!new Set(["WEB", "STORE"]).has(data.order.source)) {
      return res.status(404).json({ success: false, message: "Pedido no encontrado en estos canales" });
    }
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return sendError(res, error, "detail");
  }
}
