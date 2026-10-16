import {

  createGuestCheckoutOrder,

  getGuestCheckoutOrder,

  getGuestTaxDocumentPdf,

} from "../services/checkout.service.js";

import {

  resolveCustomerDocumentPdfByCredential,

} from "../services/customerDocumentAccess.service.js";

import {

  submitBankTransferProof,

} from "../services/payment.service.js";

import {

  saveBankTransferProofFile,

  deleteStoredFile,

} from "../services/storage.service.js";

/*  =========================================

   UUID

========================================= */

const UUID_PATTERN =

  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidUuid = (

  value

) => {

  return UUID_PATTERN.test(

    String(

      value || ""

    ).trim()

  );

};

/*  =========================================

   ERROR

========================================= */

const sendError = (

  res,

  error,

  fallbackCode,

  fallbackMessage

) => {

  return res

    .status(

      error?.status ||

        500

    )

    .json({

      success: false,

      code:

        error?.code ||

        fallbackCode,

      message:

        error?.message ||

        fallbackMessage,

    });

};

/*  =========================================

   CREAR ORDEN WEB

========================================= */

export const createCheckoutOrderController =

  async (

    req,

    res

  ) => {

    try {

      const result =

        await createGuestCheckoutOrder(

          req.body

        );

      return res

        .status(201)

        .json({

          success: true,

          message:

            "Pedido creado correctamente. Continúa con la transferencia bancaria.",

          data:

            result,

        });

    } catch (error) {

      console.error(

        "Error creando orden de checkout:",

        {

          message:

            error.message,

          code:

            error.code ||

            null,

        }

      );

      return sendError(

        res,

        error,

        "CHECKOUT_ORDER_ERROR",

        "No fue posible crear el pedido"

      );

    }

  };

/*  =========================================

   CONSULTAR ORDEN INVITADO

========================================= */

export const getGuestCheckoutOrderController =

  async (

    req,

    res

  ) => {

    try {

      const guestToken =

        req.get(

          "X-Guest-Order-Token"

        );

      const result =

        await getGuestCheckoutOrder({

          orderId:

            req.params.orderId,

          guestToken,

        });

      return res

        .status(200)

        .json({

          success: true,

          data:

            result,

        });

    } catch (error) {

      console.error(

        "Error consultando orden invitado:",

        {

          message:

            error.message,

          code:

            error.code ||

            null,

        }

      );

      return sendError(

        res,

        error,

        "GUEST_ORDER_ERROR",

        "No fue posible consultar el pedido"

      );

    }

  };

/*  =========================================

   VER PDF TRIBUTARIO INVITADO

   No usa JWT.

   Requiere:

   X-Guest-Order-Token

   Seguridad:

   - Revalida el token privado del pedido.

   - Requiere pago PAID.

   - Sólo permite DTE ISSUED / ACCEPTED.

   - No emite ni modifica documentos.

========================================= */

export const getGuestCheckoutTaxDocumentPdfController =

  async (

    req,

    res

  ) => {

    try {

      const orderId =

        String(

          req.params.orderId ||

          ""

        ).trim();

      if (

        !isValidUuid(

          orderId

        )

      ) {

        return res

          .status(400)

          .json({

            success: false,

            code:

              "GUEST_ORDER_ID_INVALID",

            message:

              "El identificador del pedido no es válido",

          });

      }

      const guestToken =

        String(

          req.get(

            "X-Guest-Order-Token"

          ) ||

          ""

        ).trim();

      if (

        guestToken.length <

          20 ||

        guestToken.length >

          200

      ) {

        return res

          .status(401)

          .json({

            success: false,

            code:

              "GUEST_ORDER_TOKEN_INVALID",

            message:

              "El acceso privado del pedido no es válido",

          });

      }

      const result =

        await getGuestTaxDocumentPdf({

          orderId,

          guestToken,

        });

      return res

        .status(200)

        .json({

          success: true,

          message:

            "Documento tributario disponible",

          data:

            result,

        });

    } catch (error) {

      console.error(

        "Error obteniendo documento tributario invitado:",

        {

          message:

            error.message,

          code:

            error.code ||

            null,

        }

      );

      return sendError(

        res,

        error,

        "GUEST_TAX_DOCUMENT_ERROR",

        "No fue posible abrir el documento tributario"

      );

    }

  };

/*  =========================================

   SUBIR COMPROBANTE INVITADO

   multipart/form-data:

   - proof_file

   - submitted_amount

   - submitted_bank

   - submitted_reference

   - transfer_date

   Header:

   X-Guest-Order-Token

========================================= */

export const submitGuestBankTransferProofController =

  async (

    req,

    res

  ) => {

    let storedFile =

      null;

    try {

      const orderId =

        String(

          req.params.orderId ||

          ""

        ).trim();

      if (

        !isValidUuid(

          orderId

        )

      ) {

        return res

          .status(400)

          .json({

            success: false,

            code:

              "GUEST_ORDER_ID_INVALID",

            message:

              "El identificador del pedido no es válido",

          });

      }

      const guestToken =

        String(

          req.get(

            "X-Guest-Order-Token"

          ) ||

          ""

        ).trim();

      if (

        guestToken.length <

          20 ||

        guestToken.length >

          200

      ) {

        return res

          .status(401)

          .json({

            success: false,

            code:

              "GUEST_ORDER_TOKEN_INVALID",

            message:

              "El acceso privado del pedido no es válido",

          });

      }

      if (!req.file) {

        return res

          .status(400)

          .json({

            success: false,

            code:

              "BANK_TRANSFER_PROOF_FILE_REQUIRED",

            message:

              "Debes adjuntar el comprobante de transferencia",

          });

      }

      const {

        submitted_amount,

        submitted_bank,

        submitted_reference,

        transfer_date,

      } =

        req.body ||

        {};

      const amount =

        Number(

          submitted_amount

        );

      if (

        !Number.isFinite(

          amount

        ) ||

        amount <= 0

      ) {

        return res

          .status(400)

          .json({

            success: false,

            code:

              "BANK_TRANSFER_PROOF_AMOUNT_INVALID",

            message:

              "El monto transferido debe ser mayor que 0",

          });

      }

      const bank =

        String(

          submitted_bank ||

          ""

        ).trim();

      if (!bank) {

        return res

          .status(400)

          .json({

            success: false,

            code:

              "BANK_TRANSFER_PROOF_BANK_REQUIRED",

            message:

              "Indica el banco desde el cual realizaste la transferencia",

          });

      }

      const reference =

        String(

          submitted_reference ||

          ""

        ).trim();

      if (!reference) {

        return res

          .status(400)

          .json({

            success: false,

            code:

              "BANK_TRANSFER_PROOF_REFERENCE_REQUIRED",

            message:

              "Indica el número de operación o referencia de la transferencia",

          });

      }

      const parsedDate =

        new Date(

          transfer_date

        );

      if (

        !transfer_date ||

        Number.isNaN(

          parsedDate.getTime()

        )

      ) {

        return res

          .status(400)

          .json({

            success: false,

            code:

              "BANK_TRANSFER_DATE_INVALID",

            message:

              "Indica una fecha y hora válida para la transferencia",

          });

      }

      const guestOrder =

        await getGuestCheckoutOrder({

          orderId,

          guestToken,

        });

      const paymentId =

        guestOrder

          ?.payment

          ?.id;

      if (

        !isValidUuid(

          paymentId

        )

      ) {

        return res

          .status(409)

          .json({

            success: false,

            code:

              "GUEST_ORDER_PAYMENT_NOT_FOUND",

            message:

              "El pedido no posee un pago válido asociado",

          });

      }

      storedFile =

        await saveBankTransferProofFile(

          req.file

        );

      const result =

        await submitBankTransferProof({

          paymentId,

          requesterUserId:

            null,

          requesterRole:

            null,

          guestAccessToken:

            guestToken,

          guestOrderId:

            orderId,

          fileUrl:

            storedFile.fileUrl,

          originalFilename:

            storedFile.originalFilename,

          mimeType:

            storedFile.mimeType,

          fileSizeBytes:

            storedFile.fileSizeBytes,

          submittedAmount:

            amount,

          submittedBank:

            bank,

          submittedReference:

            reference,

          transferDate:

            parsedDate.toISOString(),

        });

      return res

        .status(201)

        .json({

          success: true,

          message:

            "Comprobante enviado correctamente. Tu pago quedó pendiente de validación.",

          data: {

            ...result,

            upload: {

              stored: true,

              storage_driver:

                storedFile

                  .storageDriver,

              storage_key:

                storedFile

                  .storageKey,

            },

          },

        });

    } catch (error) {

      if (

        storedFile

          ?.storageKey

      ) {

        try {

          await deleteStoredFile(

            storedFile

              .storageKey

          );

        } catch (

          cleanupError

        ) {

          console.error(

            "Error eliminando comprobante huérfano:",

            {

              message:

                cleanupError

                  .message,

            }

          );

        }

      }

      console.error(

        "Error subiendo comprobante invitado:",

        {

          message:

            error.message,

          code:

            error.code ||

            null,

        }

      );

      return sendError(

        res,

        error,

        "GUEST_BANK_TRANSFER_PROOF_ERROR",

        "No fue posible enviar el comprobante"

      );

    }

  };

/*  =========================================
   PDF TRIBUTARIO DESDE ENLACE DE EMAIL

   No usa JWT ni X-Guest-Order-Token.
   La credencial opaca del enlace es el
   factor de autorización.

   Seguridad:
   - token firmado HMAC + hash SHA-256.
   - valida expiración/revocación.
   - exige pago PAID.
   - exige DTE ACCEPTED por SII.
   - refresca PDF Relbase cuando la URL
     firmada almacenada ya no es usable.
========================================= */
export const getCustomerDocumentPdfController =
  async (
    req,
    res
  ) => {
    try {
      const credential =
        String(
          req.params.credential ||
          ""
        ).trim();

      const requestedFormat =
        String(
          req.query.format ||
          ""
        )
          .trim()
          .toLowerCase();

      const result =
        await resolveCustomerDocumentPdfByCredential(
          credential,
          {
            format:
              requestedFormat,
          }
        );

      res.set(
        "Cache-Control",
        "no-store, private"
      );

      res.set(
        "Referrer-Policy",
        "no-referrer"
      );

      const responseMode =
        String(
          req.query.response ||
          ""
        )
          .trim()
          .toLowerCase();

      if (
        responseMode ===
        "json"
      ) {
        return res
          .status(200)
          .json({
            success: true,
            message:
              "Documento tributario disponible mediante enlace seguro",
            data: {
              authorization:
                "DOCUMENT_ACCESS_TOKEN",
              emission_executed:
                false,
              relbase_post_executed:
                false,
              source:
                result.source,
              relbase_get_executed:
                result.relbase_get_executed,
              persistence_executed:
                result.persistence_executed,
              document:
                result.document,
              format:
                result.format ||
                "original",
              delivery:
                result.kind ===
                "buffer"
                  ? "INLINE_PDF"
                  : "REDIRECT_URL",
              pdf_url:
                result.pdf_url ||
                null,
            },
          });
      }

      if (
        result.kind ===
          "buffer" &&
        Buffer.isBuffer(
          result.pdf_buffer
        )
      ) {
        res.set(
          "Content-Type",
          "application/pdf"
        );

        res.set(
          "Content-Disposition",
          `inline; filename="${String(
            result.filename ||
            "documento-tributario.pdf"
          ).replace(
            /["\r\n]/g,
            ""
          )}"`
        );

        res.set(
          "X-Laminatiword-DTE-Format",
          result.format ||
            "letter"
        );

        return res
          .status(200)
          .send(
            result.pdf_buffer
          );
      }

      if (
        !result.pdf_url
      ) {
        const error =
          new Error(
            "El documento tributario no posee una URL de PDF disponible"
          );

        error.status =
          409;

        error.code =
          "CUSTOMER_DOCUMENT_PDF_URL_MISSING";

        throw error;
      }

      return res.redirect(
        302,
        result.pdf_url
      );
    } catch (error) {
      console.error(
        "Error abriendo documento tributario desde enlace seguro:",
        {
          message:
            error.message,
          code:
            error.code ||
            null,
        }
      );

      return sendError(
        res,
        error,
        "CUSTOMER_DOCUMENT_ACCESS_ERROR",
        "No fue posible abrir el documento tributario"
      );
    }
  };

