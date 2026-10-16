import nodemailer from "nodemailer";

const cleanText = (value) => String(value ?? "").trim();

const isTrue = (value) =>
  ["1", "true", "yes", "on"].includes(cleanText(value).toLowerCase());

const requireEnv = (name) => {
  const value = cleanText(process.env[name]);
  if (!value) {
    const error = new Error(`${name} no se encuentra configurado`);
    error.code = "EMAIL_ENV_MISSING";
    throw error;
  }
  return value;
};

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  const host = requireEnv("EMAIL_HOST");
  const port = Number(requireEnv("EMAIL_PORT"));
  const user = requireEnv("EMAIL_USER");
  const pass = requireEnv("EMAIL_PASSWORD");

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    const error = new Error("EMAIL_PORT no es válido");
    error.code = "EMAIL_PORT_INVALID";
    throw error;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: isTrue(process.env.EMAIL_SECURE),
    auth: {
      user,
      pass,
    },
  });

  return transporter;
};

export const verifyEmailTransport = async () => {
  await getTransporter().verify();
  return true;
};

export const sendTransactionalEmail = async ({
  to,
  subject,
  html,
  text,
  messageId = null,
  attachments = [],
}) => {
  const recipient = cleanText(to).toLowerCase();
  const normalizedSubject = cleanText(subject);

  if (!recipient) {
    const error = new Error("El destinatario del correo es obligatorio");
    error.code = "EMAIL_RECIPIENT_REQUIRED";
    throw error;
  }

  if (!normalizedSubject) {
    const error = new Error("El asunto del correo es obligatorio");
    error.code = "EMAIL_SUBJECT_REQUIRED";
    throw error;
  }

  const fromName = cleanText(process.env.EMAIL_FROM_NAME || "Laminati");
  const fromAddress = requireEnv("EMAIL_FROM_ADDRESS");
  const replyTo = cleanText(process.env.EMAIL_REPLY_TO || fromAddress);

  const info = await getTransporter().sendMail({
    from: {
      name: fromName,
      address: fromAddress,
    },
    to: recipient,
    replyTo,
    subject: normalizedSubject,
    text: String(text ?? ""),
    html: String(html ?? ""),
    ...(messageId ? { messageId } : {}),
    ...(Array.isArray(attachments) && attachments.length > 0
      ? { attachments }
      : {}),
  });

  return {
    message_id: info.messageId || null,
    accepted: Array.isArray(info.accepted) ? info.accepted : [],
    rejected: Array.isArray(info.rejected) ? info.rejected : [],
    response: info.response || null,
  };
};
