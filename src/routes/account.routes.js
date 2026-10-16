import { Router } from "express";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

import {
  authorizeRoles,
} from "../middlewares/role.middleware.js";

import {
  createAccountAddressController,
  createAccountDocumentAccessController,
  deleteAccountAddressController,
  getAccountMeController,
  getAccountOrderController,
  listAccountAddressesController,
  listAccountCompaniesController,
  listAccountDocumentsController,
  listAccountExclusiveProductsController,
  listAccountOrdersController,
  updateAccountAddressController,
  updateAccountCompanyController,
  updateAccountProfileController,
} from "../controllers/account.controller.js";

const router = Router();

router.use(
  authenticate,
  authorizeRoles("CLIENTE", "USUARIO_EMPRESA")
);

router.get("/me", getAccountMeController);
router.patch("/me", updateAccountProfileController);

router.get(
  "/addresses",
  listAccountAddressesController
);
router.post(
  "/addresses",
  createAccountAddressController
);
router.patch(
  "/addresses/:addressId",
  updateAccountAddressController
);
router.delete(
  "/addresses/:addressId",
  deleteAccountAddressController
);

router.get(
  "/companies",
  listAccountCompaniesController
);
router.patch(
  "/companies/:companyId",
  authorizeRoles("USUARIO_EMPRESA"),
  updateAccountCompanyController
);

router.get(
  "/exclusive-products",
  listAccountExclusiveProductsController
);

router.get(
  "/orders",
  listAccountOrdersController
);
router.get(
  "/orders/:orderId",
  getAccountOrderController
);

router.get(
  "/documents",
  listAccountDocumentsController
);
router.post(
  "/documents/:taxDocumentId/access",
  createAccountDocumentAccessController
);

export default router;
