import { Router } from "express";

import {
  cancelQuotationController,
  convertQuotationController,
  createProjectQuotationController,
  createQuotationController,
  deleteQuotationController,
  emailQuotationController,
  getQuotationController,
  getQuotationPdfController,
  getQuotationTrackingController,
  listQuotationsController,
  updateProjectQuotationController,
  updateQuotationController,
} from "../controllers/quotation.controller.js";

const router = Router();

/*
 * Este router se monta dentro de /api/admin/pos
 * después de authenticate + authorizeRoles("ADMIN").
 */
router.get("/", listQuotationsController);
router.post("/", createQuotationController);
router.post(
  "/project",
  createProjectQuotationController
);
router.get("/:quotationId", getQuotationController);
router.patch("/:quotationId", updateQuotationController);
router.patch(
  "/:quotationId/project",
  updateProjectQuotationController
);
router.delete("/:quotationId", deleteQuotationController);
router.get("/:quotationId/pdf", getQuotationPdfController);
router.get(
  "/:quotationId/tracking",
  getQuotationTrackingController
);
router.post("/:quotationId/email", emailQuotationController);
router.patch("/:quotationId/cancel", cancelQuotationController);
router.post("/:quotationId/convert", convertQuotationController);

export default router;
