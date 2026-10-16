import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { authorizeRoles } from "../middlewares/role.middleware.js";
import {
  getAdminSalesDashboard,
  getAdminDashboardFilterOptions,
} from "../controllers/dashboard.controller.js";

const router = Router();

// Todas las consultas de ventas requieren sesión y rol ADMIN.
router.use(authenticate, authorizeRoles("ADMIN", "VENDEDOR"));

// GET /api/admin/dashboard/sales
router.get("/sales", getAdminSalesDashboard);
router.get("/filter-options", getAdminDashboardFilterOptions);

export default router;
