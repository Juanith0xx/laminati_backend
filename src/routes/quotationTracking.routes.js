import { Router } from "express";

import {
  quotationEmailOpenController,
  quotationViewController,
} from "../controllers/quotationTracking.controller.js";

const router = Router();

router.get(
  "/email/open/:token",
  quotationEmailOpenController
);

router.get(
  "/view/:token",
  quotationViewController
);

export default router;
