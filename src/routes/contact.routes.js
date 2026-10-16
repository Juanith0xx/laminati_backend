import { Router } from "express";
import rateLimit from "express-rate-limit";
import { createContactMessage } from "../controllers/contact.controller.js";

const router = Router();

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    code: "CONTACT_RATE_LIMIT",
    message: "Has enviado varias consultas. Espera unos minutos antes de volver a intentarlo.",
  },
});

router.post("/", contactLimiter, createContactMessage);

export default router;
