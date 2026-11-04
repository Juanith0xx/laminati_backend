import crypto from "crypto";
import { Router } from "express";

import {
  createAnalyticsEventController,
} from "../controllers/analytics.controller.js";

const router = Router();

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const requireAnalyticsIngestSecret = (req, res, next) => {
  const configuredSecret = process.env.ANALYTICS_INGEST_SECRET;

  if (!configuredSecret) {
    return res.status(503).json({
      success: false,
      message: "Analytics no está configurado",
    });
  }

  const receivedSecret = req.get("x-analytics-secret");

  if (!receivedSecret || !safeEqual(receivedSecret, configuredSecret)) {
    return res.status(401).json({
      success: false,
      message: "No autorizado",
    });
  }

  return next();
};

router.post(
  "/events",
  requireAnalyticsIngestSecret,
  createAnalyticsEventController
);

export default router;
