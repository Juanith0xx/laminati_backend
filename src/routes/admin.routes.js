import { Router } from "express";

import {

  authenticate,

} from "../middlewares/auth.middleware.js";

import {

  authorizeRoles,

} from "../middlewares/role.middleware.js";

import {

  productImageUploadMiddleware,
  projectImageUploadMiddleware,

} from "../middlewares/upload.middleware.js";

import {

  prepareOrderTaxDocument,

  previewOrderTaxDocument,

  previewRelbaseOrderTaxDocument,

  listAdminTaxDocumentsController,

  queueOrderTaxDocumentEmissionController,

  sendTaxDocumentEmailController,

} from "../controllers/taxDocument.controller.js";

import {

  getAdminCategories,

  createAdminCategory,

  updateAdminCategory,

  deleteAdminCategory,

  getAdminBrands,

  createAdminBrand,

  updateAdminBrand,

  deleteAdminBrand,

  getAdminCollections,

  createAdminCollection,

  updateAdminCollection,

  deleteAdminCollection,

  getAdminProducts,

  getAdminProjectProductFamilies,

  createAdminProduct,

  updateAdminProduct,

  deleteAdminProduct,

  getAdminProductImages,

  createAdminProductImage,

  updateAdminProductImage,

  deleteAdminProductImage,

  getAdminProductSeo,

  upsertAdminProductSeo,

  getAdminProductPromotions,

  createAdminProductPromotion,

  updateAdminProductPromotion,

  deleteAdminProductPromotion,

  getAdminProductInventory,

  updateAdminInventorySafetyStock,

  lookupAdminRelbaseProduct,

} from "../controllers/adminCatalog.controller.js";

import {

  connectRelbase,

  getRelbaseStatus,

  getRelbaseProducts,

  getRelbaseWarehouses,

  getRelbaseProductStock,

  syncRelbaseProducts,

  getRelbaseStagingProducts,

  importRelbaseProduct,

  syncRelbaseInventory,

  syncAllRelbase,

  getRelbaseMonitor,

  getRelbaseCustomers,

  searchRelbaseCustomers,

  findRelbaseCustomerByRut,

  ensureRelbaseCustomerController,

  getRelbaseCities,

  probeRelbaseDteAuth,

  probeRelbaseDteV2Auth,

  previewRelbaseDteHistory,
  getRelbaseDteHistorySyncStateController,
  syncRelbaseDteHistoryController,
  getRelbaseDteHistoryCustomerSyncStateController,
  syncRelbaseDteHistoryCustomersController,
  listRelbaseDteHistoryController,
  getRelbaseDteHistorySummaryController,
  getRelbaseDteHistoryDetailController,
  previewRelbaseDteSync,

  previewRelbaseDteExternalDetail,

  getRelbaseDtePdf,

  getRelbaseDtePrintData,

  previewRelbaseCreditNotes,

  claimRelbaseDteEmission,

  simulateRelbaseDteEmissionError,

  resetSimulatedRelbaseDteEmissionError,

  previewRelbaseDteReconciliation,

  reconcileExistingRelbaseDte,

  syncExistingRelbaseDteStatus,

  previewRelbaseDteEmissionPreflight,

  emitRelbaseDteController,

  probeRelbaseDteV2WriteContractController,

  probeRelbaseDteV2CorsControlController,

} from "../controllers/relbase.controller.js";

import {
  previewAdminInventoryMovement,
  createAdminInventoryMovement,
  readAdminInventoryMovement,
} from "../controllers/adminInventoryMovement.controller.js";

import {
  listAdminUsers,
  getAdminUserOptions,
  createAdminUser,
  updateAdminUser,
  setAdminUserStatus,
  deleteAdminUser,
} from "../controllers/adminUsers.controller.js";

import {
  listAdminPriceLists,
  getAdminPriceList,
  createAdminPriceList,
  updateAdminPriceList,
  deleteAdminPriceList,
  createAdminPriceListRule,
  updateAdminPriceListRule,
  deleteAdminPriceListRule,
  getAdminUserPriceList,
  assignAdminUserPriceList,
  removeAdminUserPriceList,
} from "../controllers/adminPriceLists.controller.js";

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
  listAdminProjectsController,
  getAdminProjectController,
  createAdminProjectController,
  updateAdminProjectController,
  setAdminProjectStatusController,
  deleteAdminProjectController,
  hardDeleteAdminProjectController,
  createAdminProjectImageController,
  updateAdminProjectImageController,
  deleteAdminProjectImageController,
  attachAdminProjectProductController,
  removeAdminProjectProductController,
} from "../controllers/adminProjects.controller.js";

const router = Router();

/* =========================================*

*   TODAS LAS RUTAS ADMIN REQUIEREN:*

*   - JWT*

*   - ROLE ADMIN*

*========================================= */

router.use(

  authenticate,

  authorizeRoles("ADMIN")

);

/* =========================================*

*   TEST ADMIN*

*========================================= */

router.get("/test", (req, res) => {

  return res.status(200).json({

    success: true,

    message: "Acceso administrativo autorizado",

    user: {

      id: req.user.id,

      first_name: req.user.first_name,

      last_name: req.user.last_name,

      email: req.user.email,

      role: req.user.role,

    },

  });

});


/* =========================================
   USUARIOS ADMINISTRATIVOS
========================================= */
router.get(
  "/users/options",
  getAdminUserOptions
);

router.get(
  "/users",
  listAdminUsers
);

router.post(
  "/users",
  createAdminUser
);

router.patch(
  "/users/:userId",
  updateAdminUser
);

router.patch(
  "/users/:userId/status",
  setAdminUserStatus
);

router.delete(
  "/users/:userId",
  deleteAdminUser
);

/* =========================================
   LISTAS DE PRECIOS / DESCUENTOS
========================================= */
router.get(
  "/price-lists",
  listAdminPriceLists
);

router.post(
  "/price-lists",
  createAdminPriceList
);

router.get(
  "/price-lists/:priceListId",
  getAdminPriceList
);

router.patch(
  "/price-lists/:priceListId",
  updateAdminPriceList
);

router.delete(
  "/price-lists/:priceListId",
  deleteAdminPriceList
);

router.post(
  "/price-lists/:priceListId/rules",
  createAdminPriceListRule
);

router.patch(
  "/price-lists/:priceListId/rules/:ruleId",
  updateAdminPriceListRule
);

router.delete(
  "/price-lists/:priceListId/rules/:ruleId",
  deleteAdminPriceListRule
);

router.get(
  "/users/:userId/price-list",
  getAdminUserPriceList
);

router.put(
  "/users/:userId/price-list",
  assignAdminUserPriceList
);

router.delete(
  "/users/:userId/price-list",
  removeAdminUserPriceList
);

/* =========================================
   CONTACTOS WEB
========================================= */
router.get(
  "/contacts",
  listAdminContacts
);

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

/* =========================================
   CENTRO DE NOTIFICACIONES ADMIN
========================================= */
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


/* =========================================
   PROYECTOS / PORTAFOLIO
========================================= */

router.get(
  "/projects",
  listAdminProjectsController
);

router.get(
  "/projects/:projectId",
  getAdminProjectController
);

router.post(
  "/projects",
  createAdminProjectController
);

router.put(
  "/projects/:projectId",
  updateAdminProjectController
);

router.patch(
  "/projects/:projectId",
  updateAdminProjectController
);

router.patch(
  "/projects/:projectId/status",
  setAdminProjectStatusController
);

router.delete(
  "/projects/:projectId",
  deleteAdminProjectController
);


router.delete(
  "/projects/:projectId/permanent",
  hardDeleteAdminProjectController
);

router.post(
  "/projects/:projectId/images",
  projectImageUploadMiddleware,
  createAdminProjectImageController
);

router.patch(
  "/projects/:projectId/images/:imageId",
  updateAdminProjectImageController
);

router.delete(
  "/projects/:projectId/images/:imageId",
  deleteAdminProjectImageController
);

router.post(
  "/projects/:projectId/products",
  attachAdminProjectProductController
);

router.delete(
  "/projects/:projectId/products/:productId",
  removeAdminProjectProductController
);

/* =========================================*

*   CATEGORÍAS*

*========================================= */

router.get(

  "/categories",

  getAdminCategories

);

router.post(

  "/categories",

  createAdminCategory

);

router.patch(

  "/categories/:id",

  updateAdminCategory

);

router.delete(

  "/categories/:id",

  deleteAdminCategory

);

/* =========================================*

*   MARCAS*

*========================================= */

router.get(

  "/brands",

  getAdminBrands

);

router.post(

  "/brands",

  createAdminBrand

);

router.patch(

  "/brands/:id",

  updateAdminBrand

);

router.delete(

  "/brands/:id",

  deleteAdminBrand

);

/* =========================================*

*   COLECCIONES*

*========================================= */

router.get(

  "/collections",

  getAdminCollections

);

router.post(

  "/collections",

  createAdminCollection

);

router.patch(

  "/collections/:id",

  updateAdminCollection

);

router.delete(

  "/collections/:id",

  deleteAdminCollection

);

/* =========================================*

*   PRODUCTOS*

*========================================= */

router.get(

  "/project-product-families",

  getAdminProjectProductFamilies

);

router.get(

  "/products",

  getAdminProducts

);

router.post(

  "/products",

  createAdminProduct

);

router.patch(

  "/products/:id",

  updateAdminProduct

);

router.delete(

  "/products/:id",

  deleteAdminProduct

);

/* =========================================*

*   IMÁGENES DE PRODUCTOS*

*========================================= */

router.get(

  "/products/:productId/images",

  getAdminProductImages

);

router.post(

  "/products/:productId/images",

  productImageUploadMiddleware,

  createAdminProductImage

);

router.patch(

  "/products/:productId/images/:imageId",

  updateAdminProductImage

);

router.delete(

  "/products/:productId/images/:imageId",

  deleteAdminProductImage

);

/* =========================================*

*   SEO DE PRODUCTOS*

*========================================= */

router.get(

  "/products/:productId/seo",

  getAdminProductSeo

);

router.put(

  "/products/:productId/seo",

  upsertAdminProductSeo

);

/* =========================================*

*   PROMOCIONES DE PRODUCTOS*

*========================================= */

router.get(

  "/products/:productId/promotions",

  getAdminProductPromotions

);

router.post(

  "/products/:productId/promotions",

  createAdminProductPromotion

);

router.patch(

  "/products/:productId/promotions/:promotionId",

  updateAdminProductPromotion

);

router.delete(

  "/products/:productId/promotions/:promotionId",

  deleteAdminProductPromotion

);

/* =========================================*

*   INVENTARIO*

*========================================= */

router.get(

  "/products/:productId/inventory",

  getAdminProductInventory

);

// Gestión de stock (escritura desactivada por defecto; no altera las rutas actuales).
router.get(
  "/products/:productId/stock-movements/preview",
  previewAdminInventoryMovement
);
router.get(
  "/products/:productId/stock-movements/:requestId",
  readAdminInventoryMovement
);
router.post(
  "/products/:productId/stock-movements",
  createAdminInventoryMovement
);

router.patch(

  "/inventory/:inventoryId/safety-stock",

  updateAdminInventorySafetyStock

);

/* =========================================*

*   INTEGRACIÓN RELBASE*

*========================================= */

router.get(

  "/integrations/relbase/status",

  getRelbaseStatus

);

router.get(

  "/integrations/relbase/connect",

  connectRelbase

);

router.get(

  "/integrations/relbase/products",

  getRelbaseProducts

);

router.get(

  "/integrations/relbase/products/lookup",

  lookupAdminRelbaseProduct

);

router.get(

  "/integrations/relbase/warehouses",

  getRelbaseWarehouses

);

router.get(

  "/integrations/relbase/products/:relbaseProductId/stock",

  getRelbaseProductStock

);

router.post(

  "/integrations/relbase/products/sync",

  syncRelbaseProducts

);

router.get(

  "/integrations/relbase/staging/products",

  getRelbaseStagingProducts

);

router.post(

  "/integrations/relbase/staging/products/:id/import",

  importRelbaseProduct

);

router.post(

  "/integrations/relbase/products/:productId/inventory/sync",

  syncRelbaseInventory

);

router.post(

  "/integrations/relbase/sync-all",

  syncAllRelbase

);

router.get(

  "/integrations/relbase/monitor",

  getRelbaseMonitor

);

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

router.get(

  "/tax-documents",

  listAdminTaxDocumentsController

);

router.post(

  "/tax-documents/:taxDocumentId/email",

  sendTaxDocumentEmailController

);

router.post(

  "/orders/:orderId/tax-document/queue",

  queueOrderTaxDocumentEmissionController

);

router.post(

  "/orders/:orderId/tax-document/prepare",

  prepareOrderTaxDocument

);

router.get(

  "/orders/:orderId/tax-document/preview",

  previewOrderTaxDocument

);

router.get(

  "/orders/:orderId/tax-document/relbase-preview",

  previewRelbaseOrderTaxDocument

);

router.get(

  "/integrations/relbase/dtes/auth-probe",

  probeRelbaseDteAuth

);

router.get(

  "/integrations/relbase/dtes/v2-auth-probe",

  probeRelbaseDteV2Auth

);

/* =========================================*

*   PROBE CONTRATO ESCRITURA DTE V2*

*   PASO 84.6.1*

*   Local GET -> Relbase OPTIONS.*

*   NO emite ni envía POST.*

*========================================= */

router.get(

  "/integrations/relbase/dtes/v2-write-contract-probe",

  probeRelbaseDteV2WriteContractController

);

/* =========================================*

*   PROBE CONTROL CORS DTE V2 - PASO 84.6.2*

*   Compara OPTIONS contra endpoint inexistente.*

*   NO ejecuta POST.*

*========================================= */

router.get(

  "/integrations/relbase/dtes/v2-cors-control-probe",

  probeRelbaseDteV2CorsControlController

);

/* =========================================
   PREVIEW HISTÓRICO DTE RELBASE - FASE 2
   Sólo lectura: Facturas 33 + Boletas 39.
   NO persiste y NO emite documentos.
========================================= */
router.get(
  "/integrations/relbase/dtes/history-preview",
  previewRelbaseDteHistory
);

/* =========================================
   ESTADO + SINCRONIZACIÓN HISTÓRICA DTE
   FASE 3
========================================= */
router.get(
  "/integrations/relbase/dtes/history/sync-state",
  getRelbaseDteHistorySyncStateController
);

router.post(
  "/integrations/relbase/dtes/history/sync",
  syncRelbaseDteHistoryController
);



/* =========================================
   ENRIQUECIMIENTO CLIENTES DTE - FASE 5.1
   GET hacia Relbase + UPDATE local.
   NO emite DTE ni escribe en Relbase.
========================================= */
router.get(
  "/integrations/relbase/dtes/history/customers/sync-state",
  getRelbaseDteHistoryCustomerSyncStateController
);

router.post(
  "/integrations/relbase/dtes/history/customers/sync",
  syncRelbaseDteHistoryCustomersController
);


/* =========================================
   CONSULTA HISTÓRICA DTE - FASE 4
   Sólo PostgreSQL. No consulta Relbase.
========================================= */
router.get(
  "/integrations/relbase/dtes/history/summary",
  getRelbaseDteHistorySummaryController
);

router.get(
  "/integrations/relbase/dtes/history",
  listRelbaseDteHistoryController
);

router.get(
  "/integrations/relbase/dtes/history/:id",
  getRelbaseDteHistoryDetailController
);

router.get(

  "/integrations/relbase/dtes/sync-preview",

  previewRelbaseDteSync

);

/* =========================================*

*   DETALLE EXTERNO DTE RELBASE V2*

*   Sólo GET hacia Relbase:*

*   GET /api/v2/dtes/:e_document_id*

*   - NO persiste.*

*   - NO cambia estados.*

*   - NO ejecuta POST.*

*   - NO emite DTE.*

*   - Devuelve resumen sanitizado + pistas*

*   de referencias / notas de crédito.*

*========================================= */

router.get(

  "/integrations/relbase/dtes/external/:relbaseDocumentId/detail",

  previewRelbaseDteExternalDetail

);





/* =========================================*

*   PDF DTE RELBASE PARA BACKOFFICE*

*   Usa taxDocumentId local.*

*   - Sólo GET / lectura.*

*   - NO emite DTE.*

*   - NO cambia estados.*

*========================================= */

router.get(

  "/integrations/relbase/dtes/:taxDocumentId/pdf",

  getRelbaseDtePdf

);

/* =========================================*

*   DATOS DE IMPRESIÓN DTE RELBASE V2*

*   Usa taxDocumentId local.*

*   - Sólo GET / lectura.*

*   - Consulta /api/v2/dtes/:id/imprimir.*

*   - NO persiste.*

*   - NO ejecuta POST.*

*   - NO emite DTE.*

*========================================= */

router.get(

  "/integrations/relbase/dtes/:taxDocumentId/print-data",

  getRelbaseDtePrintData

);

/* =========================================*

*   PREVIEW NOTAS DE CRÉDITO RELBASE V2*

*   Sólo GET hacia Relbase:*

*   GET /api/v2/dtes?type_document=61&page=N*

*   - NO persiste.*

*   - NO cambia estados.*

*   - NO ejecuta POST.*

*   - NO emite DTE.*

*========================================= */

router.get(

  "/integrations/relbase/dtes/credit-notes-preview",

  previewRelbaseCreditNotes

);

/* =========================================*

*   CLAIM DTE - PASO 84.5.6*

*   NO emite hacia Relbase.*

*   Sólo realiza PENDING -> PROCESSING.*

*========================================= */

router.post(

  "/integrations/relbase/dtes/:taxDocumentId/claim-emission",

  claimRelbaseDteEmission

);

/* =========================================*

*   SIMULAR ERROR DTE - PASO 84.5.7.1*

*   Sólo disponible fuera de producción.*

*   NO realiza solicitudes hacia Relbase.*

*========================================= */

router.post(

  "/integrations/relbase/dtes/:taxDocumentId/simulate-emission-error",

  simulateRelbaseDteEmissionError

);

/* =========================================*

*   RESET ERROR SIMULADO - PASO 84.5.8*

*   Sólo disponible fuera de producción.*

*   NO realiza solicitudes hacia Relbase.*

*========================================= */

router.post(

  "/integrations/relbase/dtes/:taxDocumentId/reset-simulated-error",

  resetSimulatedRelbaseDteEmissionError

);

/* =========================================*

*   PREVIEW RECONCILIACIÓN - PASO 84.5.9*

*   Sólo GET hacia Relbase.*

*   NO emite ni persiste.*

*========================================= */

router.get(

  "/integrations/relbase/dtes/:taxDocumentId/reconciliation-preview",

  previewRelbaseDteReconciliation

);


/* =========================================
   SINCRONIZAR ESTADO DTE POR ID CONOCIDO
   - Un GET exacto hacia Relbase.
   - Persiste estado/track/PDF/XML local.
   - 0 páginas de reconciliación.
   - NO emite DTE.
========================================= */
router.post(

  "/integrations/relbase/dtes/:taxDocumentId/sync-status",

  syncExistingRelbaseDteStatus

);

/* =========================================
   RECONCILIAR DTE EXISTENTE RELBASE
   - GET hacia Relbase + persistencia local.
   - NO ejecuta POST /api/v2/dtes.
   - NO emite un DTE nuevo.
========================================= */
router.post(

  "/integrations/relbase/dtes/:taxDocumentId/reconcile-existing",

  reconcileExistingRelbaseDte

);

/* =========================================*

*   PREFLIGHT EMISIÓN DTE - PASO 84.6.6*

*   Consolida validaciones locales + payload +*

*   reconciliación completa.*

*   NO hace POST hacia Relbase.*

*   NO cambia estados.*

*   NO emite.*

*========================================= */

router.get(

  "/integrations/relbase/dtes/:taxDocumentId/emission-preflight",

  previewRelbaseDteEmissionPreflight

);

















/* =========================================*

*   EMISIÓN DTE RELBASE*

*   RELBASE_DTE_EMISSION_ENABLED=false*

*   => DRY RUN*

*   => NO CLAIM*

*   => NO POST*

*   => NO DTE REAL*

*   RELBASE_DTE_EMISSION_ENABLED=true*

*   => EMISIÓN REAL CONTROLADA*

*========================================= */

router.post(

  "/integrations/relbase/dtes/:taxDocumentId/emit",

  emitRelbaseDteController

);

export default router;