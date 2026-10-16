import { S3Client } from "@aws-sdk/client-s3";

/* =========================================
   VARIABLES STORAGE
========================================= */

const endpoint =
  process.env.RAILWAY_STORAGE_ENDPOINT;

const region =
  process.env.RAILWAY_STORAGE_REGION || "auto";

const accessKeyId =
  process.env.RAILWAY_STORAGE_ACCESS_KEY_ID;

const secretAccessKey =
  process.env.RAILWAY_STORAGE_SECRET_ACCESS_KEY;

const bucket =
  process.env.RAILWAY_STORAGE_BUCKET;

const urlStyle =
  process.env.RAILWAY_STORAGE_URL_STYLE ||
  "virtual-host";

/* =========================================
   VALIDACIONES
========================================= */

if (!endpoint) {
  throw new Error(
    "RAILWAY_STORAGE_ENDPOINT no se encuentra configurado"
  );
}

if (!accessKeyId) {
  throw new Error(
    "RAILWAY_STORAGE_ACCESS_KEY_ID no se encuentra configurado"
  );
}

if (!secretAccessKey) {
  throw new Error(
    "RAILWAY_STORAGE_SECRET_ACCESS_KEY no se encuentra configurado"
  );
}

if (!bucket) {
  throw new Error(
    "RAILWAY_STORAGE_BUCKET no se encuentra configurado"
  );
}

/* =========================================
   CLIENTE S3
========================================= */

export const storageClient =
  new S3Client({
    endpoint,
    region,

    credentials: {
      accessKeyId,
      secretAccessKey,
    },

    /*
      Railway indicó:
      AWS_S3_URL_STYLE=virtual-host

      Por lo tanto NO usamos:
      forcePathStyle: true
    */
  });

/* =========================================
   CONFIGURACIÓN EXPORTADA
========================================= */

export const STORAGE_BUCKET =
  bucket;

export const STORAGE_URL_STYLE =
  urlStyle;