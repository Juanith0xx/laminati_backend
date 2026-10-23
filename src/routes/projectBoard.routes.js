import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { authorizeRoles } from "../middlewares/role.middleware.js";
import {
  addProjectNoteController,
  createProjectFollowupController,
  getProjectBoardDetailController,
  getProjectCalendarController,
  listProjectBoardController,
  listProjectBoardUsersController,
  updateProjectBoardController,
  updateProjectFollowupController,
} from "../controllers/projectBoard.controller.js";

const router=Router();
router.use(authenticate,authorizeRoles("ADMIN","VENDEDOR"));
router.get("/",listProjectBoardController);
router.get("/users",listProjectBoardUsersController);
router.get("/calendar",getProjectCalendarController);
router.get("/:quotationId",getProjectBoardDetailController);
router.patch("/:quotationId",updateProjectBoardController);
router.post("/:quotationId/notes",addProjectNoteController);
router.post("/:quotationId/followups",createProjectFollowupController);
router.patch("/:quotationId/followups/:followupId",updateProjectFollowupController);
export default router;
