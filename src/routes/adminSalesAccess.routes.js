import { Router } from "express";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

import {
  authorizeRoles,
} from "../middlewares/role.middleware.js";

import {
  listAdminContacts,
  updateAdminContactStatus,
  listAdminContactReplies,
  sendAdminContactReply,
} from "../controllers/adminContacts.controller.js";

import {
  listAdminNotificationsController,
  markAdminNotificationReadController,
  markAllAdminNotificationsReadController,
} from "../controllers/adminNotifications.controller.js";

import {
  listAdminTaxDocumentsController,
  sendTaxDocumentEmailController,
} from "../controllers/taxDocument.controller.js";

import {
  getRelbaseDtePdf,
  getRelbaseDtePrintData,
  getRelbaseCustomers,
  searchRelbaseCustomers,
  findRelbaseCustomerByRut,
  ensureRelbaseCustomerController,
  getRelbaseCities,
} from "../controllers/relbase.controller.js";

const router = Router();

router.use(
  authenticate,
  authorizeRoles("ADMIN", "VENDEDOR")
);

/* CONTACTOS */
router.get("/contacts", listAdminContacts);
router.patch(
  "/contacts/:messageId/status",
  updateAdminContactStatus
);
router.get(
  "/contacts/:messageId/replies",
  listAdminContactReplies
);
router.post(
  "/contacts/:messageId/replies",
  sendAdminContactReply
);

/* NOTIFICACIONES */
router.get(
  "/notifications",
  listAdminNotificationsController
);
router.patch(
  "/notifications/:notificationId/read",
  markAdminNotificationReadController
);
router.post(
  "/notifications/read-all",
  markAllAdminNotificationsReadController
);

/* CLIENTES RELBASE: acceso comercial ADMIN + VENDEDOR */
router.get(
  "/integrations/relbase/customers",
  getRelbaseCustomers
);
router.get(
  "/integrations/relbase/customers/lookup",
  searchRelbaseCustomers
);
router.get(
  "/integrations/relbase/customers/search",
  findRelbaseCustomerByRut
);
router.post(
  "/integrations/relbase/customers/ensure",
  ensureRelbaseCustomerController
);
router.get(
  "/integrations/relbase/cities",
  getRelbaseCities
);

/* PAGOS Y DOCUMENTOS: lectura / entrega */
router.get(
  "/tax-documents",
  listAdminTaxDocumentsController
);
router.post(
  "/tax-documents/:taxDocumentId/email",
  sendTaxDocumentEmailController
);
router.get(
  "/integrations/relbase/dtes/:taxDocumentId/pdf",
  getRelbaseDtePdf
);
router.get(
  "/integrations/relbase/dtes/:taxDocumentId/print-data",
  getRelbaseDtePrintData
);

export default router;
