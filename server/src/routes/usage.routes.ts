import { Router } from "express";
import { getRecentUsage, getUsage } from "../controllers/usage.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const usageRouter = Router();

usageRouter.use(userLimiter, requireAuth, requireWorkspace);
usageRouter.get("/", getUsage);
usageRouter.get("/recent", getRecentUsage);
