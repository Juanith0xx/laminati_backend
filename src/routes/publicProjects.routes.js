import {
  Router,
} from "express";

import {
  listPublicProjectsController,
  getPublicProjectController,
} from "../controllers/publicProjects.controller.js";


const router =
  Router();


router.get(
  "/",
  listPublicProjectsController
);


router.get(
  "/:slug",
  getPublicProjectController
);


export default router;
