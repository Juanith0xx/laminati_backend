import { Router } from "express";

import {
  getCatalogFilters,
  getCatalogNavigation,
} from "../controllers/catalog.controller.js";

const router = Router();

router.get(
  "/filters",
  getCatalogFilters
);

router.get(
  "/navigation",
  getCatalogNavigation
);

export default router;
