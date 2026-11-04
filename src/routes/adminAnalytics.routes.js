import { Router } from "express";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

import {
  authorizeRoles,
} from "../middlewares/role.middleware.js";

import {
  getAnalyticsOverviewController,
  getAnalyticsProductsController,
  getAnalyticsCollectionsController,
  getAnalyticsLocationsController,
  getAnalyticsSearchesController,
  getAnalyticsSourcesController,
  getAnalyticsDevicesController,
} from "../controllers/analytics.controller.js";

const router = Router();

router.use(
  authenticate,
  authorizeRoles("ADMIN")
);

router.get(
  "/overview",
  getAnalyticsOverviewController
);

router.get(
  "/products",
  getAnalyticsProductsController
);

router.get(
  "/collections",
  getAnalyticsCollectionsController
);

router.get(
  "/locations",
  getAnalyticsLocationsController
);

router.get(
  "/searches",
  getAnalyticsSearchesController
);

router.get(
  "/sources",
  getAnalyticsSourcesController
);

router.get(
  "/devices",
  getAnalyticsDevicesController
);

export default router;
