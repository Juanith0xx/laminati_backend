import { Router } from "express";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

import {
  authorizeRoles,
} from "../middlewares/role.middleware.js";

import {
  bankTransferProofUpload,
} from "../middlewares/upload.middleware.js";

import {
  getBankAccountsController,
  createManualTransferController,
  getOrderPaymentController,
  submitBankTransferProofController,
  listBankTransferProofsController,
  approveBankTransferProofController,
  rejectBankTransferProofController,
  getBankTransferProofFileController,
} from "../controllers/payment.controller.js";


const router =
  Router();


/* =========================================
   TODAS LAS RUTAS DE PAGO REQUIEREN JWT

   El soporte de checkout guest se agregará
   posteriormente con un token específico
   de orden. No se habilita acceso por email.
========================================= */
router.use(
  authenticate
);


/* =========================================
   CUENTAS BANCARIAS ACTIVAS
========================================= */
router.get(
  "/bank-accounts",
  getBankAccountsController
);


/* =========================================
   CLIENTE / ADMIN
========================================= */
router.post(
  "/orders/:orderId/manual-transfer",
  createManualTransferController
);


router.get(
  "/orders/:orderId",
  getOrderPaymentController
);


router.post(
  "/:paymentId/bank-transfer/proofs",
  bankTransferProofUpload,
  submitBankTransferProofController
);


/* =========================================
   ADMIN
========================================= */
router.get(
  "/admin/bank-transfer-proofs",
  authorizeRoles("ADMIN", "VENDEDOR"),
  listBankTransferProofsController
);


router.get(
  "/admin/bank-transfer-proofs/:proofId/file",
  authorizeRoles("ADMIN", "VENDEDOR"),
  getBankTransferProofFileController
);


router.patch(
  "/admin/bank-transfer-proofs/:proofId/approve",
  authorizeRoles("ADMIN"),
  approveBankTransferProofController
);


router.patch(
  "/admin/bank-transfer-proofs/:proofId/reject",
  authorizeRoles("ADMIN"),
  rejectBankTransferProofController
);


export default router;
