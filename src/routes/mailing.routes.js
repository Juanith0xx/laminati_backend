import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { authorizeRoles } from "../middlewares/role.middleware.js";
import {
  getMailingSummaryController,
  listMailingContactsController,
  createMailingContactController,
  updateMailingContactController,
  listMailingSegmentsController,
  createMailingSegmentController,
  listMailingTemplatesController,
  createMailingTemplateController,
  listMailingCampaignsController,
  createMailingCampaignController,
  listMailingSuppressionsController,
  createMailingSuppressionController,
} from "../controllers/mailing.controller.js";

const router = Router();
router.use(authenticate, authorizeRoles("ADMIN"));

router.get("/summary", getMailingSummaryController);
router.get("/contacts", listMailingContactsController);
router.post("/contacts", createMailingContactController);
router.patch("/contacts/:contactId", updateMailingContactController);
router.get("/segments", listMailingSegmentsController);
router.post("/segments", createMailingSegmentController);
router.get("/templates", listMailingTemplatesController);
router.post("/templates", createMailingTemplateController);
router.get("/campaigns", listMailingCampaignsController);
router.post("/campaigns", createMailingCampaignController);
router.get("/suppressions", listMailingSuppressionsController);
router.post("/suppressions", createMailingSuppressionController);

export default router;
