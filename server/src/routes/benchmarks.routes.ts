import { Router } from "express";
import { getBenchmarks } from "../controllers/benchmarks.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const benchmarksRouter = Router();

benchmarksRouter.use(userLimiter, requireAuth, requireWorkspace);
benchmarksRouter.get("/", getBenchmarks);
