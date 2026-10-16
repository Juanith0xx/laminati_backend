import {
  ensureDteAcceptedEmailArtifacts,
} from "../services/emailOutbox.service.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const cleanText = (
  value
) =>
  String(
    value ?? ""
  ).trim();

export const sendTaxDocumentEmailWithFormatController =
  async (
    req,
    res
  ) => {
    const taxDocumentId =
      cleanText(
        req.params.taxDocumentId
      );

    if (
      !UUID_PATTERN.test(
        taxDocumentId
      )
    ) {
      return res
        .status(400)
        .json({
          success: false,
          code:
            "INVALID_TAX_DOCUMENT_ID",
          message:
            "taxDocumentId no es un UUID válido",
        });
    }

    try {
      const result =
        await ensureDteAcceptedEmailArtifacts({
          taxDocumentId,
          recipientEmailOverride:
            cleanText(
              req.body?.recipient_email
            ),
          documentFormat:
            cleanText(
              req.body?.document_format
            ),
          forceResend:
            true,
        });

      const format =
        cleanText(
          result?.outbox
            ?.payload
            ?.document_format
        ) ||
        null;

      return res
        .status(202)
        .json({
          success: true,
          message:
            "Documento encolado para envío por correo.",
          data: {
            tax_document_id:
              taxDocumentId,
            recipient_email:
              result?.outbox
                ?.recipient_email ||
              null,
            document_format:
              format,
            outbox_id:
              result?.outbox?.id ||
              null,
            outbox_status:
              result?.outbox
                ?.status ||
              null,
            event_created:
              result
                ?.event_created ===
              true,
            manual_resend_queued:
              result
                ?.manual_resend_queued ===
              true,
            document_access_expires_at:
              result
                ?.document_access
                ?.expires_at ||
              null,
          },
        });
    } catch (error) {
      console.error(
        "Error encolando DTE por correo:",
        {
          message:
            error?.message ||
            null,
          code:
            error?.code ||
            null,
        }
      );

      const status =
        Number(
          error?.status
        );

      return res
        .status(
          Number.isInteger(
            status
          ) &&
          status >= 400 &&
          status < 600
            ? status
            : 500
        )
        .json({
          success: false,
          code:
            error?.code ||
            "TAX_DOCUMENT_EMAIL_ERROR",
          message:
            error?.message ||
            "No fue posible encolar el documento por correo.",
        });
    }
  };
