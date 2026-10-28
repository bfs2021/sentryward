import { Router } from "express";
import {
  exportWorkspaceAuditLog,
  getWorkspacePrivacy,
  listWorkspaceAuditLog,
  updateWorkspacePrivacy,
} from "../controllers/privacy.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireWorkspace, requireWorkspaceRole } from "../middleware/requireWorkspace.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const privacyRouter = Router();

// Members can see the policy their reviews run under; only admins change it
// or read the audit log.
privacyRouter.use(userLimiter, requireAuth, requireWorkspace);
privacyRouter.get("/", getWorkspacePrivacy);
privacyRouter.put("/", requireWorkspaceRole("admin"), updateWorkspacePrivacy);
privacyRouter.get("/audit-log", requireWorkspaceRole("admin"), listWorkspaceAuditLog);
privacyRouter.get("/audit-log/export", requireWorkspaceRole("admin"), exportWorkspaceAuditLog);
