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

const normalizeEmail = (value) => cleanText(value).toLowerCase();

const senderEnvKey = (email) => {
  const localPart = normalizeEmail(email).split("@")[0] || "";
  return localPart
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
};

const transporterCache = new Map();

const getCommonTransportConfig = () => {
  const host = requireEnv("EMAIL_HOST");
  const port = Number(requireEnv("EMAIL_PORT"));

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    const error = new Error("EMAIL_PORT no es válido");
    error.code = "EMAIL_PORT_INVALID";
    throw error;
  }

  return {
    host,
    port,
    secure: isTrue(process.env.EMAIL_SECURE),
  };
};

const resolveDefaultAccount = () => {
  const user = requireEnv("EMAIL_USER");
  const pass = requireEnv("EMAIL_PASSWORD");
  const fromAddress = cleanText(process.env.EMAIL_FROM_ADDRESS || user).toLowerCase();
  const fromName = cleanText(process.env.EMAIL_FROM_NAME || "Laminati");
  const replyTo = cleanText(process.env.EMAIL_REPLY_TO || fromAddress).toLowerCase();

  return {
    cacheKey: `default:${user.toLowerCase()}`,
    authUser: user,
    authPass: pass,
    fromAddress,
    fromName,
    replyTo,
  };
};

const resolveSenderAccount = (sender = null) => {
  const senderEmail = normalizeEmail(sender?.email);
  const senderName = cleanText(sender?.name);

  // Correos transaccionales generales mantienen la cuenta global actual.
  if (!senderEmail) {
    return resolveDefaultAccount();
  }

  const defaultAccount = resolveDefaultAccount();

  // Compatibilidad: si el usuario autenticado ya es la cuenta SMTP global,
  // reutilizamos EMAIL_USER / EMAIL_PASSWORD sin pedir variables duplicadas.
  if (
    senderEmail === normalizeEmail(defaultAccount.authUser) ||
    senderEmail === normalizeEmail(defaultAccount.fromAddress)
  ) {
    return {
      ...defaultAccount,
      cacheKey: `sender:${senderEmail}`,
      fromAddress: senderEmail,
      fromName: senderName || defaultAccount.fromName,
      replyTo: senderEmail,
    };
  }

  const key = senderEnvKey(senderEmail);
  if (!key) {
    const error = new Error("No fue posible determinar la cuenta SMTP del usuario");
    error.code = "EMAIL_SENDER_ACCOUNT_INVALID";
    throw error;
  }

  const configuredUser = cleanText(process.env[`EMAIL_${key}_USER`]);
  const configuredPassword = cleanText(process.env[`EMAIL_${key}_PASSWORD`]);

  if (!configuredPassword) {
    const error = new Error(
      `La cuenta ${senderEmail} no posee credenciales SMTP configuradas. ` +
      `Configura EMAIL_${key}_PASSWORD en Railway.`
    );
    error.code = "EMAIL_SENDER_CREDENTIALS_MISSING";
    error.sender_email = senderEmail;
    throw error;
  }

  const authUser = configuredUser || senderEmail;

  // Evita autenticar una cuenta y falsificar otra dirección From accidentalmente.
  if (normalizeEmail(authUser) !== senderEmail) {
    const error = new Error(
      `EMAIL_${key}_USER debe coincidir con ${senderEmail} para enviar desde esa cuenta`
    );
    error.code = "EMAIL_SENDER_AUTH_MISMATCH";
    throw error;
  }

  return {
    cacheKey: `sender:${senderEmail}`,
    authUser,
    authPass: configuredPassword,
    fromAddress: senderEmail,
    fromName: senderName || "Laminati",
    replyTo: senderEmail,
  };
};

const getTransporterForAccount = (account) => {
  const cached = transporterCache.get(account.cacheKey);
  if (cached) return cached;

  const common = getCommonTransportConfig();
  const transporter = nodemailer.createTransport({
    ...common,
    auth: {
      user: account.authUser,
      pass: account.authPass,
    },
  });

  transporterCache.set(account.cacheKey, transporter);
  return transporter;
};

export const verifyEmailTransport = async () => {
  const account = resolveDefaultAccount();
  await getTransporterForAccount(account).verify();
  return true;
};

export const verifyEmailSenderTransport = async ({ email, name = null }) => {
  const account = resolveSenderAccount({ email, name });
  await getTransporterForAccount(account).verify();
  return true;
};

export const sendTransactionalEmail = async ({
  to,
  subject,
  html,
  text,
  messageId = null,
  attachments = [],
  sender = null,
}) => {
  const recipient = normalizeEmail(to);
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

  const account = resolveSenderAccount(sender);
  const transporter = getTransporterForAccount(account);

  const info = await transporter.sendMail({
    from: {
      name: account.fromName,
      address: account.fromAddress,
    },
    to: recipient,
    replyTo: account.replyTo,
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
    sender_email: account.fromAddress,
    sender_name: account.fromName,
  };
};
