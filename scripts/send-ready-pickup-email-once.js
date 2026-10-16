import dotenv from "dotenv";
import crypto from "crypto";
import QRCode from "qrcode";

dotenv.config();

const OUTBOX_ID =
  String(
    process.argv[2] ||
      ""
  ).trim();

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (
  !UUID_PATTERN.test(
    OUTBOX_ID
  )
) {
  console.error(
    "Uso: node .\\scripts\\send-ready-pickup-email-once.js <OUTBOX_UUID>"
  );

  process.exit(1);
}

const [
  { default: pool },
  documentAccessModule,
  pickupModule,
  emailTransportModule,
] =
  await Promise.all([
    import(
      "../src/config/database.js"
    ),

    import(
      "../src/services/customerDocumentAccess.service.js"
    ),

    import(
      "../src/services/pickup.service.js"
    ),

    import(
      "../src/services/emailTransport.service.js"
    ),
  ]);

const {
  buildCustomerDocumentAccessCredential,
} =
  documentAccessModule;

const {
  buildPickupQrToken,
  hashPickupQrToken,
} =
  pickupModule;

const {
  verifyEmailTransport,
  sendTransactionalEmail,
} =
  emailTransportModule;

const cleanText = (
  value
) =>
  String(
    value ??
      ""
  ).trim();

const isTrue = (
  value
) =>
  [
    "1",
    "true",
    "yes",
    "on",
  ].includes(
    cleanText(
      value
    ).toLowerCase()
  );

const hashCredential = (
  credential
) =>
  crypto
    .createHash(
      "sha256"
    )
    .update(
      String(
        credential
      ),
      "utf8"
    )
    .digest(
      "hex"
    );

const safeHashMatches = (
  expected,
  candidate
) => {
  const a =
    cleanText(
      expected
    ).toLowerCase();

  const b =
    cleanText(
      candidate
    ).toLowerCase();

  if (
    a.length !==
      64 ||
    b.length !==
      64
  ) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(
        a,
        "hex"
      ),
      Buffer.from(
        b,
        "hex"
      )
    );
  } catch {
    return false;
  }
};

const escapeHtml = (
  value
) =>
  String(
    value ??
      ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );

const formatMoney = (
  value,
  currency =
    "CLP"
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
    return String(
      value ??
        ""
    );
  }

  return new Intl.NumberFormat(
    "es-CL",
    {
      style:
        "currency",

      currency:
        cleanText(
          currency
        ) ||
        "CLP",

      maximumFractionDigits:
        0,
    }
  ).format(
    amount
  );
};

const getPublicBaseUrl =
  () => {
    const value =
      cleanText(
        process.env
          .EMAIL_PUBLIC_BASE_URL
      );

    if (
      !/^https?:\/\//i.test(
        value
      )
    ) {
      throw new Error(
        "EMAIL_PUBLIC_BASE_URL debe comenzar con http:// o https://"
      );
    }

    return value.replace(
      /\/+$/,
      ""
    );
  };

const buildMessageId = (
  outboxId
) => {
  const fromAddress =
    cleanText(
      process.env
        .EMAIL_FROM_ADDRESS
    );

  const domain =
    fromAddress.includes(
      "@"
    )
      ? fromAddress
          .split("@")
          .pop()
          .replace(
            /[^a-z0-9.-]/gi,
            ""
          )
      : "laminati.local";

  return (
    `<email-outbox-${outboxId}@` +
    `${domain || "laminati.local"}>`
  );
};

const loadAndValidateEvent =
  async (
    outboxId
  ) => {
    const result =
      await pool.query(
        `
          SELECT
            eo.id,
            eo.order_id,
            eo.tax_document_id,
            eo.pickup_id,
            eo.event_type,
            eo.recipient_email,
            eo.status,
            eo.attempts,
            eo.max_attempts,
            eo.payload,

            o.order_number,
            o.customer_name,
            o.email AS order_email,
            o.payment_status AS order_payment_status,
            o.status AS order_status,
            o.fulfillment_status,
            o.total AS order_total,
            o.currency,

            td.document_type,
            td.status AS tax_document_status,
            td.sii_status,
            td.sii_status_name,
            td.folio,

            p.status AS payment_status,

            sp.status AS pickup_status,
            sp.token_hash AS pickup_token_hash,
            sp.generated_at AS pickup_generated_at,
            sp.expires_at AS pickup_expires_at,
            sp.used_at AS pickup_used_at,
            sp.revoked_at AS pickup_revoked_at,

            cdat.id AS access_id,
            cdat.order_id AS access_order_id,
            cdat.tax_document_id AS access_tax_document_id,
            cdat.token_hash AS document_token_hash,
            cdat.expires_at AS document_expires_at,
            cdat.revoked_at AS document_revoked_at,
            cdat.created_at AS access_created_at

          FROM email_outbox eo

          INNER JOIN orders o
            ON o.id = eo.order_id

          INNER JOIN tax_documents td
            ON td.id =
              eo.tax_document_id

          INNER JOIN payments p
            ON p.order_id =
              o.id
           AND p.status =
              'PAID'

          INNER JOIN store_pickups sp
            ON sp.id =
              eo.pickup_id
           AND sp.order_id =
              eo.order_id

          INNER JOIN customer_document_access_tokens cdat
            ON cdat.id =
              NULLIF(
                eo.payload
                  ->>'document_access_id',
                ''
              )::uuid
           AND cdat.order_id =
              eo.order_id
           AND cdat.tax_document_id =
              eo.tax_document_id

          WHERE eo.id = $1

          LIMIT 1
        `,
        [
          outboxId,
        ]
      );

    if (
      result.rowCount ===
      0
    ) {
      throw new Error(
        "No fue posible cargar un evento ORDER_READY_FOR_PICKUP válido"
      );
    }

    const row =
      result.rows[0];

    const payload =
      row.payload &&
      typeof row.payload ===
        "object"
        ? row.payload
        : {};

    if (
      cleanText(
        row.event_type
      ) !==
        "ORDER_READY_FOR_PICKUP"
    ) {
      throw new Error(
        "Este script sólo procesa eventos ORDER_READY_FOR_PICKUP"
      );
    }

    if (
      cleanText(
        row.order_payment_status
      ).toUpperCase() !==
        "PAID" ||
      cleanText(
        row.payment_status
      ).toUpperCase() !==
        "PAID"
    ) {
      throw new Error(
        "La orden y su pago deben estar PAID"
      );
    }

    if (
      cleanText(
        row.order_status
      ).toUpperCase() ===
        "CANCELLED"
    ) {
      throw new Error(
        "La orden se encuentra cancelada"
      );
    }

    if (
      cleanText(
        row.fulfillment_status
      ).toUpperCase() !==
        "READY_FOR_PICKUP"
    ) {
      throw new Error(
        "La orden no se encuentra READY_FOR_PICKUP"
      );
    }

    if (
      cleanText(
        row.pickup_status
      ).toUpperCase() !==
        "ACTIVE"
    ) {
      throw new Error(
        "El retiro no se encuentra ACTIVE"
      );
    }

    if (
      row.pickup_used_at
    ) {
      throw new Error(
        "El retiro ya fue utilizado"
      );
    }

    if (
      row.pickup_revoked_at
    ) {
      throw new Error(
        "El retiro fue revocado"
      );
    }

    const pickupExpiresAt =
      new Date(
        row.pickup_expires_at
      );

    if (
      Number.isNaN(
        pickupExpiresAt.getTime()
      ) ||
      pickupExpiresAt.getTime() <=
        Date.now()
    ) {
      throw new Error(
        "El QR de retiro está expirado"
      );
    }

    if (
      cleanText(
        row.tax_document_status
      ).toUpperCase() !==
        "ACCEPTED"
    ) {
      throw new Error(
        "El DTE no se encuentra ACCEPTED"
      );
    }

    if (
      ![
        "accepted",
        "aceptado",
      ].includes(
        cleanText(
          row.sii_status
        ).toLowerCase()
      )
    ) {
      throw new Error(
        "El DTE no se encuentra aceptado por el SII"
      );
    }

    if (
      row.document_revoked_at
    ) {
      throw new Error(
        "El acceso documental está revocado"
      );
    }

    const documentExpiresAt =
      new Date(
        row.document_expires_at
      );

    if (
      Number.isNaN(
        documentExpiresAt.getTime()
      ) ||
      documentExpiresAt.getTime() <=
        Date.now()
    ) {
      throw new Error(
        "El acceso documental está expirado"
      );
    }

    if (
      cleanText(
        payload.schema
      ) !==
        "LAMINATIWORD_EMAIL_EVENT_V1"
    ) {
      throw new Error(
        "El payload del evento no posee el schema esperado"
      );
    }

    if (
      cleanText(
        payload.order_number
      ) !==
        cleanText(
          row.order_number
        )
    ) {
      throw new Error(
        "El número de pedido del payload no coincide"
      );
    }

    if (
      cleanText(
        payload.pickup_id
      ) !==
        cleanText(
          row.pickup_id
        )
    ) {
      throw new Error(
        "El pickup del payload no coincide"
      );
    }

    if (
      cleanText(
        payload.document_type
      ) !==
        cleanText(
          row.document_type
        )
    ) {
      throw new Error(
        "El tipo de documento del payload no coincide"
      );
    }

    if (
      cleanText(
        payload.folio
      ) !==
        cleanText(
          row.folio
        )
    ) {
      throw new Error(
        "El folio del payload no coincide"
      );
    }

    if (
      cleanText(
        payload.document_access_id
      ) !==
        cleanText(
          row.access_id
        )
    ) {
      throw new Error(
        "El acceso documental del payload no coincide"
      );
    }

    const payloadTotal =
      Number(
        payload.total
      );

    const orderTotal =
      Number(
        row.order_total
      );

    if (
      Number.isFinite(
        payloadTotal
      ) &&
      Number.isFinite(
        orderTotal
      ) &&
      Math.abs(
        payloadTotal -
          orderTotal
      ) >
        0.01
    ) {
      throw new Error(
        "El total del payload no coincide con el pedido"
      );
    }

    const documentCredential =
      buildCustomerDocumentAccessCredential({
        id:
          row.access_id,

        created_at:
          row.access_created_at,
      });

    if (
      !safeHashMatches(
        row.document_token_hash,
        hashCredential(
          documentCredential
        )
      )
    ) {
      throw new Error(
        "La credencial documental reconstruida no coincide con el hash almacenado"
      );
    }

    const pickupCredential =
      buildPickupQrToken(
        row.pickup_id,
        row.pickup_generated_at
      );

    if (
      !safeHashMatches(
        row.pickup_token_hash,
        hashPickupQrToken(
          pickupCredential
        )
      )
    ) {
      throw new Error(
        "La credencial QR reconstruida no coincide con el hash almacenado"
      );
    }

    return {
      row,
      payload,
      documentCredential,
      pickupCredential,
    };
  };

const buildEmail =
  async ({
    row,
    documentCredential,
    pickupCredential,
    to,
  }) => {
    const baseUrl =
      getPublicBaseUrl();

    const documentUrl =
      `${baseUrl}/api/checkout/documents/` +
      `${encodeURIComponent(
        documentCredential
      )}/pdf`;

    const customerName =
      cleanText(
        row.customer_name
      ) ||
      "cliente";

    const orderNumber =
      cleanText(
        row.order_number
      );

    const documentType =
      cleanText(
        row.document_type
      ).toUpperCase();

    const documentLabel =
      documentType ===
        "FACTURA"
        ? "Factura electrónica"
        : "Boleta electrónica";

    const folio =
      cleanText(
        row.folio
      );

    const total =
      formatMoney(
        row.order_total,
        row.currency ||
          "CLP"
      );

    const subject =
      `Tu pedido está listo para retirar | Pedido ${orderNumber}`;

    const qrCid =
      `pickup-qr-${row.id}@laminatiword`;

    const qrPng =
      await QRCode.toBuffer(
        pickupCredential,
        {
          type:
            "png",

          errorCorrectionLevel:
            "M",

          width:
            320,

          margin:
            2,
        }
      );

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
    ].join(
      "\n"
    );

    const html =
      `<!doctype html>
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
                <div style="font-size:12px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#777777;">Listo para retiro</div>

                <h1 style="margin:10px 0 16px 0;font-size:29px;line-height:1.2;font-weight:600;letter-spacing:-0.8px;">
                  Tu pedido está listo
                </h1>

                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.7;color:#555555;">
                  Hola ${escapeHtml(
                    customerName
                  )}, tu pedido ya se encuentra disponible para retiro.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f8f8f8;border-radius:14px;margin:0 0 26px 0;">
                  <tr>
                    <td style="padding:20px 22px 7px 22px;font-size:13px;color:#777777;">Pedido</td>
                    <td align="right" style="padding:20px 22px 7px 22px;font-size:14px;font-weight:700;">${escapeHtml(
                      orderNumber
                    )}</td>
                  </tr>

                  <tr>
                    <td style="padding:7px 22px;font-size:13px;color:#777777;">Total</td>
                    <td align="right" style="padding:7px 22px;font-size:14px;font-weight:700;">${escapeHtml(
                      total
                    )}</td>
                  </tr>

                  <tr>
                    <td style="padding:7px 22px 20px 22px;font-size:13px;color:#777777;">Documento</td>
                    <td align="right" style="padding:7px 22px 20px 22px;font-size:14px;font-weight:700;">${escapeHtml(
                      documentLabel
                    )} N.º ${escapeHtml(
                      folio
                    )}</td>
                  </tr>
                </table>

                <div style="text-align:center;margin:8px 0 24px 0;">
                  <div style="font-size:13px;font-weight:700;margin-bottom:14px;">Código QR de retiro</div>

                  <img
                    src="cid:${escapeHtml(
                      qrCid
                    )}"
                    width="260"
                    height="260"
                    alt="Código QR de retiro"
                    style="display:block;width:260px;height:260px;max-width:100%;margin:0 auto;border:1px solid #eeeeee;border-radius:16px;"
                  />

                  <p style="margin:14px auto 0 auto;max-width:420px;font-size:12px;line-height:1.6;color:#777777;">
                    Presenta este QR al momento de retirar tu compra. Es personal y de un solo uso.
                  </p>
                </div>

                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 8px auto;">
                  <tr>
                    <td bgcolor="#111111" style="border-radius:999px;">
                      <a
                        href="${escapeHtml(
                          documentUrl
                        )}"
                        target="_blank"
                        rel="noopener noreferrer"
                        style="display:inline-block;padding:14px 24px;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;"
                      >
                        VER ${documentType ===
                        "FACTURA"
                          ? "FACTURA"
                          : "BOLETA"}
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="border-top:1px solid #eeeeee;padding:22px 38px 28px 38px;font-size:11px;line-height:1.6;color:#999999;">
                Correo transaccional asociado al pedido ${escapeHtml(
                  orderNumber
                )}. No compartas el QR ni el enlace del documento.
              </td>
            </tr>
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

      messageId:
        buildMessageId(
          row.id
        ),

      attachments: [
        {
          filename:
            `qr-retiro-${orderNumber}.png`,

          content:
            qrPng,

          contentType:
            "image/png",

          cid:
            qrCid,

          contentDisposition:
            "inline",
        },
      ],
    };
  };

let smtpAccepted =
  false;

let claimed =
  false;

try {
  console.log(
    "Verificando SMTP Zoho..."
  );

  await verifyEmailTransport();

  console.log(
    "SMTP Zoho OK"
  );

  const claimResult =
    await pool.query(
      `
        UPDATE email_outbox

        SET
          status =
            'PROCESSING',

          attempts =
            attempts + 1,

          processing_at =
            NOW(),

          last_error =
            NULL,

          updated_at =
            NOW()

        WHERE id = $1

          AND event_type =
            'ORDER_READY_FOR_PICKUP'

          AND status IN (
            'PENDING',
            'FAILED'
          )

          AND scheduled_at <=
            NOW()

          AND attempts <
            max_attempts

        RETURNING
          id,
          status,
          attempts,
          max_attempts
      `,
      [
        OUTBOX_ID,
      ]
    );

  if (
    claimResult.rowCount !==
    1
  ) {
    const current =
      await pool.query(
        `
          SELECT
            id,
            event_type,
            status,
            attempts,
            max_attempts,
            sent_at

          FROM email_outbox

          WHERE id = $1

          LIMIT 1
        `,
        [
          OUTBOX_ID,
        ]
      );

    console.error(
      "El evento no pudo ser tomado para envío."
    );

    console.error(
      current.rows[0] || {
        id:
          OUTBOX_ID,

        found:
          false,
      }
    );

    process.exitCode =
      2;
  } else {
    claimed =
      true;

    const {
      row,
      documentCredential,
      pickupCredential,
    } =
      await loadAndValidateEvent(
        OUTBOX_ID
      );

    const testMode =
      isTrue(
        process.env
          .EMAIL_OUTBOX_TEST_MODE
      );

    const testTo =
      cleanText(
        process.env
          .EMAIL_OUTBOX_TEST_TO
      ).toLowerCase();

    const destination =
      testMode
        ? testTo
        : cleanText(
            row.recipient_email
          ).toLowerCase();

    if (
      testMode &&
      !testTo
    ) {
      throw new Error(
        "EMAIL_OUTBOX_TEST_MODE=true requiere EMAIL_OUTBOX_TEST_TO"
      );
    }

    console.log(
      "Evento Email 2 validado:",
      {
        outbox_id:
          row.id,

        event_type:
          row.event_type,

        order_number:
          row.order_number,

        pickup_id:
          row.pickup_id,

        document_type:
          row.document_type,

        folio:
          row.folio,

        original_recipient:
          row.recipient_email,

        destination,

        test_mode:
          testMode,
      }
    );

    const email =
      await buildEmail({
        row,
        documentCredential,
        pickupCredential,
        to:
          destination,
      });

    const info =
      await sendTransactionalEmail(
        email
      );

    const accepted =
      info.accepted.map(
        (value) =>
          String(
            value
          ).toLowerCase()
      );

    if (
      accepted.length ===
      0
    ) {
      throw new Error(
        "Zoho no confirmó ningún destinatario aceptado"
      );
    }

    smtpAccepted =
      true;

    const sentResult =
      await pool.query(
        `
          UPDATE email_outbox

          SET
            status =
              'SENT',

            sent_at =
              NOW(),

            processing_at =
              NULL,

            provider_message_id =
              $2,

            last_error =
              NULL,

            updated_at =
              NOW()

          WHERE id = $1
            AND status =
              'PROCESSING'

          RETURNING
            id,
            event_type,
            recipient_email,
            status,
            attempts,
            sent_at,
            provider_message_id
        `,
        [
          OUTBOX_ID,
          info.message_id,
        ]
      );

    if (
      sentResult.rowCount !==
      1
    ) {
      throw new Error(
        "Zoho aceptó Email 2, pero no fue posible confirmar SENT en email_outbox. NO REINTENTAR AUTOMÁTICAMENTE."
      );
    }

    console.log(
      "Email 2 enviado y confirmado:"
    );

    console.log(
      sentResult.rows[0]
    );
  }
} catch (error) {
  console.error(
    "Error procesando Email 2:",
    {
      message:
        error?.message ||
        "Error desconocido",

      code:
        error?.code ||
        null,

      responseCode:
        error?.responseCode ||
        null,
    }
  );

  if (claimed) {
    const safeError =
      String(
        error?.message ||
          "Error desconocido"
      ).slice(
        0,
        2000
      );

    if (
      smtpAccepted
    ) {
      await pool.query(
        `
          UPDATE email_outbox

          SET
            last_error =
              $2,

            updated_at =
              NOW()

          WHERE id = $1
            AND status =
              'PROCESSING'
        `,
        [
          OUTBOX_ID,

          `SMTP_ACCEPTED_DB_CONFIRMATION_FAILED: ${safeError}`,
        ]
      );
    } else {
      await pool.query(
        `
          UPDATE email_outbox

          SET
            status =
              'FAILED',

            processing_at =
              NULL,

            last_error =
              $2,

            updated_at =
              NOW()

          WHERE id = $1
            AND status =
              'PROCESSING'
        `,
        [
          OUTBOX_ID,

          `SMTP_SEND_FAILED: ${safeError}`,
        ]
      );
    }
  }

  process.exitCode =
    1;
} finally {
  await pool
    .end()
    .catch(
      () => {}
    );
}
