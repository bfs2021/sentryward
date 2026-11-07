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
import { signInCallback, signInStart } from "../controllers/signIn.controller.ts";
import { authLimiter } from "../middleware/authLimiter.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { userLimiter } from "../middleware/apiLimiter.ts";

export const authRouter = Router();

// Read on every auth page load and checks no password, so it must not spend
// the login allowance: a 429 here hides the sign-up link.
authRouter.get("/registration", userLimiter, registration);
authRouter.get("/invites/:token", authLimiter, showInvite);
authRouter.post("/invites/:token/accept", userLimiter, requireAuth, acceptInvite);
authRouter.post("/register", authLimiter, register);
authRouter.post("/login", authLimiter, login);
authRouter.post("/password-reset", authLimiter, postPasswordResetRequest);
authRouter.get("/password-reset/:token", authLimiter, showPasswordReset);
authRouter.post("/password-reset/:token", authLimiter, postPasswordReset);
authRouter.post("/logout", userLimiter, logout);
authRouter.get("/me", userLimiter, requireAuth, me);
// Browser navigations to and back from a sign-in provider. GET, but they
// create sessions and accounts, so they share the login allowance.
authRouter.get("/oauth/:provider/start", authLimiter, signInStart);
authRouter.get("/oauth/:provider/callback", authLimiter, signInCallback);
