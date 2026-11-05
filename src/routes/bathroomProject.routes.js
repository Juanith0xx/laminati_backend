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
  getBathroomOptimizerHealthController,
  optimizeBathroomProjectController,
} from "../controllers/bathroomProject.controller.js";

const router =
  Router();

/*
 * La API key del optimizador jamás llega
 * al navegador. Sólo Laminatiword backend
 * conoce CUT_OPTIMIZER_API_KEY.
 */
router.use(
  authenticate,
  authorizeRoles(
    "ADMIN",
    "VENDEDOR"
  )
);

router.get(
  "/optimizer/health",
  getBathroomOptimizerHealthController
);

router.post(
  "/optimize",
  optimizeBathroomProjectController
);

export default router;
