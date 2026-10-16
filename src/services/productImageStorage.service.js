import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import {
  getSignedUrl,
} from "@aws-sdk/s3-request-presigner";

import sharp from "sharp";

import {
  storageClient,
  STORAGE_BUCKET,
} from "../config/storage.js";

/* =========================================
   CONFIGURACIÓN
========================================= */

const IMAGE_VARIANTS = {
  thumbnail: {
    width: 480,
    quality: 82,
  },

  card: {
    width: 900,
    quality: 84,
  },

  detail: {
    width: 1600,
    quality: 86,
  },
};

const DEFAULT_SIGNED_URL_EXPIRES =
  Number.parseInt(
    process.env.PRODUCT_IMAGE_SIGNED_URL_EXPIRES,
    10
  ) || 86400;

/* =========================================
   NORMALIZAR SEGMENTOS
========================================= */

const sanitizeSegment = (value) => {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
};

/* =========================================
   CREAR OBJECT KEY

   Ejemplo:

   products/
   └── 1678m/
       └── sample/
           └── UUID-IMAGEN/
               ├── thumbnail.webp
               ├── card.webp
               └── detail.webp
========================================= */

const buildObjectKey = ({
  sku,
  imageType,
  imageId,
  variant,
}) => {
  const safeSku =
    sanitizeSegment(sku);

  const safeImageType =
    sanitizeSegment(imageType);

  const safeImageId =
    sanitizeSegment(imageId);

  if (!safeSku) {
    throw new Error(
      "SKU no válido para almacenamiento de imagen"
    );
  }

  if (!safeImageType) {
    throw new Error(
      "Tipo de imagen no válido"
    );
  }

  if (!safeImageId) {
    throw new Error(
      "ID de imagen no válido"
    );
  }

  return [
    "products",
    safeSku,
    safeImageType,
    safeImageId,
    `${variant}.webp`,
  ].join("/");
};

/* =========================================
   VALIDAR BUFFER
========================================= */

const validateImageBuffer = async (
  buffer
) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(
      "La imagen debe recibirse como Buffer"
    );
  }

  if (buffer.length === 0) {
    throw new Error(
      "La imagen se encuentra vacía"
    );
  }

  const metadata =
    await sharp(buffer).metadata();

  const allowedFormats =
    new Set([
      "jpeg",
      "png",
      "webp",
      "avif",
      "tiff",
    ]);

  if (
    !metadata.format ||
    !allowedFormats.has(
      metadata.format
    )
  ) {
    throw new Error(
      `Formato de imagen no permitido: ${
        metadata.format ||
        "desconocido"
      }`
    );
  }

  return metadata;
};

/* =========================================
   PROCESAR VARIANTE
========================================= */

const processVariant = async (
  buffer,
  {
    width,
    quality,
  }
) => {
  const {
    data,
    info,
  } = await sharp(buffer)
    /*
      Corrige orientación EXIF.
    */
    .rotate()

    /*
      Conserva proporción.

      withoutEnlargement evita ampliar
      artificialmente imágenes pequeñas.
    */
    .resize({
      width,
      fit: "inside",
      withoutEnlargement: true,
    })

    .webp({
      quality,
      effort: 4,
      smartSubsample: true,
    })

    .toBuffer({
      resolveWithObject: true,
    });

  return {
    buffer: data,
    width: info.width,
    height: info.height,
    bytes: data.length,
  };
};

/* =========================================
   SUBIR OBJECT
========================================= */

const uploadObject = async ({
  key,
  buffer,
}) => {
  await storageClient.send(
    new PutObjectCommand({
      Bucket:
        STORAGE_BUCKET,

      Key:
        key,

      Body:
        buffer,

      ContentType:
        "image/webp",

      CacheControl:
        "public, max-age=31536000, immutable",
    })
  );
};

/* =========================================
   ELIMINAR VARIANTES
========================================= */

export const deleteProductImageVariants =
  async (keys = []) => {
    const validKeys =
      [...new Set(
        keys.filter(Boolean)
      )];

    if (
      validKeys.length === 0
    ) {
      return;
    }

    await storageClient.send(
      new DeleteObjectsCommand({
        Bucket:
          STORAGE_BUCKET,

        Delete: {
          Objects:
            validKeys.map(
              (key) => ({
                Key: key,
              })
            ),

          Quiet: true,
        },
      })
    );
  };

/* =========================================
   SUBIR IMAGEN DE PRODUCTO
========================================= */

export const uploadProductImage =
  async ({
    buffer,
    sku,
    imageType,
    imageId,
  }) => {
    const metadata =
      await validateImageBuffer(
        buffer
      );

    const uploadedVariants = {};
    const uploadedKeys = [];

    try {
      for (
        const [
          variant,
          config,
        ] of Object.entries(
          IMAGE_VARIANTS
        )
      ) {
        const processed =
          await processVariant(
            buffer,
            config
          );

        const key =
          buildObjectKey({
            sku,
            imageType,
            imageId,
            variant,
          });

        await uploadObject({
          key,
          buffer:
            processed.buffer,
        });

        uploadedKeys.push(
          key
        );

        uploadedVariants[
          variant
        ] = {
          key,

          width:
            processed.width,

          height:
            processed.height,

          bytes:
            processed.bytes,

          content_type:
            "image/webp",
        };
      }

      return {
        source: {
          format:
            metadata.format,

          width:
            metadata.width ||
            null,

          height:
            metadata.height ||
            null,

          bytes:
            buffer.length,
        },

        variants:
          uploadedVariants,
      };
    } catch (error) {
      /*
        Si falla una variante después
        de haber subido otras, limpiamos
        automáticamente los objetos
        parciales.
      */

      if (
        uploadedKeys.length >
        0
      ) {
        try {
          await deleteProductImageVariants(
            uploadedKeys
          );
        } catch (
          cleanupError
        ) {
          console.error(
            "Error limpiando imágenes parciales de Railway:",
            cleanupError
          );
        }
      }

      throw error;
    }
  };

/* =========================================
   GENERAR URL FIRMADA
========================================= */

export const getProductImageSignedUrl =
  async (
    key,
    {
      expiresIn =
        DEFAULT_SIGNED_URL_EXPIRES,
    } = {}
  ) => {
    if (!key) {
      return null;
    }

    const command =
      new GetObjectCommand({
        Bucket:
          STORAGE_BUCKET,

        Key:
          key,
      });

    return getSignedUrl(
      storageClient,
      command,
      {
        expiresIn,
      }
    );
  };

/* =========================================
   CONFIGURACIÓN EXPORTADA
========================================= */

export {
  IMAGE_VARIANTS,
};