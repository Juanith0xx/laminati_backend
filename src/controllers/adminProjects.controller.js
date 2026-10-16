import {
  randomUUID,
} from "node:crypto";

import {
  projectCreateSchema,
  projectUpdateSchema,
  projectStatusSchema,
  projectImageCreateSchema,
  projectImageUpdateSchema,
  projectProductSchema,
} from "../schemas/project.schema.js";

import {
  listAdminProjects,
  getAdminProjectById,
  createProject,
  updateProject,
  setProjectStatus,
  archiveProject,
  deleteProjectPermanently,
  createProjectImage,
  createStoredProjectImage,
  getProjectStorageIdentity,
  updateProjectImage,
  deleteProjectImage,
  attachProjectProduct,
  removeProjectProduct,
} from "../services/projects.service.js";

import {
  uploadProjectImage,
  deleteProjectImageVariants,
  getProjectImageSignedUrl,
} from "../services/projectImageStorage.service.js";


function parseBoolean(
  value
) {
  if (
    value === true ||
    value === "true" ||
    value === "1"
  ) {
    return true;
  }

  if (
    value === false ||
    value === "false" ||
    value === "0"
  ) {
    return false;
  }

  return undefined;
}


function parseInteger(
  value,
  fallback,
  {
    min = 0,
    max = 1000,
  } = {}
) {
  const number =
    Number.parseInt(
      value,
      10
    );

  if (
    !Number.isFinite(
      number
    )
  ) {
    return fallback;
  }

  return Math.min(
    max,
    Math.max(
      min,
      number
    )
  );
}


function validationError(
  res,
  parsed
) {
  return res
    .status(400)
    .json({
      success: false,
      code:
        "VALIDATION_ERROR",
      message:
        "Datos inválidos",
      errors:
        parsed.error.issues.map(
          (
            issue
          ) => ({
            path:
              issue.path.join(
                "."
              ),
            message:
              issue.message,
          })
        ),
    });
}


function sendError(
  res,
  error
) {
  console.error(
    "Error módulo proyectos:",
    error
  );

  const status =
    Number.isInteger(
      error?.status
    )
      ? error.status
      : 500;

  return res
    .status(
      status
    )
    .json({
      success: false,
      code:
        error?.code ||
        "INTERNAL_ERROR",
      message:
        status >= 500
          ? "Error interno al procesar el proyecto"
          : error.message,
    });
}


function parseUploadBoolean(
  value,
  fallback = false
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const normalized =
    String(
      value
    )
      .trim()
      .toLowerCase();

  if (
    normalized === "true" ||
    normalized === "1"
  ) {
    return true;
  }

  if (
    normalized === "false" ||
    normalized === "0"
  ) {
    return false;
  }

  const error =
    new Error(
      "is_primary debe ser true o false"
    );

  error.status = 400;
  error.code =
    "PROJECT_IMAGE_PRIMARY_INVALID";

  throw error;
}


export const listAdminProjectsController =
  async (
    req,
    res
  ) => {
    try {
      const result =
        await listAdminProjects({
          search:
            req.query.search
              ?.trim() ||
            undefined,
          status:
            req.query.status ||
            undefined,
          category:
            req.query.category
              ?.trim() ||
            undefined,
          is_active:
            parseBoolean(
              req.query.is_active
            ),
          is_featured:
            parseBoolean(
              req.query.is_featured
            ),
          include_deleted:
            parseBoolean(
              req.query.include_deleted
            ) ||
            false,
          limit:
            parseInteger(
              req.query.limit,
              50,
              {
                min: 1,
                max: 100,
              }
            ),
          offset:
            parseInteger(
              req.query.offset,
              0,
              {
                min: 0,
                max: 1000000,
              }
            ),
        });

      return res.json({
        success: true,
        ...result,
      });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const getAdminProjectController =
  async (
    req,
    res
  ) => {
    try {
      const project =
        await getAdminProjectById(
          req.params.projectId
        );

      return res.json({
        success: true,
        project,
      });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const createAdminProjectController =
  async (
    req,
    res
  ) => {
    try {
      const parsed =
        projectCreateSchema.safeParse(
          req.body
        );

      if (
        !parsed.success
      ) {
        return validationError(
          res,
          parsed
        );
      }

      const project =
        await createProject(
          parsed.data,
          req.user.id
        );

      return res
        .status(201)
        .json({
          success: true,
          message:
            "Proyecto creado correctamente",
          project,
        });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const updateAdminProjectController =
  async (
    req,
    res
  ) => {
    try {
      const parsed =
        projectUpdateSchema.safeParse(
          req.body
        );

      if (
        !parsed.success
      ) {
        return validationError(
          res,
          parsed
        );
      }

      const project =
        await updateProject(
          req.params.projectId,
          parsed.data,
          req.user.id
        );

      return res.json({
        success: true,
        message:
          "Proyecto actualizado correctamente",
        project,
      });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const setAdminProjectStatusController =
  async (
    req,
    res
  ) => {
    try {
      const parsed =
        projectStatusSchema.safeParse(
          req.body
        );

      if (
        !parsed.success
      ) {
        return validationError(
          res,
          parsed
        );
      }

      const project =
        await setProjectStatus(
          req.params.projectId,
          parsed.data,
          req.user.id
        );

      return res.json({
        success: true,
        message:
          "Estado del proyecto actualizado",
        project,
      });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const deleteAdminProjectController =
  async (
    req,
    res
  ) => {
    try {
      const project =
        await archiveProject(
          req.params.projectId,
          req.user.id
        );

      return res.json({
        success: true,
        message:
          "Proyecto archivado correctamente",
        project,
      });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const hardDeleteAdminProjectController =
  async (
    req,
    res
  ) => {
    try {
      const result =
        await deleteProjectPermanently(
          req.params.projectId
        );

      /*
       * La eliminación en BD ya ocurrió.
       * La limpieza del storage se intenta después para
       * no dejar el registro bloqueado si el proveedor
       * de archivos falla temporalmente.
       */
      if (
        result.storageKeys.length >
        0
      ) {
        try {
          await deleteProjectImageVariants(
            result.storageKeys
          );
        } catch (
          storageError
        ) {
          console.error(
            "Proyecto eliminado, pero no fue posible limpiar todas las imágenes del storage:",
            storageError
          );
        }
      }

      return res.json({
        success: true,
        message:
          "Proyecto eliminado permanentemente",
        project:
          result.project,
      });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const createAdminProjectImageController =
  async (
    req,
    res
  ) => {
    const hasUploadedFile =
      Boolean(
        req.file?.buffer
      );

    if (!hasUploadedFile) {
      try {
        const parsed =
          projectImageCreateSchema.safeParse(
            req.body
          );

        if (
          !parsed.success
        ) {
          return validationError(
            res,
            parsed
          );
        }

        const image =
          await createProjectImage(
            req.params.projectId,
            parsed.data
          );

        return res
          .status(201)
          .json({
            success: true,
            message:
              "Imagen agregada correctamente",
            storage:
              "EXTERNAL_URL",
            image,
          });
      } catch (
        error
      ) {
        return sendError(
          res,
          error
        );
      }
    }

    let isPrimary;
    let sortOrder;

    try {
      isPrimary =
        parseUploadBoolean(
          req.body.is_primary,
          false
        );

      sortOrder =
        parseInteger(
          req.body.sort_order,
          0,
          {
            min: 0,
            max: 100000,
          }
        );
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }

    const altText =
      req.body.alt_text
        ? String(
            req.body.alt_text
          ).trim()
        : null;

    const caption =
      req.body.caption
        ? String(
            req.body.caption
          ).trim()
        : null;

    const originalFilename =
      String(
        req.file.originalname ||
        "image"
      ).trim();

    if (
      altText &&
      altText.length > 240
    ) {
      return res
        .status(400)
        .json({
          success: false,
          code:
            "PROJECT_IMAGE_ALT_TOO_LONG",
          message:
            "alt_text no puede superar 240 caracteres",
        });
    }

    if (
      caption &&
      caption.length > 500
    ) {
      return res
        .status(400)
        .json({
          success: false,
          code:
            "PROJECT_IMAGE_CAPTION_TOO_LONG",
          message:
            "caption no puede superar 500 caracteres",
        });
    }

    if (
      originalFilename.length >
      255
    ) {
      return res
        .status(400)
        .json({
          success: false,
          code:
            "PROJECT_IMAGE_FILENAME_TOO_LONG",
          message:
            "El nombre del archivo no puede superar 255 caracteres",
        });
    }

    let project;

    try {
      project =
        await getProjectStorageIdentity(
          req.params.projectId
        );
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }

    const imageId =
      randomUUID();

    let storageResult;

    try {
      storageResult =
        await uploadProjectImage({
          buffer:
            req.file.buffer,
          projectSlug:
            project.slug,
          imageId,
        });
    } catch (
      error
    ) {
      console.error(
        "Error procesando imagen de proyecto:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          code:
            "PROJECT_IMAGE_STORAGE_ERROR",
          message:
            "No fue posible procesar o almacenar la imagen del proyecto",
        });
    }

    const storageKeys = [
      storageResult?.variants
        ?.thumbnail?.key,
      storageResult?.variants
        ?.card?.key,
      storageResult?.variants
        ?.detail?.key,
    ].filter(
      Boolean
    );

    let image;

    try {
      image =
        await createStoredProjectImage(
          project.id,
          {
            id:
              imageId,
            thumbnail_key:
              storageResult.variants.thumbnail.key,
            card_key:
              storageResult.variants.card.key,
            detail_key:
              storageResult.variants.detail.key,
            original_filename:
              originalFilename,
            alt_text:
              altText,
            caption,
            is_primary:
              isPrimary,
            sort_order:
              sortOrder,
          }
        );
    } catch (
      error
    ) {
      try {
        await deleteProjectImageVariants(
          storageKeys
        );
      } catch (
        cleanupError
      ) {
        console.error(
          "Error limpiando imagen de proyecto después de fallo DB:",
          cleanupError
        );
      }

      return sendError(
        res,
        error
      );
    }

    return res
      .status(201)
      .json({
        success: true,
        message:
          "Imagen de proyecto subida correctamente",
        storage:
          "RAILWAY",
        project: {
          id:
            project.id,
          title:
            project.title,
          slug:
            project.slug,
        },
        image,
        variants:
          storageResult.variants,
      });
  };


export const updateAdminProjectImageController =
  async (
    req,
    res
  ) => {
    try {
      const parsed =
        projectImageUpdateSchema.safeParse(
          req.body
        );

      if (
        !parsed.success
      ) {
        return validationError(
          res,
          parsed
        );
      }

      const image =
        await updateProjectImage(
          req.params.projectId,
          req.params.imageId,
          parsed.data
        );

      return res.json({
        success: true,
        message:
          "Imagen actualizada correctamente",
        image,
      });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const deleteAdminProjectImageController =
  async (
    req,
    res
  ) => {
    try {
      const image =
        await deleteProjectImage(
          req.params.projectId,
          req.params.imageId
        );

      const storageKeys = [
        image?.thumbnail_key,
        image?.card_key,
        image?.detail_key,
      ].filter(
        Boolean
      );

      let warning = null;

      if (
        image?.storage_provider ===
          "RAILWAY" &&
        storageKeys.length > 0
      ) {
        try {
          await deleteProjectImageVariants(
            storageKeys
          );
        } catch (
          storageError
        ) {
          warning =
            "La imagen se eliminó del proyecto, pero quedó una limpieza pendiente en Railway Storage.";

          console.error(
            "Error limpiando variantes de proyecto:",
            {
              project_id:
                req.params.projectId,
              image_id:
                req.params.imageId,
              storageKeys,
              error:
                storageError,
            }
          );
        }
      }

      return res.json({
        success: true,
        message:
          warning ||
          "Imagen eliminada correctamente",
        warning,
        image,
      });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const attachAdminProjectProductController =
  async (
    req,
    res
  ) => {
    try {
      const parsed =
        projectProductSchema.safeParse(
          req.body
        );

      if (
        !parsed.success
      ) {
        return validationError(
          res,
          parsed
        );
      }

      const relation =
        await attachProjectProduct(
          req.params.projectId,
          parsed.data
        );

      return res
        .status(201)
        .json({
          success: true,
          message:
            "Producto asociado al proyecto",
          relation,
        });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };


export const removeAdminProjectProductController =
  async (
    req,
    res
  ) => {
    try {
      const relation =
        await removeProjectProduct(
          req.params.projectId,
          req.params.productId
        );

      return res.json({
        success: true,
        message:
          "Producto eliminado del proyecto",
        relation,
      });
    } catch (
      error
    ) {
      return sendError(
        res,
        error
      );
    }
  };
