import {
  prepareTaxDocument,
  listAdminTaxDocuments,
} from "../services/taxDocument.service.js";

import {
  getTaxDocumentPreview,
} from "../services/taxDocumentPreview.service.js";

import {
  buildRelbaseDtePreview,
} from "../services/relbaseDteAdapter.service.js";

import {
  ensureDteAcceptedEmailArtifacts,
} from "../services/emailOutbox.service.js";

import {
  enqueueTaxDocumentEmissionJob,
  processTaxDocumentEmissionJobByOrderId,
} from "../services/taxDocumentEmissionQueue.service.js";

/* =========================================
   PREPARAR DTE DESDE ORDEN
========================================= */
export const prepareOrderTaxDocument =
  async (req, res) => {
    try {
      const {
        orderId,
      } = req.params;

      const result =
        await prepareTaxDocument(
          orderId
        );

      return res
        .status(
          result
            .already_prepared
            ? 200
            : 201
        )
        .json({
          success: true,

          message:
            result
              .already_prepared
              ? "El documento tributario ya se encontraba preparado"
              : "Documento tributario preparado correctamente",

          data:
            result,
        });
    } catch (error) {
      console.error(
        "Error preparando documento tributario:",
        {
          message:
            error.message,

          code:
            error.code || null,

          status:
            error.status || null,
        }
      );

      return res
        .status(
          error.status || 500
        )
        .json({
          success: false,

          message:
            error.message ||
            "No fue posible preparar el documento tributario",

          code:
            error.code || null,
        });
    }
  };

  /* =========================================
   PREVIEW DTE
========================================= */
export const previewOrderTaxDocument =
  async (req, res) => {
    try {
      const {
        orderId,
      } = req.params;

      const preview =
        await getTaxDocumentPreview(
          orderId
        );

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Preview tributario generado correctamente",

          data:
            preview,
        });
    } catch (error) {
      console.error(
        "Error generando preview tributario:",
        {
          message:
            error.message,

          code:
            error.code ||
            null,

          status:
            error.status ||
            null,
        }
      );

      return res
        .status(
          error.status ||
          500
        )
        .json({
          success: false,

          message:
            error.message ||
            "No fue posible generar el preview tributario",

          code:
            error.code ||
            null,
        });
    }
  };

/* =========================================
   PREVIEW PAYLOAD RELBASE DTE
========================================= */
export const previewRelbaseOrderTaxDocument =
  async (
    req,
    res
  ) => {
    try {
      const {
        orderId,
      } = req.params;

      const data =
        await buildRelbaseDtePreview(
          orderId
        );

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Preview Relbase generado correctamente",

          data,
        });
    } catch (error) {
      console.error(
        "Error generando preview Relbase DTE:",
        {
          message:
            error.message,

          code:
            error.code ||
            null,

          status:
            error.status ||
            null,
        }
      );

      return res
        .status(
          error.status ||
          500
        )
        .json({
          success: false,

          message:
            error.message ||
            "No fue posible generar el preview Relbase",

          code:
            error.code ||
            null,
        });
    }
  };

/* =========================================
   LISTAR DOCUMENTOS TRIBUTARIOS ADMIN
========================================= */

export const listAdminTaxDocumentsController =
  async (
    req,
    res
  ) => {
    try {
      const data =
        await listAdminTaxDocuments({
          query:
            req.query || {},
        });

      return res
        .status(200)
        .json({
          success: true,
          data,
        });
    } catch (error) {
      console.error(
        "Error listando documentos tributarios:",
        {
          message:
            error?.message,
          code:
            error?.code ||
            null,
          status:
            error?.status ||
            null,
        }
      );

      return res
        .status(
          error?.status ||
          500
        )
        .json({
          success: false,
          message:
            error?.message ||
            "No fue posible listar los documentos tributarios",
          code:
            error?.code ||
            "TAX_DOCUMENT_LIST_ERROR",
        });
    }
  };



/* =========================================
   ENCOLAR EMISIÓN DTE DESDE ADMIN
========================================= */
export const queueOrderTaxDocumentEmissionController =
  async (req, res) => {
    try {
      const orderId =
        String(
          req.params.orderId ||
          ""
        ).trim();

      if (!orderId) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "orderId es obligatorio",
            code:
              "DTE_EMISSION_QUEUE_ORDER_REQUIRED",
          });
      }

      const queued =
        await enqueueTaxDocumentEmissionJob({
          orderId,
          requestedBy:
            req.user?.id ||
            null,
        });

      if (
        queued?.job?.status ===
        "QUEUED"
      ) {
        setImmediate(
          () => {
            void processTaxDocumentEmissionJobByOrderId({
              orderId,
            }).catch(
              (error) => {
                console.error(
                  "Error iniciando emisión DTE en segundo plano:",
                  {
                    order_id:
                      orderId,
                    message:
                      error?.message ||
                      null,
                    code:
                      error?.code ||
                      null,
                  }
                );
              }
            );
          }
        );
      }

      return res
        .status(202)
        .json({
          success: true,
          message:
            queued?.created
              ? "Documento tributario enviado a la cola de emisión"
              : "El pedido ya posee una solicitud de emisión tributaria",
          data: queued,
        });
    } catch (error) {
      console.error(
        "Error encolando emisión DTE:",
        error
      );

      return res
        .status(
          error?.status ||
          500
        )
        .json({
          success: false,
          message:
            error?.message ||
            "No fue posible encolar la emisión del documento tributario",
          code:
            error?.code ||
            "DTE_EMISSION_QUEUE_ERROR",
        });
    }
  };

/* =========================================
   ENVÍO MANUAL DTE POR CORREO
========================================= */
export const sendTaxDocumentEmailController =
  async (req, res) => {
    try {
      const taxDocumentId =
        String(
          req.params.taxDocumentId ||
          ""
        ).trim();

      const recipientEmail =
        String(
          req.body?.recipient_email ||
          ""
        ).trim();

      const result =
        await ensureDteAcceptedEmailArtifacts({
          taxDocumentId,
          recipientEmailOverride:
            recipientEmail ||
            null,
          forceResend: true,
        });

      return res
        .status(202)
        .json({
          success: true,
          message:
            "Documento tributario encolado para envío por correo",
          data: result,
        });
    } catch (error) {
      console.error(
        "Error encolando DTE por correo:",
        error
      );

      return res
        .status(
          error?.status ||
          500
        )
        .json({
          success: false,
          message:
            error?.message ||
            "No fue posible enviar el documento tributario por correo",
          code:
            error?.code ||
            "DTE_EMAIL_QUEUE_ERROR",
        });
    }
  };
