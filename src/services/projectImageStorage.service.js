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
   VARIANTES DE IMAGEN PARA PROYECTOS
========================================= */

const PROJECT_IMAGE_VARIANTS = {
  thumbnail: {
    width: 640,
    quality: 82,
  },

  card: {
    width: 1200,
    quality: 85,
  },

  detail: {
    width: 2000,
    quality: 88,
  },
};

const DEFAULT_SIGNED_URL_EXPIRES =
  Number.parseInt(
    process.env.PROJECT_IMAGE_SIGNED_URL_EXPIRES,
    10
  ) ||
  Number.parseInt(
    process.env.PRODUCT_IMAGE_SIGNED_URL_EXPIRES,
    10
  ) ||
  86400;

const sanitizeSegment = (
  value
) => {
  return String(
    value || ""
  )
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .replace(
      /[^a-z0-9-_]+/g,
      "-"
    )
    .replace(
      /-+/g,
      "-"
    )
    .replace(
      /^-|-$/g,
      ""
    );
};

const buildObjectKey = ({
  projectSlug,
  imageId,
  variant,
}) => {
  const safeSlug =
    sanitizeSegment(
      projectSlug
    );

  const safeImageId =
    sanitizeSegment(
      imageId
    );

  if (!safeSlug) {
    throw new Error(
      "Slug de proyecto no válido para almacenamiento"
    );
  }

  if (!safeImageId) {
    throw new Error(
      "ID de imagen no válido"
    );
  }

  return [
    "projects",
    safeSlug,
    safeImageId,
    `${variant}.webp`,
  ].join("/");
};

const validateImageBuffer = async (
  buffer
) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(
      "La imagen debe recibirse como Buffer"
    );
  }

  if (
    buffer.length === 0
  ) {
    throw new Error(
      "La imagen se encuentra vacía"
    );
  }

  const metadata =
    await sharp(
      buffer
    ).metadata();

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
  } = await sharp(
    buffer
  )
    .rotate()
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

export const deleteProjectImageVariants =
  async (
    keys = []
  ) => {
    const validKeys =
      [...new Set(
        keys.filter(
          Boolean
        )
      )];

    if (
      validKeys.length ===
      0
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
              (
                key
              ) => ({
                Key: key,
              })
            ),

          Quiet: true,
        },
      })
    );
  };

export const uploadProjectImage =
  async ({
    buffer,
    projectSlug,
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
          PROJECT_IMAGE_VARIANTS
        )
      ) {
        const processed =
          await processVariant(
            buffer,
            config
          );

        const key =
          buildObjectKey({
            projectSlug,
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
    } catch (
      error
    ) {
      if (
        uploadedKeys.length >
        0
      ) {
        try {
          await deleteProjectImageVariants(
            uploadedKeys
          );
        } catch (
          cleanupError
        ) {
          console.error(
            "Error limpiando imágenes parciales de proyecto:",
            cleanupError
          );
        }
      }

      throw error;
    }
  };

export const getProjectImageSignedUrl =
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

export {
  PROJECT_IMAGE_VARIANTS,
};
