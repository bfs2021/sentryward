import jwt from "jsonwebtoken";
import type { CookieOptions } from "express";
import { env } from "../config/env.ts";

export const AUTH_COOKIE = "sentryward_token";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

// `ver` is the user's sessionVersion when the token was issued; requireAuth
// rejects tokens whose version is behind, which is how sessions are revoked.
type TokenPayload = { sub: string; ver: number };

export function signToken(userId: string, version = 0) {
  return jwt.sign({ sub: userId, ver: version } satisfies TokenPayload, env.JWT_SECRET, {
    expiresIn: MAX_AGE_SECONDS,
  });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (typeof payload === "object" && typeof payload.sub === "string") {
      // Tokens issued before versions existed carry none and count as version 0.
      return { sub: payload.sub, ver: typeof payload.ver === "number" ? payload.ver : 0 };
    }
    return null;
  } catch {
    return null;
  }
}

export const authCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE_SECONDS * 1000,
};
