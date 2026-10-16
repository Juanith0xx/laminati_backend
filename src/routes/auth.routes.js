import { Router } from "express";
import rateLimit from "express-rate-limit";

import {
  register,
  registerCompany,
  login,
  me,
} from "../controllers/auth.controller.js";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "Demasiados intentos de inicio de sesión. Inténtalo nuevamente más tarde.",
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "Se alcanzó el límite temporal de registros. Inténtalo nuevamente más tarde.",
  },
});

router.post(
  "/register",
  registerLimiter,
  register
);

router.post(
  "/register-company",
  registerLimiter,
  registerCompany
);

router.post(
  "/login",
  loginLimiter,
  login
);

router.get(
  "/me",
  authenticate,
  me
);

export default router;
