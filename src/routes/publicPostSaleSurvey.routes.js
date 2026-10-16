import {
  Router,
} from "express";

import {
  getPublicSurvey,
  submitSurveyExperience,
  submitSurveyProductReviews,
} from "../controllers/postSaleSurvey.controller.js";


const router =
  Router();


/*
 * Rutas públicas autenticadas por token aleatorio.
 * NO utilizan JWT de cliente/admin.
 */

router.get(
  "/:token",
  getPublicSurvey
);

router.post(
  "/:token/experience",
  submitSurveyExperience
);

router.post(
  "/:token/reviews",
  submitSurveyProductReviews
);


export default router;
