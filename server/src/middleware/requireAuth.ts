import type { NextFunction, Request, Response } from "express";
import { AUTH_COOKIE, verifyToken } from "../lib/jwt.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { bearerUser, touchApiToken } from "../services/apiTokens.ts";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      authMethod?: "cookie" | "token";
    }
  }
}

// API tokens are for scripts and CI: they may read anything their user can and
// queue reviews, nothing else. A leaked token then cannot change the account,
// its connections or settings. Matched against the mounted path, since this
// runs as router-level middleware before any route is chosen. A GET route that
// changes state (the forge install and OAuth flows) also needs requireSession.
const TOKEN_WRITES: { method: string; path: RegExp }[] = [
  { method: "POST", path: /^\/api\/reviews\/?$/ },
  { method: "POST", path: /^\/api\/reviews\/[^/]+\/rerun\/?$/ },
];

function tokenMayWrite(req: Request): boolean {
  const path = req.baseUrl + req.path;
  return TOKEN_WRITES.some((rule) => rule.method === req.method && rule.path.test(path));
}

// An Authorization header means a script: only the token is checked, so a bad
// token fails loudly instead of falling back to a browser cookie.
async function authenticateToken(req: Request) {
  const auth = await bearerUser(req);
  if (!auth) {
    throw new HttpError(401, "Not authenticated");
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !tokenMayWrite(req)) {
    throw new HttpError(403, "API tokens cannot be used for this request");
  }
  await touchApiToken(auth.tokenId);
  req.userId = auth.userId;
  req.authMethod = "token";
}

// The token alone cannot be revoked, so its session version is checked against
// the user's on every request: a password change or reset bumps the version and
// every older session stops working. A deleted user is signed out the same way.
async function authenticateCookie(req: Request) {
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
  req.authMethod = "cookie";
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.get("authorization") !== undefined) {
    await authenticateToken(req);
  } else {
    await authenticateCookie(req);
  }
  next();
}

// Runs after requireAuth, for routes a token must never reach whatever the
// method, such as managing the tokens themselves.
export function requireSession(req: Request, _res: Response, next: NextFunction) {
  if (req.authMethod !== "cookie") {
    throw new HttpError(403, "This request needs a signed-in session");
  }
  next();
}
