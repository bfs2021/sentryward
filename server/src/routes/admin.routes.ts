import { Router } from "express";
import {
  deleteUser,
  listInvites,
  listUsers,
  postInvite,
  postPasswordReset,
  postResendInvite,
  revokeInvite,
  updateUser,
} from "../controllers/admin.controller.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { requireInstanceAdmin } from "../middleware/requireInstanceAdmin.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const adminRouter = Router();

adminRouter.use(userLimiter, requireAuth, requireInstanceAdmin);
adminRouter.get("/users", listUsers);
adminRouter.patch("/users/:id", updateUser);
adminRouter.delete("/users/:id", deleteUser);
adminRouter.post("/users/:id/password-reset", postPasswordReset);
adminRouter.get("/invites", listInvites);
adminRouter.post("/invites", postInvite);
adminRouter.post("/invites/:id/resend", postResendInvite);
adminRouter.delete("/invites/:id", revokeInvite);
