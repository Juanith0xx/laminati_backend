import {
  promises as fs,
} from "fs";

import path from "path";

import {
  getActiveBankAccounts,
  createManualBankTransferPayment,
  getOrderPayment,
  submitBankTransferProof,
  listBankTransferProofs,
  approveBankTransferProof,
  rejectBankTransferProof,
  getBankTransferProofFileMetadata,
} from "../services/payment.service.js";

import {
  saveBankTransferProofFile,
  deleteStoredFile,
} from "../services/storage.service.js";


/* =========================================
   UUID
========================================= */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


const isValidUuid = (value) => {
  return UUID_PATTERN.test(
    String(value || "").trim()
  );
};


/* =========================================
   RESPUESTA DE ERROR
========================================= */
const sendServiceError = (
  res,
  error,
  fallbackMessage
) => {
  return res
    .status(
      error.status ||
      500
    )
    .json({
      success: false,

      message:
        error.message ||
        fallbackMessage,

      code:
        error.code ||
        null,
    });
};


/* =========================================
   CUENTAS BANCARIAS ACTIVAS
========================================= */
export const getBankAccountsController =
  async (req, res) => {
    try {
      const accounts =
        await getActiveBankAccounts();

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Cuentas bancarias obtenidas correctamente",

          data: {
            accounts,
          },
        });
    } catch (error) {
      console.error(
        "Error obteniendo cuentas bancarias:",
        error
      );

      return sendServiceError(
        res,
        error,
        "No fue posible obtener las cuentas bancarias"
      );
    }
  };


/* =========================================
   INICIAR TRANSFERENCIA
========================================= */
export const createManualTransferController =
  async (req, res) => {
    try {
      const orderId =
        String(
          req.params.orderId ||
          ""
        ).trim();

      if (!isValidUuid(orderId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "orderId no es un UUID válido",
            code:
              "INVALID_ORDER_ID",
          });
      }

      const result =
        await createManualBankTransferPayment({
          orderId,

          requesterUserId:
            req.user?.id ||
            null,

          requesterRole:
            req.user?.role ||
            null,
        });

      return res
        .status(
          result.created
            ? 201
            : 200
        )
        .json({
          success: true,

          message:
            result.created
              ? "Pago por transferencia creado correctamente"
              : "La orden ya poseía un pago por transferencia",

          data: result,
        });
    } catch (error) {
      console.error(
        "Error creando pago por transferencia:",
        {
          message:
            error.message,

          code:
            error.code ||
            null,
        }
      );

      return sendServiceError(
        res,
        error,
        "No fue posible iniciar el pago por transferencia"
      );
    }
  };


/* =========================================
   DETALLE PAGO POR ORDEN
========================================= */
export const getOrderPaymentController =
  async (req, res) => {
    try {
      const orderId =
        String(
          req.params.orderId ||
          ""
        ).trim();

      if (!isValidUuid(orderId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "orderId no es un UUID válido",
            code:
              "INVALID_ORDER_ID",
          });
      }

      const result =
        await getOrderPayment({
          orderId,

          requesterUserId:
            req.user?.id ||
            null,

          requesterRole:
            req.user?.role ||
            null,
        });

      return res
        .status(200)
        .json({
          success: true,
          data: result,
        });
    } catch (error) {
      console.error(
        "Error obteniendo pago de orden:",
        error
      );

      return sendServiceError(
        res,
        error,
        "No fue posible obtener el pago de la orden"
      );
    }
  };


/* =========================================
   REGISTRAR COMPROBANTE REAL

   multipart/form-data:
   - proof_file
   - submitted_amount
   - submitted_bank
   - submitted_reference
   - transfer_date

   IMPORTANTE:
   - El archivo se guarda físicamente.
   - Registrar comprobante NO confirma pago.
   - Ante error de negocio/DB eliminamos el
     archivo recién almacenado para evitar
     archivos huérfanos.
========================================= */
export const submitBankTransferProofController =
  async (req, res) => {
    let storedFile = null;

    try {
      const paymentId =
        String(
          req.params.paymentId ||
          ""
        ).trim();

      if (!isValidUuid(paymentId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "paymentId no es un UUID válido",
            code:
              "INVALID_PAYMENT_ID",
          });
      }

      if (!req.file) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "proof_file es obligatorio",
            code:
              "BANK_TRANSFER_PROOF_FILE_REQUIRED",
          });
      }

      const {
        submitted_amount = null,
        submitted_bank = null,
        submitted_reference = null,
        transfer_date = null,
      } = req.body || {};

      let normalizedAmount =
        null;

      if (
        submitted_amount !==
          undefined &&
        submitted_amount !==
          null &&
        submitted_amount !==
          ""
      ) {
        normalizedAmount =
          Number(
            submitted_amount
          );

        if (
          !Number.isFinite(
            normalizedAmount
          ) ||
          normalizedAmount <= 0
        ) {
          return res
            .status(400)
            .json({
              success: false,
              message:
                "submitted_amount debe ser mayor que 0",
              code:
                "BANK_TRANSFER_PROOF_AMOUNT_INVALID",
            });
        }
      }

      let normalizedTransferDate =
        null;

      if (transfer_date) {
        const parsed =
          new Date(
            transfer_date
          );

        if (
          Number.isNaN(
            parsed.getTime()
          )
        ) {
          return res
            .status(400)
            .json({
              success: false,
              message:
                "transfer_date no posee un formato válido",
              code:
                "BANK_TRANSFER_DATE_INVALID",
            });
        }

        normalizedTransferDate =
          parsed.toISOString();
      }

      storedFile =
        await saveBankTransferProofFile(
          req.file
        );

      const result =
        await submitBankTransferProof({
          paymentId,

          requesterUserId:
            req.user?.id ||
            null,

          requesterRole:
            req.user?.role ||
            null,

          fileUrl:
            storedFile.fileUrl,

          originalFilename:
            storedFile.originalFilename,

          mimeType:
            storedFile.mimeType,

          fileSizeBytes:
            storedFile.fileSizeBytes,

          submittedAmount:
            normalizedAmount,

          submittedBank:
            submitted_bank
              ? String(
                  submitted_bank
                ).trim()
              : null,

          submittedReference:
            submitted_reference
              ? String(
                  submitted_reference
                ).trim()
              : null,

          transferDate:
            normalizedTransferDate,
        });

      return res
        .status(201)
        .json({
          success: true,

          message:
            "Comprobante cargado y enviado a revisión",

          data: {
            ...result,

            upload: {
              stored: true,
              storage_driver:
                storedFile.storageDriver,
              storage_key:
                storedFile.storageKey,
            },
          },
        });
    } catch (error) {
      if (storedFile?.storageKey) {
        try {
          await deleteStoredFile(
            storedFile.storageKey
          );
        } catch (cleanupError) {
          console.error(
            "Error eliminando comprobante huérfano:",
            {
              message:
                cleanupError.message,
            }
          );
        }
      }

      console.error(
        "Error registrando comprobante de transferencia:",
        {
          message:
            error.message,

          code:
            error.code ||
            null,
        }
      );

      return sendServiceError(
        res,
        error,
        "No fue posible registrar el comprobante"
      );
    }
  };


/* =========================================
   LISTADO ADMIN
========================================= */
export const listBankTransferProofsController =
  async (req, res) => {
    try {
      const status =
        String(
          req.query.status ||
          "PENDING"
        )
          .trim()
          .toUpperCase();

      const limit =
        Math.min(
          Math.max(
            Number(
              req.query.limit
            ) || 50,
            1
          ),
          100
        );

      const offset =
        Math.max(
          Number(
            req.query.offset
          ) || 0,
          0
        );

      const proofs =
        await listBankTransferProofs({
          status,
          limit,
          offset,
        });

      return res
        .status(200)
        .json({
          success: true,

          data: {
            proofs,
            meta: {
              status,
              limit,
              offset,
              count:
                proofs.length,
            },
          },
        });
    } catch (error) {
      console.error(
        "Error listando comprobantes:",
        error
      );

      return sendServiceError(
        res,
        error,
        "No fue posible listar los comprobantes"
      );
    }
  };


/* =========================================
   APROBAR ADMIN
========================================= */
export const approveBankTransferProofController =
  async (req, res) => {
    try {
      const proofId =
        String(
          req.params.proofId ||
          ""
        ).trim();

      if (!isValidUuid(proofId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "proofId no es un UUID válido",
            code:
              "INVALID_PROOF_ID",
          });
      }

      const {
        review_notes = null,
      } = req.body || {};

      const result =
        await approveBankTransferProof({
          proofId,

          reviewedBy:
            req.user.id,

          reviewNotes:
            review_notes
              ? String(
                  review_notes
                ).trim()
              : null,
        });

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Transferencia aprobada y pago confirmado como PAID",

          data: result,
        });
    } catch (error) {
      console.error(
        "Error aprobando transferencia:",
        {
          message:
            error.message,

          code:
            error.code ||
            null,
        }
      );

      return sendServiceError(
        res,
        error,
        "No fue posible aprobar la transferencia"
      );
    }
  };


/* =========================================
   RECHAZAR ADMIN
========================================= */
export const rejectBankTransferProofController =
  async (req, res) => {
    try {
      const proofId =
        String(
          req.params.proofId ||
          ""
        ).trim();

      if (!isValidUuid(proofId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "proofId no es un UUID válido",
            code:
              "INVALID_PROOF_ID",
          });
      }

      const {
        reason,
        review_notes = null,
      } = req.body || {};

      const normalizedReason =
        String(
          reason || ""
        ).trim();

      if (!normalizedReason) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "reason es obligatorio para rechazar el comprobante",
            code:
              "BANK_TRANSFER_REJECTION_REASON_REQUIRED",
          });
      }

      const result =
        await rejectBankTransferProof({
          proofId,

          reviewedBy:
            req.user.id,

          reason:
            normalizedReason,

          reviewNotes:
            review_notes
              ? String(
                  review_notes
                ).trim()
              : null,
        });

      return res
        .status(200)
        .json({
          success: true,

          message:
            "Comprobante rechazado correctamente",

          data: result,
        });
    } catch (error) {
      console.error(
        "Error rechazando transferencia:",
        {
          message:
            error.message,

          code:
            error.code ||
            null,
        }
      );

      return sendServiceError(
        res,
        error,
        "No fue posible rechazar la transferencia"
      );
    }
  };

/* =========================================
   VISUALIZAR COMPROBANTE ADMIN

   El archivo NO se expone como carpeta pública.
   Sólo un ADMIN autenticado puede llegar a
   esta operación por payment.routes.js.
========================================= */
export const getBankTransferProofFileController =
  async (req, res) => {
    try {
      const proofId =
        String(
          req.params.proofId ||
          ""
        ).trim();

      if (!isValidUuid(proofId)) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "proofId no es un UUID válido",
            code:
              "INVALID_PROOF_ID",
          });
      }

      const metadata =
        await getBankTransferProofFileMetadata({
          proofId,
        });

      const fileUrl =
        String(
          metadata?.file_url ||
          ""
        ).trim();

      if (
        !fileUrl.startsWith(
          "local://bank-transfer-proofs/"
        )
      ) {
        return res
          .status(409)
          .json({
            success: false,
            message:
              "El comprobante utiliza un proveedor de almacenamiento que esta ruta todavía no puede visualizar",
            code:
              "BANK_TRANSFER_PROOF_STORAGE_DRIVER_UNSUPPORTED",
          });
      }

      const storageKey =
        fileUrl
          .slice(
            "local://".length
          )
          .replace(
            /\\/g,
            "/"
          )
          .replace(
            /^\/+/,
            ""
          );

      if (
        !storageKey.startsWith(
          "bank-transfer-proofs/"
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "La ruta del comprobante no es válida",
            code:
              "BANK_TRANSFER_PROOF_STORAGE_KEY_INVALID",
          });
      }

      const storageRoot =
        path.resolve(
          process.cwd(),
          "uploads"
        );

      const proofRoot =
        path.resolve(
          storageRoot,
          "bank-transfer-proofs"
        );

      const absolutePath =
        path.resolve(
          storageRoot,
          ...storageKey.split("/")
        );

      const relativePath =
        path.relative(
          proofRoot,
          absolutePath
        );

      if (
        relativePath.startsWith(
          ".."
        ) ||
        path.isAbsolute(
          relativePath
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "La ruta del comprobante no es válida",
            code:
              "BANK_TRANSFER_PROOF_STORAGE_PATH_INVALID",
          });
      }

      try {
        await fs.access(
          absolutePath
        );
      } catch {
        return res
          .status(404)
          .json({
            success: false,
            message:
              "El archivo del comprobante no se encuentra disponible",
            code:
              "BANK_TRANSFER_PROOF_FILE_NOT_FOUND",
          });
      }

      const originalFilename =
        String(
          metadata
            ?.original_filename ||
          "comprobante"
        )
          .replace(
            /[\r\n"]/g,
            ""
          )
          .trim() ||
        "comprobante";

      const mimeType =
        String(
          metadata
            ?.mime_type ||
          "application/octet-stream"
        ).trim();

      res.setHeader(
        "Content-Type",
        mimeType
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(
          originalFilename
        )}`
      );

      res.setHeader(
        "Cache-Control",
        "private, no-store, max-age=0"
      );

      return res.sendFile(
        absolutePath
      );
    } catch (error) {
      console.error(
        "Error visualizando comprobante:",
        {
          message:
            error.message,

          code:
            error.code ||
            null,
        }
      );

      return sendServiceError(
        res,
        error,
        "No fue posible visualizar el comprobante"
      );
    }
  };

