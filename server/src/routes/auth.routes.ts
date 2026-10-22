import { Router } from "express";
import {
  acceptInvite,
  login,
  logout,
  me,
  postPasswordReset,
  postPasswordResetRequest,
  register,
  registration,
  showInvite,
  showPasswordReset,
} from "../controllers/auth.controller.ts";
import { authLimiter } from "../middleware/authLimiter.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const authRouter = Router();

authRouter.get("/registration", authLimiter, registration);
authRouter.get("/invites/:token", authLimiter, showInvite);
authRouter.post("/invites/:token/accept", userLimiter, requireAuth, acceptInvite);
authRouter.post("/register", authLimiter, register);
authRouter.post("/login", authLimiter, login);
authRouter.post("/password-reset", authLimiter, postPasswordResetRequest);
authRouter.get("/password-reset/:token", authLimiter, showPasswordReset);
authRouter.post("/password-reset/:token", authLimiter, postPasswordReset);
authRouter.post("/logout", userLimiter, logout);
authRouter.get("/me", userLimiter, requireAuth, me);
