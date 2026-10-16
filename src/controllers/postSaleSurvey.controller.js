import {
  getPublicPostSaleSurvey,
  savePostSaleExperience,
  savePostSaleProductReviews,
} from "../services/postSaleSurvey.service.js";


const sendError = (
  res,
  error
) => {
  console.error(
    "Post-sale survey error:",
    error
  );

  return res
    .status(
      error.status ||
        500
    )
    .json({
      success:
        false,

      code:
        error.code ||
        "POST_SALE_SURVEY_ERROR",

      message:
        error.status
          ? error.message
          : "No fue posible procesar la encuesta",
    });
};


/* =========================================
   GET ENCUESTA
========================================= */

export const getPublicSurvey =
  async (
    req,
    res
  ) => {
    try {
      const survey =
        await getPublicPostSaleSurvey(
          req.params.token
        );

      return res
        .status(200)
        .json({
          success:
            true,

          survey,
        });
    } catch (error) {
      return sendError(
        res,
        error
      );
    }
  };


/* =========================================
   PASO 1 · EXPERIENCIA
========================================= */

export const submitSurveyExperience =
  async (
    req,
    res
  ) => {
    try {
      const response =
        await savePostSaleExperience(
          req.params.token,
          req.body || {}
        );

      return res
        .status(200)
        .json({
          success:
            true,

          message:
            "Experiencia guardada correctamente",

          response,
        });
    } catch (error) {
      return sendError(
        res,
        error
      );
    }
  };


/* =========================================
   PASO 2 · PRODUCTOS + COMPLETAR
========================================= */

export const submitSurveyProductReviews =
  async (
    req,
    res
  ) => {
    try {
      const result =
        await savePostSaleProductReviews(
          req.params.token,
          req.body || {}
        );

      return res
        .status(200)
        .json({
          success:
            true,

          message:
            "Gracias. Tu opinión fue registrada correctamente.",

          ...result,
        });
    } catch (error) {
      return sendError(
        res,
        error
      );
    }
  };
