import QRCode from "qrcode";

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
                <div style="font-size:25px;font-weight:700;letter-spacing:-0.4px;">Laminati</div>
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
    attachments:
      [],
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
            <tr><td style="padding:34px 38px 10px 38px;"><div style="font-size:25px;font-weight:700;letter-spacing:-0.4px;">Laminati</div></td></tr>
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
    attachments: [],
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
            <tr><td style="padding:34px 38px 10px 38px;"><div style="font-size:25px;font-weight:700;letter-spacing:-0.4px;">Laminati</div></td></tr>
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
