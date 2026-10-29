import QRCode from "qrcode";

import {
  createEmailBrandLogoAttachment,
  renderEmailBrandLogo,
} from "../utils/emailBranding.js";

const cleanText = (value) => String(value ?? "").trim();

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const formatMoney = (value, currency = "CLP") => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value ?? "");

  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: cleanText(currency) || "CLP",
    maximumFractionDigits: 0,
  }).format(amount);
};

const getPublicBaseUrl = () => {
  const value = cleanText(process.env.EMAIL_PUBLIC_BASE_URL);

  if (!/^https?:\/\//i.test(value)) {
    const error = new Error(
      "EMAIL_PUBLIC_BASE_URL debe comenzar con http:// o https://"
    );
    error.code = "EMAIL_PUBLIC_BASE_URL_INVALID";
    throw error;
  }

  if (
    String(process.env.NODE_ENV || "").trim().toLowerCase() === "production" &&
    !/^https:\/\//i.test(value)
  ) {
    const error = new Error(
      "EMAIL_PUBLIC_BASE_URL debe usar HTTPS en producción"
    );
    error.code = "EMAIL_PUBLIC_BASE_URL_HTTPS_REQUIRED";
    throw error;
  }

  return value.replace(/\/+$/, "");
};

const buildMessageId = (outboxId) => {
  const fromAddress = cleanText(process.env.EMAIL_FROM_ADDRESS);
  const domain = fromAddress.includes("@")
    ? fromAddress.split("@").pop().replace(/[^a-z0-9.-]/gi, "")
    : "laminati.local";

  return `<email-outbox-${outboxId}@${domain || "laminati.local"}>`;
};

const resolveDocumentFormat = (row) => {
  const payload =
    row?.payload &&
    typeof row.payload ===
      "object"
      ? row.payload
      : {};

  const raw =
    cleanText(
      payload.document_format
    ).toLowerCase();

  if (
    [
      "letter",
      "carta",
      "a4",
    ].includes(raw)
  ) {
    return "letter";
  }

  if (
    [
      "original",
      "pos",
      "80mm",
      "80-mm",
    ].includes(raw)
  ) {
    return "original";
  }

  return cleanText(
    row?.document_type
  ).toUpperCase() ===
    "FACTURA"
    ? "letter"
    : "original";
};

const documentFormatLabel = (
  format
) =>
  format ===
  "letter"
    ? "Carta / A4"
    : "POS / 80 mm";

const buildDocumentUrl = (
  credential,
  format
) => {
  const baseUrl =
    getPublicBaseUrl();

  const params =
    new URLSearchParams();

  if (format) {
    params.set(
      "format",
      format
    );
  }

  const query =
    params.toString();

  return (
    `${baseUrl}/api/checkout/documents/` +
    `${encodeURIComponent(
      credential
    )}/pdf` +
    (
      query
        ? `?${query}`
        : ""
    )
  );
};

const buildDocumentMeta = (row) => {
  const customerName = cleanText(row.customer_name) || "cliente";
  const orderNumber = cleanText(row.order_number);
  const documentType = cleanText(row.document_type).toUpperCase();
  const documentLabel =
    documentType === "FACTURA" ? "Factura electrónica" : "Boleta electrónica";
  const folio = cleanText(row.folio);
  const total = formatMoney(row.order_total, row.currency || "CLP");

  return {
    customerName,
    orderNumber,
    documentType,
    documentLabel,
    folio,
    total,
  };
};


/* =========================================
   COTIZACIÓN · COMPATIBILIDAD
   Mantiene el contrato esperado por
   quotation.service.js:
   buildQuotationEmail({ quotation, to })
========================================= */
export const buildQuotationEmail = ({
  quotation,
  to,
  quotationUrl,
  openPixelUrl,
}) => {
  const recipient =
    cleanText(to) ||
    cleanText(
      quotation?.email
    );

  const quoteNumber =
    cleanText(
      quotation?.quote_number
    ) ||
    "Cotización";

  const customerName =
    cleanText(
      quotation?.customer_name
    ) ||
    cleanText(
      quotation?.legal_name
    ) ||
    "cliente";

  const total =
    formatMoney(
      quotation?.total,
      quotation?.currency ||
        "CLP"
    );

  const validUntil =
    quotation?.valid_until
      ? new Intl.DateTimeFormat(
          "es-CL",
          {
            day:
              "2-digit",
            month:
              "2-digit",
            year:
              "numeric",
          }
        ).format(
          new Date(
            quotation.valid_until
          )
        )
      : "";

  const safeQuotationUrl =
    cleanText(
      quotationUrl
    );

  if (
    !/^https?:\/\//i.test(
      safeQuotationUrl
    )
  ) {
    const error =
      new Error(
        "quotationUrl debe ser una URL absoluta http/https"
      );

    error.code =
      "QUOTATION_EMAIL_VIEW_URL_INVALID";

    throw error;
  }

  const safeOpenPixelUrl =
    cleanText(
      openPixelUrl
    );

  const hasOpenPixel =
    /^https?:\/\//i.test(
      safeOpenPixelUrl
    );

  const subject =
    `Cotización ${quoteNumber} · Laminati`;

  const text = [
    `Hola ${customerName},`,
    "",
    "Tu cotización de Laminati ya está disponible.",
    "",
    `Cotización: ${quoteNumber}`,
    `Total: ${total}`,

    validUntil
      ? `Válida hasta: ${validUntil}`
      : "",

    "",
    "Ver cotización:",
    safeQuotationUrl,
    "",
    "Desde este enlace podrás revisar la cotización y acceder al documento.",
    "",
    "Laminati",
  ]
    .filter(
      Boolean
    )
    .join(
      "\n"
    );

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#171717;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f4;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px;background:#ffffff;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:34px 38px 10px 38px;">
                ${renderEmailBrandLogo({ width: 190 })}
              </td>
            </tr>

            <tr>
              <td style="padding:22px 38px 38px 38px;">
                <div style="font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#777777;">
                  Cotización
                </div>

                <h1 style="margin:10px 0 16px 0;font-size:29px;line-height:1.2;font-weight:600;letter-spacing:-0.8px;">
                  ${escapeHtml(
                    quoteNumber
                  )}
                </h1>

                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:#555555;">
                  Hola ${escapeHtml(
                    customerName
                  )}, tu cotización ya está disponible para revisar.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8f8f8;border-radius:14px;margin:0 0 24px 0;">
                  <tr>
                    <td style="padding:20px 22px 7px 22px;font-size:13px;color:#777777;">
                      Cotización
                    </td>

                    <td align="right" style="padding:20px 22px 7px 22px;font-size:14px;font-weight:700;">
                      ${escapeHtml(
                        quoteNumber
                      )}
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:7px 22px;font-size:13px;color:#777777;">
                      Total
                    </td>

                    <td align="right" style="padding:7px 22px;font-size:14px;font-weight:700;">
                      ${escapeHtml(
                        total
                      )}
                    </td>
                  </tr>

                  ${
                    validUntil
                      ? `<tr>
                    <td style="padding:7px 22px 20px 22px;font-size:13px;color:#777777;">
                      Válida hasta
                    </td>

                    <td align="right" style="padding:7px 22px 20px 22px;font-size:14px;font-weight:700;">
                      ${escapeHtml(
                        validUntil
                      )}
                    </td>
                  </tr>`
                      : ""
                  }
                </table>

                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
                  <tr>
                    <td bgcolor="#111111" style="border-radius:999px;">
                      <a
                        href="${escapeHtml(
                          safeQuotationUrl
                        )}"
                        target="_blank"
                        rel="noopener noreferrer"
                        style="display:inline-block;padding:14px 24px;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:0.2px;"
                      >
                        VER COTIZACIÓN
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0;font-size:14px;line-height:1.7;color:#555555;">
                  Desde el enlace seguro podrás revisar la cotización y acceder al documento. Por seguridad y para mantener la trazabilidad, el PDF ya no se adjunta directamente al correo.
                </p>

                <p style="margin:18px 0 0 0;font-size:11px;line-height:1.6;color:#999999;word-break:break-all;">
                  Si el botón no funciona, copia este enlace en tu navegador:<br>
                  <a
                    href="${escapeHtml(
                      safeQuotationUrl
                    )}"
                    style="color:#777777;text-decoration:underline;"
                  >
                    ${escapeHtml(
                      safeQuotationUrl
                    )}
                  </a>
                </p>
              </td>
            </tr>

            <tr>
              <td style="border-top:1px solid #eeeeee;padding:22px 38px 28px 38px;font-size:11px;line-height:1.6;color:#999999;">
                Correo transaccional de Laminati asociado a la cotización ${escapeHtml(
                  quoteNumber
                )}. El enlace es personal y no debe compartirse.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    ${
      hasOpenPixel
        ? `<img src="${escapeHtml(
            safeOpenPixelUrl
          )}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`
        : ""
    }
  </body>
</html>`;

  return {
    to:
      recipient,
    subject,
    text,
    html,
    attachments: [
      createEmailBrandLogoAttachment(),
    ],
  };
};

export const buildDteAcceptedEmail = async ({
  row,
  documentCredential,
  to,
}) => {
  const documentFormat =
    resolveDocumentFormat(
      row
    );

  const documentUrl =
    buildDocumentUrl(
      documentCredential,
      documentFormat
    );

  const {
    customerName,
    orderNumber,
    documentType,
    documentLabel,
    folio,
    total,
  } = buildDocumentMeta(row);

  const subject = `Pago confirmado | Pedido ${orderNumber}`;

  const text = [
    `Hola ${customerName},`,
    "",
    "Hemos confirmado el pago de tu pedido.",
    "",
    `Pedido: ${orderNumber}`,
    `Total: ${total}`,
    `${documentLabel}: N.º ${folio}`,
    `Formato: ${documentFormatLabel(documentFormat)}`,
    "",
    `Ver ${documentType === "FACTURA" ? "factura" : "boleta"}:`,
    documentUrl,
    "",
    "Estamos preparando tu pedido. Te enviaremos un nuevo correo cuando esté listo para retirar.",
    "",
    "Laminati",
  ].join("\n");

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#171717;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f4;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px;background:#ffffff;border-radius:18px;overflow:hidden;">
            <tr><td style="padding:34px 38px 10px 38px;">${renderEmailBrandLogo({ width: 190 })}</td></tr>
            <tr>
              <td style="padding:22px 38px 38px 38px;">
                <div style="font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#777777;">Pago confirmado</div>
                <h1 style="margin:10px 0 16px 0;font-size:29px;line-height:1.2;font-weight:600;letter-spacing:-0.8px;">Gracias por tu compra</h1>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:#555555;">Hola ${escapeHtml(customerName)}, hemos confirmado el pago de tu pedido y tu documento tributario ya se encuentra disponible.</p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8f8f8;border-radius:14px;margin:0 0 24px 0;">
                  <tr><td style="padding:20px 22px 7px 22px;font-size:13px;color:#777777;">Pedido</td><td align="right" style="padding:20px 22px 7px 22px;font-size:14px;font-weight:700;">${escapeHtml(orderNumber)}</td></tr>
                  <tr><td style="padding:7px 22px;font-size:13px;color:#777777;">Total</td><td align="right" style="padding:7px 22px;font-size:14px;font-weight:700;">${escapeHtml(total)}</td></tr>
                  <tr><td style="padding:7px 22px;font-size:13px;color:#777777;">Documento</td><td align="right" style="padding:7px 22px;font-size:14px;font-weight:700;">${escapeHtml(documentLabel)} N.º ${escapeHtml(folio)}</td></tr>
                  <tr><td style="padding:7px 22px 20px 22px;font-size:13px;color:#777777;">Formato</td><td align="right" style="padding:7px 22px 20px 22px;font-size:14px;font-weight:700;">${escapeHtml(documentFormatLabel(documentFormat))}</td></tr>
                </table>

                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px 0;">
                  <tr><td bgcolor="#111111" style="border-radius:999px;"><a href="${escapeHtml(documentUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 24px;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;">VER ${documentType === "FACTURA" ? "FACTURA" : "BOLETA"}</a></td></tr>
                </table>

                <p style="margin:0;font-size:14px;line-height:1.7;color:#555555;">Estamos preparando tu pedido. Te enviaremos un nuevo correo cuando esté listo para retirar.</p>
              </td>
            </tr>
            <tr><td style="border-top:1px solid #eeeeee;padding:22px 38px 28px 38px;font-size:11px;line-height:1.6;color:#999999;">Correo transaccional asociado al pedido ${escapeHtml(orderNumber)}. El enlace del documento es personal y no debe compartirse.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    to,
    subject,
    text,
    html,
    messageId: buildMessageId(row.id),
    attachments: [
      createEmailBrandLogoAttachment(),
    ],
  };
};

export const buildReadyForPickupEmail = async ({
  row,
  documentCredential,
  pickupCredential,
  to,
}) => {
  const documentFormat =
    resolveDocumentFormat(
      row
    );

  const documentUrl =
    buildDocumentUrl(
      documentCredential,
      documentFormat
    );
  const {
    customerName,
    orderNumber,
    documentType,
    documentLabel,
    folio,
    total,
  } = buildDocumentMeta(row);

  const subject = `Tu pedido está listo para retirar | Pedido ${orderNumber}`;
  const qrCid = `pickup-qr-${row.id}@laminatiword`;

  const qrPng = await QRCode.toBuffer(pickupCredential, {
    type: "png",
    errorCorrectionLevel: "M",
    width: 320,
    margin: 2,
  });

  const text = [
    `Hola ${customerName},`,
    "",
    "Tu pedido ya está listo para retirar.",
    "",
    `Pedido: ${orderNumber}`,
    `Total: ${total}`,
    `${documentLabel}: N.º ${folio}`,
    "",
    "Presenta el código QR incluido en este correo al momento de retirar tu compra.",
    "El código es personal y de un solo uso.",
    "",
    "Ver documento tributario:",
    documentUrl,
    "",
    "Laminati",
  ].join("\n");

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#171717;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f4;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:620px;background:#ffffff;border-radius:18px;overflow:hidden;">
            <tr><td style="padding:34px 38px 10px 38px;">${renderEmailBrandLogo({ width: 190 })}</td></tr>
            <tr>
              <td style="padding:22px 38px 38px 38px;">
                <div style="font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#777777;">Listo para retiro</div>
                <h1 style="margin:10px 0 16px 0;font-size:29px;line-height:1.2;font-weight:600;letter-spacing:-0.8px;">Tu pedido está listo</h1>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:#555555;">Hola ${escapeHtml(customerName)}, tu pedido ya se encuentra disponible para retiro.</p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8f8f8;border-radius:14px;margin:0 0 26px 0;">
                  <tr><td style="padding:20px 22px 7px 22px;font-size:13px;color:#777777;">Pedido</td><td align="right" style="padding:20px 22px 7px 22px;font-size:14px;font-weight:700;">${escapeHtml(orderNumber)}</td></tr>
                  <tr><td style="padding:7px 22px;font-size:13px;color:#777777;">Total</td><td align="right" style="padding:7px 22px;font-size:14px;font-weight:700;">${escapeHtml(total)}</td></tr>
                  <tr><td style="padding:7px 22px 20px 22px;font-size:13px;color:#777777;">Documento</td><td align="right" style="padding:7px 22px 20px 22px;font-size:14px;font-weight:700;">${escapeHtml(documentLabel)} N.º ${escapeHtml(folio)}</td></tr>
                </table>

                <div style="text-align:center;margin:8px 0 24px 0;">
                  <div style="font-size:13px;font-weight:700;margin-bottom:14px;">Código QR de retiro</div>
                  <img src="cid:${escapeHtml(qrCid)}" width="260" height="260" alt="Código QR de retiro" style="display:block;width:260px;height:260px;max-width:100%;margin:0 auto;border:1px solid #eeeeee;border-radius:16px;" />
                  <p style="margin:14px auto 0 auto;max-width:420px;font-size:12px;line-height:1.6;color:#777777;">Presenta este QR al momento de retirar tu compra. Es personal y de un solo uso.</p>
                </div>

                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 8px auto;">
                  <tr><td bgcolor="#111111" style="border-radius:999px;"><a href="${escapeHtml(documentUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 24px;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;">VER ${documentType === "FACTURA" ? "FACTURA" : "BOLETA"}</a></td></tr>
                </table>
              </td>
            </tr>
            <tr><td style="border-top:1px solid #eeeeee;padding:22px 38px 28px 38px;font-size:11px;line-height:1.6;color:#999999;">Correo transaccional asociado al pedido ${escapeHtml(orderNumber)}. No compartas el QR ni el enlace del documento.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    to,
    subject,
    text,
    html,
    messageId: buildMessageId(row.id),
    attachments: [
      createEmailBrandLogoAttachment(),
      {
        filename: `qr-retiro-${orderNumber}.png`,
        content: qrPng,
        contentType: "image/png",
        cid: qrCid,
        contentDisposition: "inline",
      },
    ],
  };
};

/* =========================================
   NUEVA COTIZACIÓN PROJECT · GERENCIA ITALIA
   - Sin nombre de cliente.
   - Sin RUT.
   - Sin referencia.
========================================= */
const formatUsd = (
  value
) => {
  const amount =
    Number(
      value
    );

  if (
    !Number.isFinite(
      amount
    )
  ) {
    return "—";
  }

  return new Intl.NumberFormat(
    "es-CL",
    {
      style:
        "currency",
      currency:
        "USD",
      minimumFractionDigits:
        2,
      maximumFractionDigits:
        2,
    }
  ).format(
    amount
  );
};

const formatSimpleDate = (
  value
) => {
  const raw =
    cleanText(
      value
    );

  const match =
    raw.match(
      /^(\d{4})-(\d{2})-(\d{2})/
    );

  if (
    match
  ) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }

  const date =
    new Date(
      value
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "—";
  }

  return new Intl.DateTimeFormat(
    "es-CL",
    {
      day:
        "2-digit",
      month:
        "2-digit",
      year:
        "numeric",
    }
  )
    .format(
      date
    )
    .replaceAll(
      "/",
      "-"
    );
};

const PROJECT_STATUS_LABELS = {
  DRAFT:
    "Borrador",
  SENT:
    "Enviada",
  REVIEW:
    "En revisión",
  NEGOTIATION:
    "Negociación",
  APPROVED:
    "Aprobada",
  WON:
    "Ganada",
  LOST:
    "Perdida",
  ACCEPTED:
    "Aprobada",
  CONVERTED:
    "Ganada",
  REJECTED:
    "Perdida",
  EXPIRED:
    "Perdida",
  CANCELLED:
    "Perdida",
};

const buildGerenciaQuotationUrl = () => {
  const value =
    cleanText(
      process.env
        .EMAIL_GERENCIA_BASE_URL
    );

  if (
    !/^https?:\/\//i.test(
      value
    )
  ) {
    const error =
      new Error(
        "EMAIL_GERENCIA_BASE_URL debe comenzar con http:// o https://"
      );

    error.code =
      "EMAIL_GERENCIA_BASE_URL_INVALID";

    throw error;
  }

  if (
    String(
      process.env
        .NODE_ENV ||
        ""
    )
      .trim()
      .toLowerCase() ===
      "production" &&
    !/^https:\/\//i.test(
      value
    )
  ) {
    const error =
      new Error(
        "EMAIL_GERENCIA_BASE_URL debe usar HTTPS en producción"
      );

    error.code =
      "EMAIL_GERENCIA_BASE_URL_HTTPS_REQUIRED";

    throw error;
  }

  return (
    value.replace(
      /\/+$/,
      ""
    ) +
    "/gerencia/cotizaciones-proyectos"
  );
};

export const buildProjectQuotationItalyEmail =
  ({
    row,
    to,
  }) => {
    const payload =
      row?.payload &&
      typeof row.payload ===
        "object"
        ? row.payload
        : {};

    const recipient =
      cleanText(
        to
      ) ||
      cleanText(
        row
          ?.recipient_email
      );

    const quoteNumber =
      cleanText(
        payload
          .quote_number
      ) ||
      "Cotización";

    const projectName =
      cleanText(
        payload
          .project_name
      ) ||
      "Proyecto";

    const status =
      cleanText(
        payload.status
      ).toUpperCase();

    const statusLabel =
      PROJECT_STATUS_LABELS[
        status
      ] ||
      status ||
      "Borrador";

    const createdAt =
      formatSimpleDate(
        payload
          .created_at
      );

    const validUntil =
      formatSimpleDate(
        payload
          .valid_until
      );

    const lines =
      Array.isArray(
        payload.lines
      )
        ? payload.lines
        : [];

    const products =
      lines.filter(
        (line) =>
          cleanText(
            line
              ?.line_type
          ).toUpperCase() ===
          "PRODUCT"
      );

    const services =
      lines.filter(
        (line) =>
          [
            "SERVICE",
            "OTHER",
          ].includes(
            cleanText(
              line
                ?.line_type
            ).toUpperCase()
          )
      );

    const totalValueUsd =
      Number(
        payload
          .total_value_usd
      );

    const quotationUrl =
      buildGerenciaQuotationUrl();

    const productRows =
      products.length >
      0
        ? products
            .map(
              (
                line
              ) => {
                const unitPrice =
                  line
                    .italy_unit_price_usd;

                const total =
                  line
                    .italy_total_usd;

                const thickness =
                  line
                    .thickness_mm ===
                  null ||
                  line
                    .thickness_mm ===
                  undefined
                    ? "—"
                    : `${escapeHtml(
                        line
                          .thickness_mm
                      )} mm`;

                return `
                  <tr>
                    <td style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                      ${escapeHtml(
                        line.description ||
                          "Producto"
                      )}
                    </td>
                    <td style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                      ${escapeHtml(
                        line.code ||
                          "—"
                      )}
                    </td>
                    <td style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                      ${escapeHtml(
                        line.finish ||
                          "—"
                      )}
                    </td>
                    <td style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                      ${thickness}
                    </td>
                    <td align="right" style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                      ${escapeHtml(
                        line.quantity
                      )}
                    </td>
                    <td style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                      ${escapeHtml(
                        line.format_label ||
                          line.unit ||
                          "—"
                      )}
                    </td>
                    <td align="right" style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                      ${
                        unitPrice ===
                        null
                          ? '<span style="color:#b45309;">Sin valorizar</span>'
                          : escapeHtml(
                              formatUsd(
                                unitPrice
                              )
                            )
                      }
                    </td>
                    <td align="right" style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;font-weight:700;color:#171717;">
                      ${
                        total ===
                        null
                          ? '<span style="color:#b45309;">—</span>'
                          : escapeHtml(
                              formatUsd(
                                total
                              )
                            )
                      }
                    </td>
                  </tr>
                `;
              }
            )
            .join(
              ""
            )
        : `
          <tr>
            <td colspan="8" style="padding:14px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#777777;">
              Sin productos valorizados para Gerencia Italia.
            </td>
          </tr>
        `;

    const serviceRows =
      services.length >
      0
        ? services
            .map(
              (
                line
              ) => `
                <tr>
                  <td style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                    ${escapeHtml(
                      line.description ||
                        "Servicio"
                    )}
                  </td>
                  <td align="right" style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                    ${escapeHtml(
                      line.quantity
                    )}
                  </td>
                  <td align="right" style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#171717;">
                    ${
                      line
                        .italy_unit_price_usd ===
                      null
                        ? '<span style="color:#b45309;">Sin valorizar</span>'
                        : escapeHtml(
                            formatUsd(
                              line
                                .italy_unit_price_usd
                            )
                          )
                    }
                  </td>
                  <td align="right" style="padding:11px 10px;border-top:1px solid #eeeeee;font-size:12px;font-weight:700;color:#171717;">
                    ${
                      line
                        .italy_total_usd ===
                      null
                        ? '<span style="color:#b45309;">—</span>'
                        : escapeHtml(
                            formatUsd(
                              line
                                .italy_total_usd
                            )
                          )
                    }
                  </td>
                </tr>
              `
            )
            .join(
              ""
            )
        : `
          <tr>
            <td colspan="4" style="padding:14px 10px;border-top:1px solid #eeeeee;font-size:12px;color:#777777;">
              Sin servicios o fletes.
            </td>
          </tr>
        `;

    const subject =
      `Nueva cotización de proyecto ${quoteNumber} · Laminati`;

    const text = [
      "Laminati",
      "",
      "NUEVA COTIZACIÓN DE PROYECTO",
      quoteNumber,
      "",
      "Hola,",
      "Se ha generado una nueva cotización de proyecto que ya está disponible para revisar en Gerencia Italia.",
      "",
      `Proyecto: ${projectName}`,
      `Fecha: ${createdAt}`,
      `Válida hasta: ${validUntil}`,
      `Estado: ${statusLabel}`,
      "",
      ...products.map(
        (
          line
        ) =>
          `${line.description || "Producto"} · ${line.code || "—"} · ${line.quantity} × ${
            line.italy_unit_price_usd === null
              ? "Sin valorizar"
              : formatUsd(
                  line.italy_unit_price_usd
                )
          } = ${
            line.italy_total_usd === null
              ? "—"
              : formatUsd(
                  line.italy_total_usd
                )
          }`
      ),
      "",
      ...services.map(
        (
          line
        ) =>
          `${line.description || "Servicio"} · ${line.quantity} × ${
            line.italy_unit_price_usd === null
              ? "Sin valorizar"
              : formatUsd(
                  line.italy_unit_price_usd
                )
          } = ${
            line.italy_total_usd === null
              ? "—"
              : formatUsd(
                  line.italy_total_usd
                )
          }`
      ),
      "",
      `TOTAL COTIZACIÓN (USD): ${
        Number.isFinite(
          totalValueUsd
        )
          ? formatUsd(
              totalValueUsd
            )
          : "—"
      }`,
      "",
      "Ver cotización:",
      quotationUrl,
      "",
      "Laminati · Gerencia Italia",
    ]
      .filter(
        Boolean
      )
      .join(
        "\n"
      );

    const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:0;background:#f4f4f3;font-family:Arial,Helvetica,sans-serif;color:#171717;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f4f3;padding:30px 14px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:780px;background:#ffffff;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:30px 32px 8px 32px;">
                ${renderEmailBrandLogo({ width: 200 })}
              </td>
            </tr>

            <tr>
              <td style="padding:22px 32px 32px 32px;">
                <div style="font-size:11px;font-weight:700;letter-spacing:1.7px;text-transform:uppercase;color:#777777;">
                  Nueva cotización de proyecto
                </div>

                <h1 style="margin:10px 0 14px 0;font-size:29px;line-height:1.15;font-weight:700;letter-spacing:-0.8px;">
                  ${escapeHtml(
                    quoteNumber
                  )}
                </h1>

                <p style="margin:0 0 22px 0;font-size:15px;line-height:1.55;color:#666666;">
                  Hola,<br>
                  Se ha generado una nueva cotización de proyecto que ya está disponible para revisar en Gerencia Italia.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f7f7f6;border-radius:14px;margin:0 0 24px 0;">
                  <tr>
                    <td width="52%" style="padding:18px 20px;vertical-align:top;">
                      <div style="font-size:12px;color:#777777;">Proyecto</div>
                      <div style="margin-top:5px;font-size:14px;font-weight:700;color:#171717;">
                        ${escapeHtml(
                          projectName
                        )}
                      </div>

                      <div style="margin-top:14px;font-size:12px;color:#777777;">Fecha</div>
                      <div style="margin-top:5px;font-size:14px;color:#171717;">
                        ${escapeHtml(
                          createdAt
                        )}
                      </div>
                    </td>

                    <td width="48%" style="padding:18px 20px;vertical-align:top;border-left:1px solid #e8e8e6;">
                      <div style="font-size:12px;color:#777777;">Válida hasta</div>
                      <div style="margin-top:5px;font-size:14px;color:#171717;">
                        ${escapeHtml(
                          validUntil
                        )}
                      </div>

                      <div style="margin-top:14px;font-size:12px;color:#777777;">Estado</div>
                      <div style="margin-top:6px;display:inline-block;padding:5px 10px;background:#eaf2ff;color:#2563eb;border-radius:999px;font-size:11px;font-weight:700;">
                        ${escapeHtml(
                          statusLabel
                        )}
                      </div>
                    </td>
                  </tr>
                </table>

                <div style="font-size:15px;font-weight:700;margin:0 0 10px 0;">
                  Productos de proyecto
                </div>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #eeeeec;border-radius:12px;border-collapse:separate;border-spacing:0;overflow:hidden;margin-bottom:24px;">
                  <tr style="background:#f7f7f6;">
                    <th align="left" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Producto</th>
                    <th align="left" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Código</th>
                    <th align="left" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Acabado</th>
                    <th align="left" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Espesor</th>
                    <th align="right" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Cantidad</th>
                    <th align="left" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Formato</th>
                    <th align="right" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Valor unit. USD</th>
                    <th align="right" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Total USD</th>
                  </tr>
                  ${productRows}
                </table>

                <div style="font-size:15px;font-weight:700;margin:0 0 10px 0;">
                  Servicios y otros
                </div>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #eeeeec;border-radius:12px;border-collapse:separate;border-spacing:0;overflow:hidden;margin-bottom:12px;">
                  <tr style="background:#f7f7f6;">
                    <th align="left" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Descripción</th>
                    <th align="right" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Cantidad</th>
                    <th align="right" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Valor unit. USD</th>
                    <th align="right" style="padding:10px;font-size:10px;color:#777777;text-transform:uppercase;">Total USD</th>
                  </tr>
                  ${serviceRows}
                </table>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6efe6;border-radius:12px;margin:0 0 22px 0;">
                  <tr>
                    <td align="right" style="padding:15px 18px;font-size:13px;font-weight:700;color:#171717;">
                      TOTAL COTIZACIÓN (USD)
                    </td>
                    <td width="180" align="right" style="padding:15px 18px;font-size:21px;font-weight:700;color:#171717;">
                      ${escapeHtml(
                        Number.isFinite(
                          totalValueUsd
                        )
                          ? formatUsd(
                              totalValueUsd
                            )
                          : "—"
                      )}
                    </td>
                  </tr>
                </table>

                <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto 22px auto;">
                  <tr>
                    <td bgcolor="#111111" style="border-radius:999px;">
                      <a
                        href="${escapeHtml(
                          quotationUrl
                        )}"
                        target="_blank"
                        rel="noopener noreferrer"
                        style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;"
                      >
                        VER COTIZACIÓN&nbsp;&nbsp;→
                      </a>
                    </td>
                  </tr>
                </table>

                <div style="border-top:1px solid #e8e8e6;padding-top:18px;">
                  <p style="margin:0;font-size:13px;line-height:1.55;color:#666666;">
                    Desde este enlace seguro podrás revisar la cotización disponible en Gerencia Italia.
                  </p>

                  <p style="margin:14px 0 0 0;font-size:11px;line-height:1.55;color:#999999;word-break:break-all;">
                    Si el botón no funciona, copia este enlace en tu navegador:<br>
                    <a
                      href="${escapeHtml(
                        quotationUrl
                      )}"
                      style="color:#777777;text-decoration:underline;"
                    >
                      ${escapeHtml(
                        quotationUrl
                      )}
                    </a>
                  </p>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

    return {
      to:
        recipient,
      subject,
      text,
      html,
      messageId:
        buildMessageId(
          row.id
        ),
      attachments: [
        createEmailBrandLogoAttachment(),
      ],
    };
  };

