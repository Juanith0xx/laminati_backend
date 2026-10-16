import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { authorizeRoles } from "../middlewares/role.middleware.js";
import {
  getAdminOrderController,
  listAdminOrdersController,
} from "../controllers/orderManagement.controller.js";

const router = Router();
router.use(authenticate, authorizeRoles("ADMIN", "VENDEDOR"));

// Sólo lectura; la cancelación, el pago, el retiro y el DTE mantienen sus flujos.
router.get("/", listAdminOrdersController);
router.get("/:orderId", getAdminOrderController);

export default router;
