import { Router } from "express";

import {
  getProducts,
  getProductSearchSuggestions,
  getProductBySlug,
  getCustomerProductPrice,
} from "../controllers/products.controller.js";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/", getProducts);

/* =========================================
   AUTOCOMPLETADO DE PRODUCTOS
========================================= */

router.get(
  "/search/suggestions",
  getProductSearchSuggestions
);

/* =========================================
   PRECIO PERSONALIZADO DEL CLIENTE
   - Requiere JWT
   - No altera las rutas públicas
========================================= */

router.get(
  "/pricing/:productId",
  authenticate,
  getCustomerProductPrice
);

router.get("/:slug", getProductBySlug);

export default router;