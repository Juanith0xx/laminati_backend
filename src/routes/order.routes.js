import { Router } from "express";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

import {
  cancelOrderController,
  createWebOrderController,
  getOrderController,
  listOrdersController,
} from "../controllers/order.controller.js";

const router = Router();

router.use(authenticate);

router.post(
  "/",
  createWebOrderController
);

router.get(
  "/",
  listOrdersController
);

router.get(
  "/:orderId",
  getOrderController
);

router.post(
  "/:orderId/cancel",
  cancelOrderController
);

export default router;
