import type { Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.ts";
import { AUTH_COOKIE, verifyToken } from "../lib/jwt.ts";
import { bearerUser } from "../services/apiTokens.ts";

// Runs before requireAuth, so the limit also covers requests that fail
// authentication. It is still keyed by user, read from the auth cookie or API
// token: in development every request reaches the API through the Vite proxy,
// so a per-IP limit would be one shared bucket. Requests without valid
// credentials (logout, the GitHub install callback, expired sessions) fall back
// to IP. For cookies only the signature is checked, not the session version, to
// keep a database lookup out of the limiter; a revoked cookie still counts
// against its user, which only spends that user's own allowance. A token can
// only be tied to its user by a lookup, which requireAuth then reuses. Both
// share one bucket, so a script cannot add to its user's allowance.
async function userOrIp(req: Request): Promise<string> {
  if (req.get("authorization") !== undefined) {
    const auth = await bearerUser(req);
    if (auth) return `user:${auth.userId}`;
  } else {
    const token = req.cookies?.[AUTH_COOKIE];
    const payload = typeof token === "string" ? verifyToken(token) : null;
    if (payload) return `user:${payload.sub}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

// Generous enough for dashboard polling; it exists to bound runaway clients and
// scripted abuse of endpoints that queue model work or call forges. Exported so
// tests can build a lower limit; the limiter itself is a direct rateLimit call
// so code scanning recognizes it on every route.
export const userLimitOptions = {
  windowMs: 60 * 1000,
  limit: 600,
  keyGenerator: userOrIp,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many requests, please slow down" },
} as const;

export const userLimiter = rateLimit({ ...userLimitOptions, skip: () => env.NODE_ENV === "test" });

// Webhooks arrive unauthenticated until their signature is checked, so they are
// limited by sender before the body is read.
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: () => env.NODE_ENV === "test",
  message: { message: "Too many requests" },
});
