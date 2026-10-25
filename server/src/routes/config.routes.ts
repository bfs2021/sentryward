import { Router } from "express";
import { checkRulePatterns, getConfigSchema, getGlobalConfig, previewConfig, updateGlobalConfig } from "../controllers/config.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace, requireWorkspaceRole } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const configRouter = Router();

configRouter.get("/schema", userLimiter, requireAuth, getConfigSchema);
configRouter.get("/global", userLimiter, requireAuth, requireWorkspace, getGlobalConfig);
configRouter.put("/global", userLimiter, requireAuth, requireWorkspace, requireWorkspaceRole("admin"), updateGlobalConfig);
configRouter.post("/preview", userLimiter, requireAuth, previewConfig);
configRouter.post("/rules/check", userLimiter, requireAuth, checkRulePatterns);
