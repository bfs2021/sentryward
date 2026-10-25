import { Router } from "express";
import {
  getFinding,
  getFindingCalibration,
  getFindingStats,
  listFindings,
  updateFinding,
} from "../controllers/findings.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const findingsRouter = Router();

findingsRouter.use(userLimiter, requireAuth, requireWorkspace);
findingsRouter.get("/", listFindings);
// Before "/:id", which would reject "stats" as a malformed id.
findingsRouter.get("/stats", getFindingStats);
findingsRouter.get("/calibration", getFindingCalibration);
findingsRouter.get("/:id", getFinding);
findingsRouter.patch("/:id", updateFinding);
