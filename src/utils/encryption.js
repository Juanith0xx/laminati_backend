import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/* =========================================
   OBTENER CLAVE DE CIFRADO
========================================= */
const getEncryptionKey = () => {
  const value =
    process.env.RELBASE_TOKEN_ENCRYPTION_KEY;

  if (!value) {
    throw new Error(
      "Falta RELBASE_TOKEN_ENCRYPTION_KEY"
    );
  }

  const key = Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error(
      "RELBASE_TOKEN_ENCRYPTION_KEY debe representar exactamente 32 bytes"
    );
  }

  return key;
};

/* =========================================
   CIFRAR TEXTO
========================================= */
export const encryptValue = (value) => {
  if (!value) {
    throw new Error(
      "No se puede cifrar un valor vacío"
    );
  }

  const key = getEncryptionKey();

  const iv = crypto.randomBytes(
    IV_LENGTH
  );

  const cipher = crypto.createCipheriv(
    ALGORITHM,
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(
      String(value),
      "utf8"
    ),
    cipher.final(),
  ]);

  const authTag =
    cipher.getAuthTag();

  return [
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
};

/* =========================================
   DESCIFRAR TEXTO
========================================= */
export const decryptValue = (encryptedValue) => {
  if (!encryptedValue) {
    throw new Error(
      "No se puede descifrar un valor vacío"
    );
  }

  const [
    ivEncoded,
    authTagEncoded,
    encryptedEncoded,
  ] = encryptedValue.split(".");

  if (
    !ivEncoded ||
    !authTagEncoded ||
    !encryptedEncoded
  ) {
    throw new Error(
      "Formato de valor cifrado inválido"
    );
  }

  const key = getEncryptionKey();

  const iv = Buffer.from(
    ivEncoded,
    "base64url"
  );

  const authTag = Buffer.from(
    authTagEncoded,
    "base64url"
  );

  const encrypted = Buffer.from(
    encryptedEncoded,
    "base64url"
  );

  const decipher =
    crypto.createDecipheriv(
      ALGORITHM,
      key,
      iv
    );

  decipher.setAuthTag(
    authTag
  );

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};