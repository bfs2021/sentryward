import type { Request } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { hashToken, newToken } from "../lib/tokens.ts";

// The prefix makes a leaked token recognizable to secret scanners and tells it
// apart from other bearer values at a glance.
export const API_TOKEN_PREFIX = "swt_";
const DAY_MS = 24 * 60 * 60 * 1000;
// lastUsedAt is shown to the day or minute, so a script polling every few
// seconds needs no write per request.
const TOUCH_INTERVAL_MS = 60 * 1000;

export const publicApiToken = {
  id: true,
  name: true,
  expiresAt: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

// The raw value exists only in the returned object; it is never stored.
export async function createApiToken(userId: string, name: string, expiresInDays: number | null) {
  const value = `${API_TOKEN_PREFIX}${newToken()}`;
  const expiresAt = expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY_MS);
  const token = await prisma.apiToken.create({
    data: { userId, name, tokenHash: hashToken(value), expiresAt },
    select: publicApiToken,
  });
  return { token, value };
}

// Expired tokens stay listed, so the user can see why a script stopped working.
export function listApiTokens(userId: string) {
  return prisma.apiToken.findMany({ where: { userId }, select: publicApiToken, orderBy: { createdAt: "desc" } });
}

export async function revokeApiToken(userId: string, id: string) {
  const { count } = await prisma.apiToken.deleteMany({ where: { id, userId } });
  if (count === 0) {
    throw new HttpError(404, "Token not found");
  }
}

export function bearerValue(req: Request): string | null {
  const header = req.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match ? match[1]! : null;
}

type BearerAuth = { userId: string; tokenId: string };
const resolved = new WeakMap<Request, Promise<BearerAuth | null>>();

// Memoized per request: the rate limiter and requireAuth both need the token's
// user, and this keeps it to one lookup.
export function bearerUser(req: Request): Promise<BearerAuth | null> {
  let pending = resolved.get(req);
  if (!pending) {
    pending = lookupBearer(bearerValue(req));
    resolved.set(req, pending);
  }
  return pending;
}

async function lookupBearer(value: string | null): Promise<BearerAuth | null> {
  if (!value?.startsWith(API_TOKEN_PREFIX)) return null;
  const token = await prisma.apiToken.findFirst({
    where: { tokenHash: hashToken(value), OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { id: true, userId: true },
  });
  return token ? { userId: token.userId, tokenId: token.id } : null;
}

export async function touchApiToken(id: string) {
  const stale = new Date(Date.now() - TOUCH_INTERVAL_MS);
  await prisma.apiToken.updateMany({
    where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: stale } }] },
    data: { lastUsedAt: new Date() },
  });
}
