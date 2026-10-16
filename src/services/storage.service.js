import crypto from "crypto";

import {
  promises as fs,
} from "fs";

import path from "path";


/* =========================================
   STORAGE LOCAL - COMPROBANTES

   PASO 85.4.1

   En producción este servicio podrá cambiar
   internamente a Supabase Storage sin tocar
   payment.service.js.
========================================= */
const STORAGE_DRIVER =
  "local";

const STORAGE_ROOT =
  path.resolve(
    process.cwd(),
    "uploads"
  );

const PROOF_ROOT =
  path.join(
    STORAGE_ROOT,
    "bank-transfer-proofs"
  );

const MAX_PROOF_FILE_SIZE =
  10 * 1024 * 1024;

const MIME_TO_EXTENSION = {
  "application/pdf":
    ".pdf",

  "image/jpeg":
    ".jpg",

  "image/png":
    ".png",
};


/* =========================================
   ERROR CONTROLADO
========================================= */
const createStorageError = (
  message,
  status = 400,
  code = null
) => {
  const error =
    new Error(message);

  error.status = status;
  error.code = code;

  return error;
};


/* =========================================
   NOMBRE ORIGINAL SEGURO
========================================= */
const sanitizeOriginalFilename = (
  value
) => {
  const baseName =
    path.basename(
      String(value || "")
    );

  const cleaned =
    baseName
      .replace(
        /[\u0000-\u001F\u007F]/g,
        ""
      )
      .trim();

  return (
    cleaned ||
    "comprobante"
  ).slice(
    0,
    255
  );
};


/* =========================================
   FIRMA REAL DEL ARCHIVO

   No confiamos sólo en mimetype/extensión.
========================================= */
const matchesFileSignature = (
  buffer,
  mimeType
) => {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 4
  ) {
    return false;
  }

  if (
    mimeType ===
    "application/pdf"
  ) {
    return (
      buffer
        .subarray(0, 5)
        .toString("ascii") ===
      "%PDF-"
    );
  }

  if (
    mimeType ===
    "image/jpeg"
  ) {
    return (
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

  if (
    mimeType ===
    "image/png"
  ) {
    const pngSignature =
      Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]);

    return (
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(
          pngSignature
        )
    );
  }

  return false;
};


/* =========================================
   VALIDAR ARCHIVO
========================================= */
const validateProofFile = (
  file
) => {
  if (
    !file ||
    !Buffer.isBuffer(
      file.buffer
    )
  ) {
    throw createStorageError(
      "No se recibió un archivo de comprobante válido",
      400,
      "BANK_TRANSFER_PROOF_FILE_REQUIRED"
    );
  }

  if (
    !file.size ||
    file.size <= 0
  ) {
    throw createStorageError(
      "El comprobante está vacío",
      400,
      "BANK_TRANSFER_PROOF_FILE_EMPTY"
    );
  }

  if (
    file.size >
    MAX_PROOF_FILE_SIZE
  ) {
    throw createStorageError(
      "El comprobante supera el máximo permitido de 10 MB",
      413,
      "BANK_TRANSFER_PROOF_FILE_TOO_LARGE"
    );
  }

  const extension =
    MIME_TO_EXTENSION[
      file.mimetype
    ];

  if (!extension) {
    throw createStorageError(
      "El comprobante debe ser PDF, JPG, JPEG o PNG",
      400,
      "BANK_TRANSFER_PROOF_FILE_TYPE_INVALID"
    );
  }

  if (
    !matchesFileSignature(
      file.buffer,
      file.mimetype
    )
  ) {
    throw createStorageError(
      "El contenido del comprobante no coincide con el tipo de archivo informado",
      400,
      "BANK_TRANSFER_PROOF_FILE_SIGNATURE_INVALID"
    );
  }

  return {
    extension,
  };
};


/* =========================================
   CONSTRUIR ARCHIVO DESDE JSON BASE64

   Permite reutilizar exactamente la misma
   validación/almacenamiento que el upload
   multipart, sin confiar en nombre, MIME ni
   contenido informado por el cliente.
========================================= */
export const buildBankTransferProofFileFromBase64 = (
  proofFile
) => {
  if (
    !proofFile ||
    typeof proofFile !== "object" ||
    Array.isArray(proofFile)
  ) {
    throw createStorageError(
      "proof_file es obligatorio",
      400,
      "BANK_TRANSFER_PROOF_FILE_REQUIRED"
    );
  }

  const originalname =
    sanitizeOriginalFilename(
      proofFile.filename
    );

  const mimetype =
    String(
      proofFile.mime_type ||
      ""
    )
      .trim()
      .toLowerCase();

  let base64 =
    String(
      proofFile.base64 ||
      ""
    ).trim();

  if (!proofFile.filename) {
    throw createStorageError(
      "proof_file.filename es obligatorio",
      400,
      "BANK_TRANSFER_PROOF_FILENAME_REQUIRED"
    );
  }

  if (!mimetype) {
    throw createStorageError(
      "proof_file.mime_type es obligatorio",
      400,
      "BANK_TRANSFER_PROOF_MIME_TYPE_REQUIRED"
    );
  }

  const expectedExtension =
    MIME_TO_EXTENSION[
      mimetype
    ];

  if (!expectedExtension) {
    throw createStorageError(
      "El comprobante debe ser PDF, JPG, JPEG o PNG",
      400,
      "BANK_TRANSFER_PROOF_FILE_TYPE_INVALID"
    );
  }

  const originalExtension =
    path
      .extname(
        originalname
      )
      .toLowerCase();

  const extensionMatches =
    mimetype === "image/jpeg"
      ? [
          ".jpg",
          ".jpeg",
        ].includes(
          originalExtension
        )
      : originalExtension ===
        expectedExtension;

  if (!extensionMatches) {
    throw createStorageError(
      "La extensión del comprobante no coincide con mime_type",
      400,
      "BANK_TRANSFER_PROOF_FILE_EXTENSION_MISMATCH"
    );
  }

  if (!base64) {
    throw createStorageError(
      "proof_file.base64 es obligatorio",
      400,
      "BANK_TRANSFER_PROOF_BASE64_REQUIRED"
    );
  }

  /*
   * También aceptamos un Data URL válido:
   * data:application/pdf;base64,JVBERi0...
   *
   * Si se usa, el MIME declarado en el Data URL
   * debe coincidir con proof_file.mime_type.
   */
  if (
    base64
      .toLowerCase()
      .startsWith("data:")
  ) {
    const separatorIndex =
      base64.indexOf(",");

    if (separatorIndex <= 5) {
      throw createStorageError(
        "proof_file.base64 posee un Data URL inválido",
        400,
        "BANK_TRANSFER_PROOF_BASE64_INVALID"
      );
    }

    const metadata =
      base64
        .slice(
          5,
          separatorIndex
        );

    const parts =
      metadata
        .split(";")
        .map((value) =>
          value.trim()
        )
        .filter(Boolean);

    const dataUrlMime =
      String(
        parts[0] ||
        ""
      )
        .trim()
        .toLowerCase();

    const hasBase64Flag =
      parts
        .slice(1)
        .some(
          (value) =>
            value.toLowerCase() ===
            "base64"
        );

    if (
      !hasBase64Flag ||
      dataUrlMime !==
        mimetype
    ) {
      throw createStorageError(
        "El Data URL del comprobante no coincide con mime_type",
        400,
        "BANK_TRANSFER_PROOF_BASE64_MIME_MISMATCH"
      );
    }

    base64 =
      base64
        .slice(
          separatorIndex + 1
        )
        .trim();
  }

  const normalizedBase64 =
    base64.replace(
      /\s+/g,
      ""
    );

  if (
    !normalizedBase64 ||
    normalizedBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      normalizedBase64
    )
  ) {
    throw createStorageError(
      "proof_file.base64 no posee Base64 válido",
      400,
      "BANK_TRANSFER_PROOF_BASE64_INVALID"
    );
  }

  const buffer =
    Buffer.from(
      normalizedBase64,
      "base64"
    );

  if (
    buffer.length === 0
  ) {
    throw createStorageError(
      "El comprobante está vacío",
      400,
      "BANK_TRANSFER_PROOF_FILE_EMPTY"
    );
  }

  if (
    buffer.length >
    MAX_PROOF_FILE_SIZE
  ) {
    throw createStorageError(
      "El comprobante supera el máximo permitido de 10 MB",
      413,
      "BANK_TRANSFER_PROOF_FILE_TOO_LARGE"
    );
  }

  return {
    buffer,
    size:
      buffer.length,
    mimetype,
    originalname,
  };
};


/* =========================================
   GUARDAR COMPROBANTE
========================================= */
export const saveBankTransferProofFile =
  async (file) => {
    const {
      extension,
    } = validateProofFile(
      file
    );

    const now =
      new Date();

    const year =
      String(
        now.getUTCFullYear()
      );

    const month =
      String(
        now.getUTCMonth() + 1
      ).padStart(
        2,
        "0"
      );

    const directory =
      path.join(
        PROOF_ROOT,
        year,
        month
      );

    await fs.mkdir(
      directory,
      {
        recursive: true,
      }
    );

    const generatedFilename =
      `${crypto.randomUUID()}${extension}`;

    const absolutePath =
      path.join(
        directory,
        generatedFilename
      );

    await fs.writeFile(
      absolutePath,
      file.buffer,
      {
        flag: "wx",
        mode: 0o600,
      }
    );

    const storageKey =
      path
        .posix
        .join(
          "bank-transfer-proofs",
          year,
          month,
          generatedFilename
        );

    return {
      storageDriver:
        STORAGE_DRIVER,

      storageKey,

      fileUrl:
        `local://${storageKey}`,

      originalFilename:
        sanitizeOriginalFilename(
          file.originalname
        ),

      mimeType:
        file.mimetype,

      fileSizeBytes:
        file.size,
    };
  };


/* =========================================
   ELIMINAR ARCHIVO LOCAL

   Se usa para rollback/cleanup si la parte
   de negocio o DB falla después del upload.
========================================= */
export const deleteStoredFile =
  async (storageKey) => {
    const normalizedKey =
      String(
        storageKey ||
        ""
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
      !normalizedKey.startsWith(
        "bank-transfer-proofs/"
      )
    ) {
      throw createStorageError(
        "storageKey de comprobante inválido",
        400,
        "BANK_TRANSFER_PROOF_STORAGE_KEY_INVALID"
      );
    }

    const absolutePath =
      path.resolve(
        STORAGE_ROOT,
        ...normalizedKey.split("/")
      );

    const relative =
      path.relative(
        PROOF_ROOT,
        absolutePath
      );

    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw createStorageError(
        "Ruta de comprobante inválida",
        400,
        "BANK_TRANSFER_PROOF_STORAGE_PATH_INVALID"
      );
    }

    try {
      await fs.unlink(
        absolutePath
      );
    } catch (error) {
      if (
        error.code !==
        "ENOENT"
      ) {
        throw error;
      }
    }
  };

/* =========================================
   RESOLVER COMPROBANTE LOCAL PARA LECTURA

   Sólo acepta URLs generadas por este mismo
   storage driver: local://bank-transfer-proofs/...
========================================= */
export const resolveStoredProofFile =
  async (fileUrl) => {
    const raw = String(fileUrl || "").trim();

    if (!raw.startsWith("local://")) {
      throw createStorageError(
        "El comprobante no utiliza el storage local",
        409,
        "BANK_TRANSFER_PROOF_STORAGE_DRIVER_UNSUPPORTED"
      );
    }

    const storageKey = raw
      .slice("local://".length)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");

    if (
      !storageKey.startsWith(
        "bank-transfer-proofs/"
      )
    ) {
      throw createStorageError(
        "Ruta de comprobante inválida",
        400,
        "BANK_TRANSFER_PROOF_STORAGE_KEY_INVALID"
      );
    }

    const absolutePath = path.resolve(
      STORAGE_ROOT,
      ...storageKey.split("/")
    );

    const relative = path.relative(
      PROOF_ROOT,
      absolutePath
    );

    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw createStorageError(
        "Ruta de comprobante inválida",
        400,
        "BANK_TRANSFER_PROOF_STORAGE_PATH_INVALID"
      );
    }

    try {
      const stats = await fs.stat(absolutePath);

      if (!stats.isFile()) {
        throw createStorageError(
          "El comprobante almacenado no es un archivo válido",
          404,
          "BANK_TRANSFER_PROOF_FILE_NOT_FOUND"
        );
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw createStorageError(
          "El archivo del comprobante no se encuentra disponible",
          404,
          "BANK_TRANSFER_PROOF_FILE_NOT_FOUND"
        );
      }

      throw error;
    }

    return {
      storageDriver: STORAGE_DRIVER,
      storageKey,
      absolutePath,
    };
  };
