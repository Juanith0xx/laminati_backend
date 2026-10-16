import {
  listPublicProjects,
  getPublicProjectBySlug,
} from "../services/projects.service.js";


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
    max = 100,
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


function sendError(
  res,
  error
) {
  const status =
    Number.isInteger(
      error?.status
    )
      ? error.status
      : 500;

  if (
    status >= 500
  ) {
    console.error(
      "Error API pública proyectos:",
      error
    );
  }

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
          ? "No fue posible obtener los proyectos"
          : error.message,
    });
}


export const listPublicProjectsController =
  async (
    req,
    res
  ) => {
    try {
      const result =
        await listPublicProjects({
          category:
            req.query.category
              ?.trim() ||
            undefined,

          featured:
            parseBoolean(
              req.query.featured
            ),

          limit:
            parseInteger(
              req.query.limit,
              24,
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
                max:
                  1000000,
              }
            ),
        });

      return res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      return sendError(
        res,
        error
      );
    }
  };


export const getPublicProjectController =
  async (
    req,
    res
  ) => {
    try {
      const project =
        await getPublicProjectBySlug(
          req.params.slug
        );

      return res.json({
        success: true,
        project,
      });
    } catch (error) {
      return sendError(
        res,
        error
      );
    }
  };
