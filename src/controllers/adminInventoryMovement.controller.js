import {
  previewInventoryMovement,
  registerInventoryMovement,
  getInventoryMovement,
} from '../services/adminInventoryMovement.service.js';

const replyError = (res, error, action) => {
  console.error(`Error ${action}:`, { code: error?.code, status: error?.status, message: error?.message });
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  return res.status(status).json({
    success: false,
    code: error?.code ?? 'INVENTORY_ERROR',
    message: status === 500 ? 'No fue posible procesar el inventario. Revisa el registro de movimientos.' : error.message,
  });
};

export const previewAdminInventoryMovement = async (req, res) => {
  try {
    const data = await previewInventoryMovement({
      productId: req.params.productId,
      warehouseId: req.query.warehouse_id,
    });
    return res.status(200).json({ success: true, ...data });
  } catch (error) { return replyError(res, error, 'consultando previsualización de stock'); }
};

export const createAdminInventoryMovement = async (req, res) => {
  try {
    const movement = await registerInventoryMovement({
      productId: req.params.productId,
      actorId: req.user?.id,
      body: req.body,
    });
    const pending = movement.status !== 'SUCCEEDED';
    return res.status(pending ? 202 : 201).json({
      success: true,
      message: pending ? 'Relbase puede haber confirmado el ajuste, pero la sincronización requiere revisión. No repitas el movimiento.' : 'Movimiento registrado en Relbase y stock local sincronizado.',
      movement,
    });
  } catch (error) { return replyError(res, error, 'registrando movimiento de inventario'); }
};

export const readAdminInventoryMovement = async (req, res) => {
  try {
    const movement = await getInventoryMovement({ productId: req.params.productId, requestId: req.params.requestId });
    return res.status(200).json({ success: true, movement });
  } catch (error) { return replyError(res, error, 'consultando movimiento de inventario'); }
};
