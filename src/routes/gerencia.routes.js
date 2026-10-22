import {
  Router,
} from "express";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

import {
  authorizeRoles,
} from "../middlewares/role.middleware.js";

import {
  getGerenciaProjectQuotationDetail,
  getGerenciaProjectQuotations,
  getGerenciaSaleDetail,
  getGerenciaSales,
  getGerenciaStock,
  getGerenciaSummary,
} from "../controllers/gerencia.controller.js";

const router =
  Router();

/* =========================================
   GERENCIA ITALIA

   Todos los endpoints de este router son
   de sólo lectura y requieren el rol exacto
   GERENCIA_ITALIA.
========================================= */
router.use(
  authenticate,
  authorizeRoles(
    "GERENCIA_ITALIA"
  )
);

/* =========================================
   RESUMEN GERENCIA ITALIA
========================================= */
router.get(
  "/resumen",
  getGerenciaSummary
);

/* =========================================
   STOCK DISTRIBUCIÓN CHILE
========================================= */
router.get(
  "/stock",
  getGerenciaStock
);

/* =========================================
   VENTAS DISTRIBUCIÓN CHILE
========================================= */
router.get(
  "/ventas",
  getGerenciaSales
);

router.get(
  "/ventas/:orderId",
  getGerenciaSaleDetail
);

/* =========================================
   COTIZACIONES PROYECTOS CHILE
========================================= */
router.get(
  "/cotizaciones-proyectos",
  getGerenciaProjectQuotations
);

router.get(
  "/cotizaciones-proyectos/:quotationId",
  getGerenciaProjectQuotationDetail
);

export default router;
