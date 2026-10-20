import path from "path";

import multer from "multer";

/* =========================================
   COMPROBANTES TRANSFERENCIA
========================================= */

const MAX_PROOF_FILE_SIZE =
  10 * 1024 * 1024;

const ALLOWED_MIME_TYPES =
  new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
  ]);

const ALLOWED_EXTENSIONS =
  new Set([
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
  ]);

/* =========================================
   MULTER EN MEMORIA
   El archivo no se escribe en disco aquí.
   storage.service.js realiza la validación
   final y el guardado físico.
========================================= */

const upload =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      files: 1,

      fileSize:
        MAX_PROOF_FILE_SIZE,
    },

    fileFilter: (
      req,
      file,
      callback
    ) => {
      const extension =
        path
          .extname(
            file.originalname ||
            ""
          )
          .toLowerCase();

      if (
        !ALLOWED_MIME_TYPES.has(
          file.mimetype
        ) ||
        !ALLOWED_EXTENSIONS.has(
          extension
        )
      ) {
        const error =
          new Error(
            "El comprobante debe ser PDF, JPG, JPEG o PNG"
          );

        error.status = 400;

        error.code =
          "BANK_TRANSFER_PROOF_FILE_TYPE_INVALID";

        return callback(
          error
        );
      }

      return callback(
        null,
        true
      );
    },
  });

/* =========================================
   MIDDLEWARE CONTROLADO
   Campo esperado:
   proof_file
========================================= */

export const bankTransferProofUpload =
  (req, res, next) => {
    upload.single(
      "proof_file"
    )(
      req,
      res,
      (error) => {
        if (!error) {
          return next();
        }

        if (
          error instanceof
            multer.MulterError
        ) {
          if (
            error.code ===
            "LIMIT_FILE_SIZE"
          ) {
            return res
              .status(413)
              .json({
                success: false,

                message:
                  "El comprobante supera el máximo permitido de 10 MB",

                code:
                  "BANK_TRANSFER_PROOF_FILE_TOO_LARGE",
              });
          }

          return res
            .status(400)
            .json({
              success: false,

              message:
                "No fue posible procesar el archivo enviado",

              code:
                error.code ||
                "BANK_TRANSFER_PROOF_UPLOAD_ERROR",
            });
        }

        return res
          .status(
            error.status ||
            400
          )
          .json({
            success: false,

            message:
              error.message ||
              "Archivo de comprobante inválido",

            code:
              error.code ||
              "BANK_TRANSFER_PROOF_UPLOAD_ERROR",
          });
      }
    );
  };

/* =========================================
   IMÁGENES DE PRODUCTOS
========================================= */

const PRODUCT_IMAGE_MAX_SIZE_MB =
  Math.max(
    Number.parseInt(
      process.env.PRODUCT_IMAGE_MAX_SIZE_MB,
      10
    ) || 15,
    1
  );

const PRODUCT_IMAGE_MAX_FILE_SIZE =
  PRODUCT_IMAGE_MAX_SIZE_MB *
  1024 *
  1024;

const PRODUCT_IMAGE_ALLOWED_MIME_TYPES =
  new Set([
    "image/jpeg",
    "image/jpg",
    "image/pjpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "application/octet-stream",
  ]);

const PRODUCT_IMAGE_ALLOWED_EXTENSIONS =
  new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".avif",
  ]);

/* =========================================
   MULTER PRODUCTOS
   - Memoria
   - 1 archivo por solicitud
========================================= */

const productImageUpload =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      files: 1,

      fileSize:
        PRODUCT_IMAGE_MAX_FILE_SIZE,
    },

    fileFilter: (
      req,
      file,
      callback
    ) => {
      const extension =
        path
          .extname(
            file.originalname ||
            ""
          )
          .toLowerCase();

      const mimeType =
        String(
          file.mimetype || ""
        )
          .trim()
          .toLowerCase();

      /* =====================================
         DEBUG TEMPORAL PRODUCT IMAGE
      ===================================== */

      console.log(
        "=== PRODUCT IMAGE DEBUG ==="
      );

      console.log(
        "originalname:",
        file.originalname
      );

      console.log(
        "mimetype:",
        file.mimetype
      );

      console.log(
        "mimeType normalizado:",
        mimeType
      );

      console.log(
        "extension:",
        extension
      );

      console.log(
        "==========================="
      );

      const validMimeType =
        PRODUCT_IMAGE_ALLOWED_MIME_TYPES.has(
          mimeType
        );

      const validExtension =
        PRODUCT_IMAGE_ALLOWED_EXTENSIONS.has(
          extension
        );

      if (
        !validMimeType ||
        !validExtension
      ) {
        const error =
          new Error(
            "La imagen debe ser JPG, JPEG, PNG, WEBP o AVIF"
          );

        error.status = 400;

        error.code =
          "PRODUCT_IMAGE_FILE_TYPE_INVALID";

        return callback(
          error
        );
      }

      return callback(
        null,
        true
      );
    },
  });

/* =========================================
   MIDDLEWARE CONTROLADO PRODUCTOS
   Campo esperado:
   image
========================================= */

export const productImageUploadMiddleware =
  (req, res, next) => {
    productImageUpload.single(
      "image"
    )(
      req,
      res,
      (error) => {
        if (!error) {
          return next();
        }

        /* =====================================
           ERRORES MULTER
        ===================================== */

        if (
          error instanceof
            multer.MulterError
        ) {
          if (
            error.code ===
            "LIMIT_FILE_SIZE"
          ) {
            return res
              .status(413)
              .json({
                success: false,

                message:
                  `La imagen supera el máximo permitido de ${PRODUCT_IMAGE_MAX_SIZE_MB} MB`,

                code:
                  "PRODUCT_IMAGE_FILE_TOO_LARGE",
              });
          }

          if (
            error.code ===
            "LIMIT_FILE_COUNT"
          ) {
            return res
              .status(400)
              .json({
                success: false,

                message:
                  "Solo puedes subir una imagen por solicitud",

                code:
                  "PRODUCT_IMAGE_FILE_COUNT_INVALID",
              });
          }

          if (
            error.code ===
            "LIMIT_UNEXPECTED_FILE"
          ) {
            return res
              .status(400)
              .json({
                success: false,

                message:
                  'El campo del archivo debe llamarse "image"',

                code:
                  "PRODUCT_IMAGE_FIELD_INVALID",
              });
          }

          return res
            .status(400)
            .json({
              success: false,

              message:
                "No fue posible procesar la imagen enviada",

              code:
                error.code ||
                "PRODUCT_IMAGE_UPLOAD_ERROR",
            });
        }

        /* =====================================
           ERRORES VALIDACIÓN
        ===================================== */

        return res
          .status(
            error.status ||
            400
          )
          .json({
            success: false,

            message:
              error.message ||
              "Imagen de producto inválida",

            code:
              error.code ||
              "PRODUCT_IMAGE_UPLOAD_ERROR",
          });
      }
    );
  };

/* =========================================
   IMÁGENES DE PROYECTOS
   - Pipeline independiente del de productos
   - Mantiene intacto productImageUploadMiddleware
========================================= */

const PROJECT_IMAGE_MAX_SIZE_MB =
  Math.max(
    Number.parseInt(
      process.env.PROJECT_IMAGE_MAX_SIZE_MB,
      10
    ) ||
      PRODUCT_IMAGE_MAX_SIZE_MB,
    1
  );

const PROJECT_IMAGE_MAX_FILE_SIZE =
  PROJECT_IMAGE_MAX_SIZE_MB *
  1024 *
  1024;

const projectImageUpload =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      files: 1,
      fileSize:
        PROJECT_IMAGE_MAX_FILE_SIZE,
    },

    fileFilter: (
      req,
      file,
      callback
    ) => {
      const extension =
        path
          .extname(
            file.originalname ||
            ""
          )
          .toLowerCase();

      const mimeType =
        String(
          file.mimetype ||
          ""
        )
          .trim()
          .toLowerCase();

      const validMimeType =
        PRODUCT_IMAGE_ALLOWED_MIME_TYPES.has(
          mimeType
        );

      const validExtension =
        PRODUCT_IMAGE_ALLOWED_EXTENSIONS.has(
          extension
        );

      if (
        !validMimeType ||
        !validExtension
      ) {
        const error =
          new Error(
            "La imagen del proyecto debe ser JPG, JPEG, PNG, WEBP o AVIF"
          );

        error.status = 400;
        error.code =
          "PROJECT_IMAGE_FILE_TYPE_INVALID";

        return callback(
          error
        );
      }

      return callback(
        null,
        true
      );
    },
  });

export const projectImageUploadMiddleware =
  (
    req,
    res,
    next
  ) => {
    projectImageUpload.single(
      "image"
    )(
      req,
      res,
      (
        error
      ) => {
        if (!error) {
          return next();
        }

        if (
          error instanceof
          multer.MulterError
        ) {
          if (
            error.code ===
            "LIMIT_FILE_SIZE"
          ) {
            return res
              .status(413)
              .json({
                success: false,
                message:
                  `La imagen supera el máximo permitido de ${PROJECT_IMAGE_MAX_SIZE_MB} MB`,
                code:
                  "PROJECT_IMAGE_FILE_TOO_LARGE",
              });
          }

          return res
            .status(400)
            .json({
              success: false,
              message:
                "No fue posible procesar la imagen del proyecto",
              code:
                error.code ||
                "PROJECT_IMAGE_UPLOAD_ERROR",
            });
        }

        return res
          .status(
            error.status ||
            400
          )
          .json({
            success: false,
            message:
              error.message ||
              "Imagen de proyecto inválida",
            code:
              error.code ||
              "PROJECT_IMAGE_UPLOAD_ERROR",
          });
      }
    );
  };

/* =========================================
   AVATAR DE PERFIL
   - Memoria
   - 1 archivo por solicitud
   - Campo esperado: avatar
   - Máximo 3 MB
========================================= */

const AVATAR_MAX_FILE_SIZE =
  3 * 1024 * 1024;

const AVATAR_ALLOWED_MIME_TYPES =
  new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ]);

const AVATAR_ALLOWED_EXTENSIONS =
  new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
  ]);

const avatarUpload =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      files: 1,
      fileSize:
        AVATAR_MAX_FILE_SIZE,
    },

    fileFilter: (
      req,
      file,
      callback
    ) => {
      const extension =
        path
          .extname(
            file.originalname ||
            ""
          )
          .toLowerCase();

      const mimeType =
        String(
          file.mimetype ||
          ""
        )
          .trim()
          .toLowerCase();

      if (
        !AVATAR_ALLOWED_MIME_TYPES.has(
          mimeType
        ) ||
        !AVATAR_ALLOWED_EXTENSIONS.has(
          extension
        )
      ) {
        const error =
          new Error(
            "La foto de perfil debe ser JPG, JPEG, PNG o WEBP"
          );

        error.status = 400;
        error.code =
          "PROFILE_AVATAR_FILE_TYPE_INVALID";

        return callback(
          error
        );
      }

      return callback(
        null,
        true
      );
    },
  });

export const avatarUploadMiddleware =
  (req, res, next) => {
    avatarUpload.single(
      "avatar"
    )(
      req,
      res,
      (error) => {
        if (!error) {
          return next();
        }

        if (
          error instanceof
            multer.MulterError
        ) {
          if (
            error.code ===
            "LIMIT_FILE_SIZE"
          ) {
            return res
              .status(413)
              .json({
                success: false,
                message:
                  "La foto de perfil supera el máximo permitido de 3 MB",
                code:
                  "PROFILE_AVATAR_FILE_TOO_LARGE",
              });
          }

          return res
            .status(400)
            .json({
              success: false,
              message:
                "No fue posible procesar la foto de perfil",
              code:
                error.code ||
                "PROFILE_AVATAR_UPLOAD_ERROR",
            });
        }

        return res
          .status(
            error.status ||
            400
          )
          .json({
            success: false,
            message:
              error.message ||
              "Foto de perfil inválida",
            code:
              error.code ||
              "PROFILE_AVATAR_UPLOAD_ERROR",
          });
      }
    );
  };

