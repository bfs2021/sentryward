import type { NextFunction, Request, Response } from "express";
import { AUTH_COOKIE, verifyToken } from "../lib/jwt.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// The token alone cannot be revoked, so its session version is checked against
// the user's on every request: a password change or reset bumps the version and
// every older session stops working. A deleted user is signed out the same way.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[AUTH_COOKIE];
  const payload = typeof token === "string" ? verifyToken(token) : null;
  if (!payload) {
    throw new HttpError(401, "Not authenticated");
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { sessionVersion: true } });
  if (!user || user.sessionVersion !== payload.ver) {
    throw new HttpError(401, "Not authenticated");
  }
  req.userId = payload.sub;
  next();
}
