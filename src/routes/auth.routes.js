import { Router } from "express";
import rateLimit from "express-rate-limit";

import {
  register,
  registerCompany,
  login,
  logout,
  me,
  updateMe,
  updateAvatar,
  deleteAvatar,
  changePassword,
  session,
  extendSession,
} from "../controllers/auth.controller.js";

import {
  authenticate,
} from "../middlewares/auth.middleware.js";

import {
  avatarUploadMiddleware,
} from "../middlewares/upload.middleware.js";

import {
  recordAuthEventSafely,
} from "../services/authAudit.service.js";

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
  handler: async (req, res, _next, options) => {
    await recordAuthEventSafely({
      email: req.body?.email || null,
      eventType: "LOGIN_FAILED",
      success: false,
      req,
      failureReason: "RATE_LIMITED",
    });

    return res
      .status(options.statusCode || 429)
      .json(options.message);
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

router.post(
  "/logout",
  logout
);

router.get(
  "/me",
  authenticate,
  me
);

router.patch(
  "/me",
  authenticate,
  updateMe
);


router.patch(
  "/me/avatar",
  authenticate,
  avatarUploadMiddleware,
  updateAvatar
);

router.delete(
  "/me/avatar",
  authenticate,
  deleteAvatar
);

const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message:
      "Demasiados intentos de cambio de contraseña. Inténtalo nuevamente más tarde.",
  },
});

router.post(
  "/change-password",
  passwordChangeLimiter,
  authenticate,
  changePassword
);

router.get(
  "/session",
  authenticate,
  session
);

router.post(
  "/extend-session",
  authenticate,
  extendSession
);

export default router;