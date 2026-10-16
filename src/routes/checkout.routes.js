import {
  Router,
} from "express";

import {
  bankTransferProofUpload,
} from "../middlewares/upload.middleware.js";

import {
  createCheckoutOrderController,
  getGuestCheckoutOrderController,
  getGuestCheckoutTaxDocumentPdfController,
  getCustomerDocumentPdfController,
  submitGuestBankTransferProofController,
} from "../controllers/checkout.controller.js";

const router =
  Router();

/* =========================================
   CREAR PEDIDO WEB
========================================= */
router.post(
  "/orders",
  createCheckoutOrderController
);

/* =========================================
   LEER PEDIDO INVITADO
========================================= */
router.get(
  "/orders/:orderId/guest",
  getGuestCheckoutOrderController
);

/* =========================================
   PDF TRIBUTARIO INVITADO

   No usa JWT.
   Requiere:
   X-Guest-Order-Token
========================================= */
router.get(
  "/orders/:orderId/guest/tax-document/pdf",
  getGuestCheckoutTaxDocumentPdfController
);

/* =========================================
   PDF TRIBUTARIO DESDE EMAIL

   No usa JWT.
   La credencial opaca del enlace es el
   factor de autorización.
========================================= */
router.get(
  "/documents/:credential/pdf",
  getCustomerDocumentPdfController
);

/* =========================================
   COMPROBANTE INVITADO

   No usa JWT.
   Requiere:
   X-Guest-Order-Token

   Campo archivo:
   proof_file
========================================= */
router.post(
  "/orders/:orderId/guest/bank-transfer-proof",
  bankTransferProofUpload,
  submitGuestBankTransferProofController
);

export default router;
