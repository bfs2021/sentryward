import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.ts";
import { dummyPasswordHash, hashPassword, verifyPassword } from "../lib/password.ts";
import { AUTH_COOKIE, authCookieOptions, signToken } from "../lib/jwt.ts";
import { HttpError } from "../lib/httpError.ts";
import { env } from "../config/env.ts";
import type { Invite, Prisma } from "../generated/prisma/client.ts";
import { assertInviteEmail, consumeInvite, findValidInvite, joinWorkspace } from "../services/invites.ts";
import { completePasswordReset, findValidReset, requestPasswordReset } from "../services/passwordResets.ts";
import { emailTaken, isUniqueViolation } from "../services/users.ts";
import { mailer } from "../lib/mailer.ts";
import { createPersonalWorkspace, workspacesFor } from "../services/workspaces.ts";
import { configuredSignInProviders } from "../services/signIn/index.ts";
import {
  inviteTokenParamsSchema,
  loginSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  registerSchema,
  resetTokenParamsSchema,
} from "../schemas/auth.schema.ts";

export const publicUser = {
  id: true,
  name: true,
  email: true,
  role: true,
  avatarUpdatedAt: true,
  createdAt: true,
} as const;

// Signs with the user's current session version, so the cookie survives until
// the next password change or reset.
export function setAuthCookie(res: Response, user: { id: string; sessionVersion: number }) {
  res.cookie(AUTH_COOKIE, signToken(user.id, user.sessionVersion), authCookieOptions);
}

// Why a registration was refused, so a sign-in callback (a redirect, not a
// form) can say which message to show.
export type RegistrationRefusal = "registration_closed" | "invite_required" | "invite_invalid";

export class RegistrationError extends HttpError {
  constructor(
    public reason: RegistrationRefusal,
    status: number,
    message: string,
    errors?: Record<string, string[]>,
  ) {
    super(status, message, errors);
  }
}

// Applies REGISTRATION_MODE to everyone but the first account, and returns the
// invite to spend once the user exists. A token is checked whenever one is
// given: in open mode a team invite still brings the new user into its workspace.
async function admitRegistration(
  tx: Prisma.TransactionClient,
  email: string,
  inviteToken?: string,
): Promise<Invite | null> {
  const invite = inviteToken ? await findValidInvite(inviteToken, tx) : null;
  if (inviteToken && !invite) {
    throw new RegistrationError("invite_invalid", 400, "This invite is invalid or has expired");
  }
  if (invite) {
    try {
      assertInviteEmail(invite, email);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new RegistrationError("invite_invalid", error.status, error.message, error.errors);
    }
  }
  if (env.REGISTRATION_MODE === "closed") {
    throw new RegistrationError("registration_closed", 403, "Registration is closed on this Sentryward instance");
  }
  if (env.REGISTRATION_MODE === "invite" && !invite) {
    throw new RegistrationError(
      "invite_required",
      403,
      "An invite is required to register on this Sentryward instance",
    );
  }
  if (env.REGISTRATION_MODE === "invite" && invite?.workspaceId) {
    // Team roles do not authorize new accounts. Check the original creator's
    // current instance role so demotion or deletion removes that authority.
    const inviter = invite.invitedById
      ? await tx.user.findUnique({ where: { id: invite.invitedById }, select: { role: true } })
      : null;
    if (inviter?.role !== "admin") {
      throw new RegistrationError(
        "invite_required",
        403,
        "This team invite cannot create an account. Ask an instance admin for an invite.",
      );
    }
  }
  return invite;
}

// Everything the client needs about who is signed in and where they can work.
// hasPassword lets settings offer "set a password" to provider-only accounts;
// the hash itself never leaves the server.
export async function session(userId: string) {
  const found = await prisma.user.findUnique({ where: { id: userId }, select: { ...publicUser, passwordHash: true } });
  if (!found) {
    throw new HttpError(401, "Not authenticated");
  }
  const { passwordHash, ...user } = found;
  return { user: { ...user, hasPassword: passwordHash !== null }, workspaces: await workspacesFor(userId) };
}

export function assertPasswordLogin() {
  if (env.PASSWORD_LOGIN === "disabled") {
    throw new HttpError(403, "Password sign-in is disabled on this Sentryward instance");
  }
}

// The one way an account is created, by password or through a sign-in
// provider, so REGISTRATION_MODE, invites and the first-admin bootstrap apply
// the same to both. The first account on an empty install bootstraps it as
// admin; two people registering at that same instant would both become admin,
// which is harmless. The invite is spent in the same transaction, so only if
// the user is created. `afterCreate` runs in that transaction too (linking a
// provider identity), so a failure leaves no half-made account.
export async function createAccount(
  input: { name: string; email: string; passwordHash: string | null; inviteToken?: string },
  afterCreate?: (tx: Prisma.TransactionClient, userId: string) => Promise<void>,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const firstUser = (await tx.user.count()) === 0;
      const invite = firstUser ? null : await admitRegistration(tx, input.email, input.inviteToken);
      const created = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash: input.passwordHash,
          role: firstUser ? "admin" : "member",
        },
        select: { ...publicUser, sessionVersion: true },
      });
      await createPersonalWorkspace(tx, created);
      if (invite?.workspaceId) {
        await joinWorkspace(tx, invite, created.id);
      } else if (invite) {
        await consumeInvite(tx, invite);
      }
      await afterCreate?.(tx, created.id);
      return created;
    });
  } catch (error) {
    // Another registration claimed the email between the check and the create.
    if (isUniqueViolation(error)) {
      throw emailTaken();
    }
    throw error;
  }
}

export async function register(req: Request, res: Response) {
  assertPasswordLogin();
  const { name, email, password, inviteToken } = registerSchema.parse(req.body);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Deliberate trade-off: this 409 is the one remaining place that confirms an
    // email has an account (login and password reset answer the same either way).
    // We keep it because a clear "already registered" message is much better UX
    // on signup, and authLimiter caps probing to a handful of attempts per IP.
    throw emailTaken();
  }

  const user = await createAccount({ name, email, passwordHash: await hashPassword(password), inviteToken });
  setAuthCookie(res, user);
  res.status(201).json(await session(user.id));
}

export async function login(req: Request, res: Response) {
  assertPasswordLogin();
  const { email, password } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email } });
  // Exactly one argon2 verify runs whether or not the email has an account or
  // a password (provider-only accounts have none), so response time cannot be
  // used to enumerate accounts or tell how they sign in.
  const passwordOk = await verifyPassword(user?.passwordHash ?? (await dummyPasswordHash()), password);
  if (!user || !passwordOk) {
    throw new HttpError(401, "Invalid email or password");
  }

  setAuthCookie(res, user);
  res.json(await session(user.id));
}

export function clearAuthCookie(res: Response) {
  const { maxAge: _maxAge, ...clearOptions } = authCookieOptions;
  res.clearCookie(AUTH_COOKIE, clearOptions);
}

export function logout(_req: Request, res: Response) {
  clearAuthCookie(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response) {
  res.json(await session(req.userId!));
}

// Lets the register page say up front whether it can be used, and the forgot
// password page whether a reset can be emailed or needs an admin.
export async function registration(_req: Request, res: Response) {
  const firstUser = (await prisma.user.count()) === 0;
  res.json({
    mode: env.REGISTRATION_MODE,
    firstUser,
    mailConfigured: mailer.configured(),
    passwordLogin: env.PASSWORD_LOGIN === "enabled",
    providers: configuredSignInProviders(),
  });
}

// Always the same answer, so the endpoint cannot be used to find out which
// emails have accounts. Not awaited: the lookup and any database writes would
// otherwise make known addresses answer measurably slower.
export async function postPasswordResetRequest(req: Request, res: Response) {
  assertPasswordLogin();
  const { email } = passwordResetRequestSchema.parse(req.body);
  void requestPasswordReset(email);
  res.status(202).json({});
}

// Lets the reset page show an expired link up front instead of after the form.
export async function showPasswordReset(req: Request, res: Response) {
  assertPasswordLogin();
  const { token } = resetTokenParamsSchema.parse(req.params);
  const reset = await findValidReset(token);
  if (!reset) {
    throw new HttpError(404, "This reset link is invalid or has expired");
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: reset.userId }, select: { email: true } });
  res.json({ email: user.email });
}

// Signs the user in with a cookie on the new session version; every other
// session, including one this browser may already hold, has ended.
export async function postPasswordReset(req: Request, res: Response) {
  assertPasswordLogin();
  const { token } = resetTokenParamsSchema.parse(req.params);
  const { password } = passwordResetSchema.parse(req.body);
  const user = await completePasswordReset(token, password);
  setAuthCookie(res, user);
  res.json(await session(user.id));
}

export async function showInvite(req: Request, res: Response) {
  const { token } = inviteTokenParamsSchema.parse(req.params);
  const valid = await findValidInvite(token);
  if (!valid) {
    throw new HttpError(404, "This invite is invalid or has expired");
  }
  const invite = await prisma.invite.findUniqueOrThrow({
    where: { id: valid.id },
    select: {
      email: true,
      role: true,
      expiresAt: true,
      invitedBy: { select: { name: true } },
      workspace: { select: { name: true } },
    },
  });
  res.json({ invite });
}

// A signed-in user joining a workspace from an invite link.
export async function acceptInvite(req: Request, res: Response) {
  const { token } = inviteTokenParamsSchema.parse(req.params);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true } });
  if (!user) {
    throw new HttpError(401, "Not authenticated");
  }
  const workspaceId = await prisma.$transaction(async (tx) => {
    const invite = await findValidInvite(token, tx);
    if (!invite) {
      throw new HttpError(404, "This invite is invalid or has expired");
    }
    assertInviteEmail(invite, user.email);
    await joinWorkspace(tx, invite, req.userId!);
    return invite.workspaceId!;
  });
  const workspace = (await workspacesFor(req.userId!)).find((w) => w.id === workspaceId);
  res.status(201).json({ workspace });
}
