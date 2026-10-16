import { Router } from "express";

import {
  relbaseCallback,
} from "../controllers/relbase.controller.js";

const router = Router();

/* =========================================
   CALLBACK PÚBLICO RELBASE
========================================= */
router.get(
  "/callback",
  relbaseCallback
);

export default router;