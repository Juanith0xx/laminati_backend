import {
  getCutOptimizerHealth,
  optimizeBathroomCuts,
} from "../services/cutOptimizerClient.service.js";

const sendError = (
  res,
  error
) => {
  const status =
    Number(error?.status) ||
    500;

  return res
    .status(status)
    .json({
      success: false,
      message:
        error?.message ||
        "Error interno",
      code:
        error?.code ||
        "INTERNAL_ERROR",
      ...(error?.details
        ? {
            details:
              error.details,
          }
        : {}),
    });
};

export const getBathroomOptimizerHealthController =
  async (req, res) => {
    try {
      const health =
        await getCutOptimizerHealth();

      return res
        .status(200)
        .json({
          success: true,
          optimizer:
            health,
        });
    } catch (error) {
      return sendError(
        res,
        error
      );
    }
  };

export const optimizeBathroomProjectController =
  async (req, res) => {
    try {
      if (
        !req.body ||
        typeof req.body !==
          "object" ||
        Array.isArray(req.body)
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "El cuerpo de la solicitud debe ser un objeto JSON",
            code:
              "INVALID_REQUEST_BODY",
          });
      }

      const result =
        await optimizeBathroomCuts(
          req.body
        );

      return res
        .status(200)
        .json({
          success: true,
          data: result.data,
        });
    } catch (error) {
      return sendError(
        res,
        error
      );
    }
  };
