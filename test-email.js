import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const requiredVariables = [
  "EMAIL_HOST",
  "EMAIL_PORT",
  "EMAIL_USER",
  "EMAIL_PASSWORD",
  "EMAIL_FROM_ADDRESS",
  "TEST_EMAIL_TO",
];

const missingVariables =
  requiredVariables.filter(
    (key) =>
      !String(
        process.env[key] || ""
      ).trim()
  );

if (missingVariables.length > 0) {
  console.error(
    "Faltan variables de entorno:",
    missingVariables.join(", ")
  );

  process.exit(1);
}

const transporter =
  nodemailer.createTransport({
    host:
      process.env.EMAIL_HOST,

    port:
      Number(
        process.env.EMAIL_PORT
      ),

    secure:
      String(
        process.env.EMAIL_SECURE
      )
        .trim()
        .toLowerCase() ===
      "true",

    auth: {
      user:
        process.env.EMAIL_USER,

      pass:
        process.env.EMAIL_PASSWORD,
    },
  });

try {
  console.log(
    "Verificando conexión SMTP..."
  );

  await transporter.verify();

  console.log(
    "SMTP autenticado correctamente"
  );

  const fromName =
    String(
      process.env.EMAIL_FROM_NAME ||
        "Laminati"
    ).trim();

  const info =
    await transporter.sendMail({
      from:
        `"${fromName}" <${process.env.EMAIL_FROM_ADDRESS}>`,

      to:
        process.env.TEST_EMAIL_TO,

      replyTo:
        process.env.EMAIL_REPLY_TO ||
        process.env.EMAIL_FROM_ADDRESS,

      subject:
        "Prueba de correo - LaminatiWord",

      text:
        "Esta es una prueba de configuración de correo desde LaminatiWord.",

      html: `
        <!doctype html>
        <html>
          <body
            style="
              margin:0;
              padding:40px;
              font-family:Arial,sans-serif;
              background:#f5f5f5;
            "
          >
            <div
              style="
                max-width:600px;
                margin:auto;
                background:#ffffff;
                padding:32px;
                border-radius:12px;
              "
            >
              <h2 style="margin-top:0;">
                LaminatiWord
              </h2>

              <p>
                La configuración de correo
                transaccional está funcionando
                correctamente.
              </p>

              <p>
                Esta es solamente una prueba SMTP.
              </p>

              <hr
                style="
                  border:none;
                  border-top:1px solid #dddddd;
                  margin:30px 0;
                "
              />

              <small>
                No se ha procesado ningún pedido,
                pago ni documento tributario.
              </small>
            </div>
          </body>
        </html>
      `,
    });

  console.log(
    "Correo enviado correctamente"
  );

  console.log({
    messageId:
      info.messageId,
    accepted:
      info.accepted,
    rejected:
      info.rejected,
  });

  process.exit(0);
} catch (error) {
  console.error(
    "Error enviando correo:"
  );

  console.error({
    name:
      error.name,
    code:
      error.code || null,
    responseCode:
      error.responseCode || null,
    command:
      error.command || null,
    message:
      error.message,
  });

  process.exit(1);
}