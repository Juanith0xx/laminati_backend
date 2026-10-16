import { Router } from "express";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

import {
  authorizeRoles,
} from "../middlewares/role.middleware.js";

import {
  activateStorePickupController,
  reissueStorePickupCredentialController,
  getStorePickupController,
  consumeStorePickupQrController,
  revokeStorePickupController,
} from "../controllers/pickup.controller.js";


const router = Router();


/* =========================================
   TODAS LAS RUTAS REQUIEREN JWT
========================================= */
router.use(
  authenticate
);


/* =========================================
   CLIENTE / ADMIN
========================================= */
router.get(
  "/orders/:orderId",
  getStorePickupController
);


router.post(
  "/orders/:orderId/credential",
  reissueStorePickupCredentialController
);


/* =========================================
   ESCÁNER

   Sólo authenticate aquí a propósito:
   pickup.service.js valida el rol y registra
   UNAUTHORIZED en store_pickup_scan_logs.

   ADMIN y VENDEDOR pueden confirmar entregas.
   pickup.service.js valida el rol y registra
   intentos no autorizados en el log de escaneo.
========================================= */
router.post(
  "/scan",
  consumeStorePickupQrController
);


/* =========================================
   ADMIN
========================================= */
router.post(
  "/admin/orders/:orderId/activate",
  authorizeRoles(
    "ADMIN",
    "VENDEDOR"
  ),
  activateStorePickupController
);


router.patch(
  "/admin/:pickupId/revoke",
  authorizeRoles("ADMIN"),
  revokeStorePickupController
);


export default router;
