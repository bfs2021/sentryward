import type { CookieOptions, Request, Response } from "express";
import { env } from "../config/env.ts";
import { decrypt, DecryptError, encrypt } from "../lib/crypto.ts";
import type { SignInProvider, SignInState } from "../generated/prisma/client.ts";
import { HttpError } from "../lib/httpError.ts";
import { assertSafeForgeHost } from "../lib/hostSafety.ts";
import { OAuthRequestError, pkcePair, randomState } from "../lib/oauth.ts";
import { prisma } from "../lib/prisma.ts";
import { hashToken } from "../lib/tokens.ts";
import { cookieUserId } from "../middleware/requireAuth.ts";
import { signInCallbackSchema, signInProviderParamsSchema, signInStartSchema } from "../schemas/auth.schema.ts";
import { identityParamsSchema } from "../schemas/settings.schema.ts";
import { hasOtherSignInMethod, signInProviderFor, signInRedirectUri } from "../services/signIn/index.ts";
import { type SignInProfile, UnverifiedEmailError } from "../services/signIn/types.ts";
import { isUniqueViolation } from "../services/users.ts";
import { createAccount, RegistrationError, setAuthCookie } from "./auth.controller.ts";

const SIGN_IN_STATE_TTL_MS = 10 * 60 * 1000;

// Holds a nonce whose hash is stored with the state. The callback only accepts
// a state from the browser that started it, so an attacker cannot send someone
// a callback URL that signs them in to the attacker's account (login CSRF).
// Lax, because the callback is a top-level navigation back from the provider.
const NONCE_COOKIE = "sentryward_oauth";
const nonceCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
  path: "/api/auth/oauth",
  maxAge: SIGN_IN_STATE_TTL_MS,
};

// What the login or settings page is told when a round trip does not end in a
// session. The client maps each to a message.
type SignInErrorCode =
  | "oauth_failed"
  | "oauth_denied"
  | "email_unverified"
  | "email_registered"
  | "identity_in_use"
  | "registration_closed"
  | "invite_required"
  | "invite_invalid";

function toClient(res: Response, path: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  res.redirect(`${env.CLIENT_ORIGIN}${path}${query ? `?${query}` : ""}`);
}

function fail(res: Response, intent: SignInState["intent"], error: SignInErrorCode) {
  if (intent === "link") {
    toClient(res, "/settings", { tab: "sign-in", error });
  } else {
    toClient(res, "/login", { error });
  }
}

export async function signInStart(req: Request, res: Response) {
  const { id, provider } = signInProviderFor(signInProviderParamsSchema.parse(req.params).provider);
  const { intent, invite, returnTo } = signInStartSchema.parse(req.query);
  // Linking needs the browser's own session, never an API token: the identity
  // becomes a way into this account.
  const userId = intent === "link" ? await cookieUserId(req) : null;
  if (intent === "link" && !userId) {
    throw new HttpError(401, "Not authenticated");
  }
  // The host comes from env, but a self-managed GitLab is still a server-side
  // call with credentials, so it gets the same check as a forge connection.
  await assertSafeForgeHost(provider.host());

  await prisma.signInState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const { verifier, challenge } = pkcePair();
  const nonce = randomState();
  const state = await prisma.signInState.create({
    data: {
      id: randomState(),
      provider: id,
      intent,
      userId,
      inviteToken: invite ? encrypt(invite) : null,
      // A link always returns to settings.
      returnTo: intent === "login" && returnTo ? encrypt(returnTo) : null,
      codeVerifier: verifier,
      browserNonceHash: hashToken(nonce),
      expiresAt: new Date(Date.now() + SIGN_IN_STATE_TTL_MS),
    },
  });
  res.cookie(NONCE_COOKIE, nonce, nonceCookieOptions);
  res.redirect(provider.authorizeUrl({ state: state.id, challenge, redirectUri: signInRedirectUri(id) }));
}

// Always a redirect back to the client, never JSON: the browser arrives here
// from the provider. The state is spent before anything else is checked, so a
// denied or failed round trip cannot be retried with the same state.
export async function signInCallback(req: Request, res: Response) {
  const { id, provider } = signInProviderFor(signInProviderParamsSchema.parse(req.params).provider);
  const query = signInCallbackSchema.safeParse(req.query);
  const nonce: unknown = req.cookies?.[NONCE_COOKIE];
  const { maxAge: _maxAge, ...clearOptions } = nonceCookieOptions;
  res.clearCookie(NONCE_COOKIE, clearOptions);

  const stateId = query.success ? query.data.state : undefined;
  const state =
    stateId && typeof nonce === "string"
      ? await prisma.signInState.findFirst({
          where: { id: stateId, provider: id, browserNonceHash: hashToken(nonce), expiresAt: { gt: new Date() } },
        })
      : null;
  const consumed = state ? await prisma.signInState.deleteMany({ where: { id: state.id } }) : null;
  if (!state || consumed?.count !== 1 || !query.success) {
    return fail(res, "login", "oauth_failed");
  }
  const { code, error } = query.data;
  if (error || !code) {
    return fail(res, state.intent, error === "access_denied" ? "oauth_denied" : "oauth_failed");
  }

  let profile: SignInProfile;
  try {
    const accessToken = await provider.exchangeCode({
      code,
      verifier: state.codeVerifier,
      redirectUri: signInRedirectUri(id),
    });
    profile = await provider.profile(accessToken);
  } catch (err) {
    if (err instanceof UnverifiedEmailError) {
      return fail(res, state.intent, "email_unverified");
    }
    if (err instanceof OAuthRequestError) {
      return fail(res, state.intent, "oauth_failed");
    }
    throw err;
  }

  const identityKey = { provider: id, host: provider.host(), providerUserId: profile.providerUserId };
  if (state.intent === "link") {
    return linkIdentity(req, res, state, identityKey, profile);
  }
  return signInOrSignUp(res, state, identityKey, profile);
}

type IdentityKey = { provider: SignInProvider; host: string; providerUserId: string };

async function signInOrSignUp(res: Response, state: SignInState, key: IdentityKey, profile: SignInProfile) {
  const identity = await prisma.userIdentity.findUnique({
    where: { provider_host_providerUserId: key },
    select: { user: { select: { id: true, sessionVersion: true } } },
  });
  let inviteToken: string | null;
  let returnTo: string | null;
  try {
    inviteToken = state.inviteToken ? decrypt(state.inviteToken) : null;
    returnTo = state.returnTo ? decrypt(state.returnTo) : null;
  } catch (err) {
    // Written under another ENCRYPTION_KEY: start over rather than sign in
    // without the invite or destination the user started with.
    if (err instanceof DecryptError) {
      return fail(res, "login", "oauth_failed");
    }
    throw err;
  }

  if (identity) {
    setAuthCookie(res, identity.user);
    return toClient(res, returnTo ?? "/home");
  }

  // Never linked by matching email: a provider address can be unverified on
  // some hosts, or reassigned, and linking on it would hand over the account.
  // The owner signs in their usual way and links from settings instead.
  const email = profile.email.toLowerCase();
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    return fail(res, "login", "email_registered");
  }

  let user;
  try {
    user = await createAccount(
      { name: profile.name.trim().slice(0, 100) || email, email, passwordHash: null, inviteToken: inviteToken ?? undefined },
      async (tx, userId) => {
        await tx.userIdentity.create({ data: { ...key, userId, email } });
      },
    );
  } catch (err) {
    if (err instanceof RegistrationError) {
      return fail(res, "login", err.reason);
    }
    // emailTaken (an account claimed the address meanwhile), or the invite was
    // spent by someone else since the lookup.
    if (err instanceof HttpError && err.status === 409) {
      return fail(res, "login", "email_registered");
    }
    if (err instanceof HttpError && err.status === 400) {
      return fail(res, "login", "invite_invalid");
    }
    throw err;
  }
  setAuthCookie(res, user);
  toClient(res, returnTo ?? "/home");
}

async function linkIdentity(req: Request, res: Response, state: SignInState, key: IdentityKey, profile: SignInProfile) {
  // The session that started the link must still be the one finishing it, so a
  // link cannot land on whoever is signed in by the time the provider returns.
  const userId = await cookieUserId(req);
  if (!userId || userId !== state.userId) {
    return fail(res, "link", "oauth_failed");
  }
  const existing = await prisma.userIdentity.findUnique({
    where: { provider_host_providerUserId: key },
    select: { userId: true },
  });
  if (existing && existing.userId !== userId) {
    return fail(res, "link", "identity_in_use");
  }
  if (!existing) {
    try {
      await prisma.userIdentity.create({ data: { ...key, userId, email: profile.email.toLowerCase() } });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return fail(res, "link", "identity_in_use");
      }
      throw err;
    }
  }
  toClient(res, "/settings", { tab: "sign-in", linked: key.provider });
}

export async function listIdentities(req: Request, res: Response) {
  const identities = await prisma.userIdentity.findMany({
    where: { userId: req.userId },
    select: { id: true, provider: true, host: true, email: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  res.json({ identities });
}

// Refuses to remove the last way in. The user row is locked so two unlinks at
// once cannot each see the other identity as the one that remains.
export async function unlinkIdentity(req: Request, res: Response) {
  const { id } = identityParamsSchema.parse(req.params);
  const userId = req.userId!;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user) {
      throw new HttpError(401, "Not authenticated");
    }
    const identity = await tx.userIdentity.findFirst({ where: { id, userId }, select: { id: true } });
    if (!identity) {
      throw new HttpError(404, "Sign-in method not found");
    }
    const others = await tx.userIdentity.count({ where: { userId, id: { not: id } } });
    if (!hasOtherSignInMethod(user, others)) {
      throw new HttpError(409, "You can't remove your last sign-in method");
    }
    await tx.userIdentity.delete({ where: { id } });
  });
  res.status(204).end();
}
