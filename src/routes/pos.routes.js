import { Router } from "express";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

import {
  authorizeRoles,
} from "../middlewares/role.middleware.js";

import quotationRoutes from "./quotation.routes.js";

import {
  createPosSaleController,
  getPosSaleController,
  listPosProductsController,
  ensurePosInvoiceCustomerController,
} from "../controllers/pos.controller.js";

const router = Router();

/*
 * Paso 90 inicial:
 * sólo ADMIN opera caja.
 * Más adelante se puede agregar un rol POS/CAJERO
 * sin cambiar el contrato de estos endpoints.
 */
router.use(
  authenticate,
  authorizeRoles("ADMIN", "VENDEDOR")
);

router.get(
  "/products",
  listPosProductsController
);

router.use(
  "/quotations",
  quotationRoutes
);

router.post(
  "/customers/ensure",
  ensurePosInvoiceCustomerController
);

router.post(
  "/sales",
  createPosSaleController
);

router.get(
  "/sales/:orderId",
  getPosSaleController
);

export default router;
