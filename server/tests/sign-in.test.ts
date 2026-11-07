import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import { AUTH_COOKIE } from "../src/lib/jwt.ts";
import { hashPassword } from "../src/lib/password.ts";
import { prisma } from "../src/lib/prisma.ts";
import { createInvite } from "../src/services/invites.ts";
import { fetchStub, type StubRoute } from "./helpers/fetchStub.ts";
import { createUser } from "./helpers/users.ts";

// Both providers come from vitest.config.ts: GitHub on github.com, GitLab on
// a self-managed gitlab.acme.com. Every provider call is stubbed.

const NONCE_COOKIE = "sentryward_oauth";

function cookiesOf(res: request.Response): string[] {
  return ([] as string[]).concat(res.headers["set-cookie"] ?? []);
}

function cookieValue(res: request.Response, name: string): string | undefined {
  return cookiesOf(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0];
}

async function start(provider: string, query = "", cookie?: string) {
  const req = request(app).get(`/api/auth/oauth/${provider}/start${query}`);
  if (cookie) req.set("Cookie", cookie);
  const res = await req;
  const location = res.status === 302 ? new URL(res.headers.location!) : null;
  return {
    res,
    location,
    state: location?.searchParams.get("state") ?? "",
    nonce: cookieValue(res, NONCE_COOKIE) ?? "",
  };
}

function callback(provider: string, query: Record<string, string>, cookies: string[]) {
  return request(app)
    .get(`/api/auth/oauth/${provider}/callback?${new URLSearchParams(query)}`)
    .set("Cookie", cookies.filter(Boolean).join("; "));
}

const githubRoutes = (
  { id = 42, email = "octo@example.com", verified = true }: { id?: number; email?: string; verified?: boolean } = {},
): StubRoute[] => [
  { method: "POST", url: /^https:\/\/github\.com\/login\/oauth\/access_token$/, body: { access_token: "gh-token" } },
  { url: /^https:\/\/api\.github\.com\/user$/, body: { id, login: "octo", name: "Octo Cat" } },
  {
    url: /^https:\/\/api\.github\.com\/user\/emails$/,
    body: [
      { email: "secondary@example.com", primary: false, verified: true },
      { email, primary: true, verified },
    ],
  },
];

const gitlabRoutes = (
  { id = 7, email = "tanuki@example.com", confirmed = true }: { id?: number; email?: string; confirmed?: boolean } = {},
): StubRoute[] => [
  { method: "POST", url: /^https:\/\/gitlab\.acme\.com\/oauth\/token$/, body: { access_token: "gl-token" } },
  {
    url: /^https:\/\/gitlab\.acme\.com\/api\/v4\/user$/,
    body: { id, username: "tanuki", name: "Tanu Ki", email, confirmed_at: confirmed ? "2026-01-01T00:00:00Z" : null },
  },
];

// A whole login round trip: start, then come back from the provider.
async function signIn(provider: "github" | "gitlab", routes: StubRoute[], query = "") {
  const started = await start(provider, query);
  const { fetch, calls } = fetchStub(routes);
  vi.stubGlobal("fetch", fetch);
  const res = await callback(provider, { state: started.state, code: "the-code" }, [started.nonce]);
  return { res, calls, started };
}

const loginError = (code: string) => `${env.CLIENT_ORIGIN}/login?error=${code}`;

const originalMode = env.REGISTRATION_MODE;

beforeEach(async () => {
  await prisma.signInState.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
});

afterEach(() => {
  vi.unstubAllGlobals();
  env.REGISTRATION_MODE = originalMode;
  env.PASSWORD_LOGIN = "enabled";
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/auth/oauth/:provider/start", () => {
  it("redirects to GitHub with identity scopes, PKCE and a browser-bound state", async () => {
    const { res, location, state, nonce } = await start("github");

    expect(res.status).toBe(302);
    expect(location!.origin + location!.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(location!.searchParams)).toMatchObject({
      client_id: "github-login-id",
      redirect_uri: `${env.CLIENT_ORIGIN}/api/auth/oauth/github/callback`,
      scope: "read:user user:email",
      code_challenge_method: "S256",
    });
    expect(location!.searchParams.get("code_challenge")).toBeTruthy();
    expect(nonce).toMatch(new RegExp(`^${NONCE_COOKIE}=.+`));
    expect(cookiesOf(res).find((c) => c.startsWith(NONCE_COOKIE))).toMatch(/HttpOnly/i);
    expect(await prisma.signInState.findUniqueOrThrow({ where: { id: state } })).toMatchObject({
      provider: "github",
      intent: "login",
      userId: null,
    });
  });

  it("uses the self-managed GitLab host and read_user scope", async () => {
    const { location } = await start("gitlab");

    expect(location!.origin + location!.pathname).toBe("https://gitlab.acme.com/oauth/authorize");
    expect(location!.searchParams.get("scope")).toBe("read_user");
    expect(location!.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("carries an invite token through the round trip", async () => {
    const { state } = await start("github", "?invite=tok123");

    expect((await prisma.signInState.findUniqueOrThrow({ where: { id: state } })).inviteToken).toBe("tok123");
  });

  it("404s for an unknown or unconfigured provider", async () => {
    expect((await start("bitbucket")).res.status).toBe(404);

    const clientId = env.GITLAB_LOGIN_CLIENT_ID;
    env.GITLAB_LOGIN_CLIENT_ID = undefined;
    try {
      expect((await start("gitlab")).res.status).toBe(404);
    } finally {
      env.GITLAB_LOGIN_CLIENT_ID = clientId;
    }
    expect(await prisma.signInState.count()).toBe(0);
  });

  it("needs a session to link", async () => {
    expect((await start("github", "?intent=link")).res.status).toBe(401);
    expect(await prisma.signInState.count()).toBe(0);
  });
});

describe("GET /api/auth/oauth/:provider/callback (sign in and sign up)", () => {
  it("creates a passwordless account and signs it in", async () => {
    await createUser("someone@example.com");

    const { res, calls } = await signIn("github", githubRoutes());

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/home`);
    expect(cookieValue(res, AUTH_COOKIE)).toBeDefined();
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: "octo@example.com" },
      include: { identities: true, personalWorkspace: true },
    });
    expect(user).toMatchObject({ name: "Octo Cat", passwordHash: null, role: "member" });
    expect(user.personalWorkspace).not.toBeNull();
    expect(user.identities).toEqual([
      expect.objectContaining({ provider: "github", host: "github.com", providerUserId: "42", email: "octo@example.com" }),
    ]);

    // The code exchange carries the PKCE verifier and the same redirect URI.
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      client_id: "github-login-id",
      client_secret: "github-login-secret",
      code: "the-code",
      redirect_uri: `${env.CLIENT_ORIGIN}/api/auth/oauth/github/callback`,
      code_verifier: expect.any(String),
    });
    expect(calls[1]!.headers.authorization).toBe("Bearer gh-token");
    // Nothing forge-related is created by signing in.
    expect(await prisma.forgeConnection.count()).toBe(0);
  });

  it("makes the first account on an empty install an admin", async () => {
    env.REGISTRATION_MODE = "closed";

    const { res } = await signIn("gitlab", gitlabRoutes());

    expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/home`);
    expect(await prisma.user.findUniqueOrThrow({ where: { email: "tanuki@example.com" } })).toMatchObject({
      role: "admin",
      passwordHash: null,
    });
  });

  it("calls only the self-managed GitLab host and exchanges with PKCE", async () => {
    const { calls } = await signIn("gitlab", gitlabRoutes());

    expect(calls.map((call) => new URL(call.url).host)).toEqual(["gitlab.acme.com", "gitlab.acme.com"]);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toMatchObject({
      grant_type: "authorization_code",
      client_id: "gitlab-login-id",
      client_secret: "gitlab-login-secret",
      code: "the-code",
      code_verifier: expect.any(String),
    });
  });

  it("signs an already linked identity in to its account", async () => {
    const { user } = await createUser("dev@example.com");
    await prisma.userIdentity.create({
      data: { userId: user.id, provider: "github", host: "github.com", providerUserId: "42", email: "dev@example.com" },
    });

    // The provider email no longer matches; the identity is what counts.
    const { res } = await signIn("github", githubRoutes({ email: "changed@example.com" }));

    expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/home`);
    const me = await request(app).get("/api/auth/me").set("Cookie", cookieValue(res, AUTH_COOKIE)!);
    expect(me.body.user.id).toBe(user.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it("never links to an existing account by matching email", async () => {
    const { user } = await createUser("octo@example.com");

    const { res } = await signIn("github", githubRoutes());

    expect(res.headers.location).toBe(loginError("email_registered"));
    expect(cookieValue(res, AUTH_COOKIE)).toBeUndefined();
    expect(await prisma.userIdentity.count({ where: { userId: user.id } })).toBe(0);
  });

  it("matches identities by host, not just provider and id", async () => {
    const { user } = await createUser("dev@example.com");
    await prisma.userIdentity.create({
      data: { userId: user.id, provider: "gitlab", host: "gitlab.com", providerUserId: "7", email: "dev@example.com" },
    });

    const { res } = await signIn("gitlab", gitlabRoutes());

    // Same numeric id on another GitLab is another person: a new account.
    expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/home`);
    expect(await prisma.user.count()).toBe(2);
  });

  describe("registration mode", () => {
    beforeEach(async () => {
      await createUser("admin@example.com", "admin");
    });

    async function inviteToken(email: string) {
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@example.com" } });
      const { link } = await createInvite({ email, invitedById: admin.id, inviterName: admin.name });
      return link.split("/invite/")[1]!;
    }

    it("refuses sign-up when registration is closed", async () => {
      env.REGISTRATION_MODE = "closed";

      const { res } = await signIn("github", githubRoutes());

      expect(res.headers.location).toBe(loginError("registration_closed"));
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.userIdentity.count()).toBe(0);
    });

    it("requires an invite in invite mode", async () => {
      env.REGISTRATION_MODE = "invite";

      const { res } = await signIn("github", githubRoutes());

      expect(res.headers.location).toBe(loginError("invite_required"));
    });

    it("admits and spends a valid invite in invite mode", async () => {
      env.REGISTRATION_MODE = "invite";
      const token = await inviteToken("octo@example.com");

      const { res } = await signIn("github", githubRoutes(), `?invite=${token}`);

      expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/home`);
      expect(await prisma.invite.findFirstOrThrow()).toMatchObject({ acceptedAt: expect.any(Date) });
    });

    it("rejects an invite for another address", async () => {
      env.REGISTRATION_MODE = "invite";
      const token = await inviteToken("someone-else@example.com");

      const { res } = await signIn("github", githubRoutes(), `?invite=${token}`);

      expect(res.headers.location).toBe(loginError("invite_invalid"));
      expect(await prisma.invite.findFirstOrThrow()).toMatchObject({ acceptedAt: null });
    });
  });

  it("rejects a GitHub account without a verified primary email", async () => {
    const { res } = await signIn("github", githubRoutes({ verified: false }));

    expect(res.headers.location).toBe(loginError("email_unverified"));
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects a GitLab account whose email is unconfirmed", async () => {
    const { res } = await signIn("gitlab", gitlabRoutes({ confirmed: false }));

    expect(res.headers.location).toBe(loginError("email_unverified"));
  });

  it("reports a refused code exchange as a failure", async () => {
    const { res } = await signIn("gitlab", [
      { method: "POST", url: /gitlab\.acme\.com\/oauth\/token$/, status: 400, body: { error: "invalid_grant" } },
    ]);

    expect(res.headers.location).toBe(loginError("oauth_failed"));
  });

  it("reports a denied authorization and spends the state", async () => {
    const { state, nonce } = await start("github");

    const res = await callback("github", { state, error: "access_denied" }, [nonce]);

    expect(res.headers.location).toBe(loginError("oauth_denied"));
    expect(await prisma.signInState.count()).toBe(0);
  });

  describe("state", () => {
    it("rejects a missing or forged state", async () => {
      const { nonce } = await start("github");

      expect((await callback("github", { code: "c" }, [nonce])).headers.location).toBe(loginError("oauth_failed"));
      expect((await callback("github", { state: "forged", code: "c" }, [nonce])).headers.location).toBe(
        loginError("oauth_failed"),
      );
    });

    it("works once", async () => {
      const { state, nonce } = await start("github");
      vi.stubGlobal("fetch", fetchStub(githubRoutes()).fetch);

      const first = await callback("github", { state, code: "c" }, [nonce]);
      const second = await callback("github", { state, code: "c" }, [nonce]);

      expect(first.headers.location).toBe(`${env.CLIENT_ORIGIN}/home`);
      expect(second.headers.location).toBe(loginError("oauth_failed"));
    });

    it("expires", async () => {
      const { state, nonce } = await start("github");
      await prisma.signInState.update({ where: { id: state }, data: { expiresAt: new Date(Date.now() - 1000) } });

      const res = await callback("github", { state, code: "c" }, [nonce]);

      expect(res.headers.location).toBe(loginError("oauth_failed"));
    });

    it("belongs to one provider", async () => {
      const { state, nonce } = await start("github");

      const res = await callback("gitlab", { state, code: "c" }, [nonce]);

      expect(res.headers.location).toBe(loginError("oauth_failed"));
    });

    it("only completes in the browser that started it", async () => {
      const { state } = await start("github");
      const attacker = await start("github");

      // Without the nonce cookie, or with another flow's, the state is refused.
      expect((await callback("github", { state, code: "c" }, [])).headers.location).toBe(loginError("oauth_failed"));
      expect((await callback("github", { state, code: "c" }, [attacker.nonce])).headers.location).toBe(
        loginError("oauth_failed"),
      );
      expect(await prisma.user.count()).toBe(0);
    });
  });
});

describe("linking from settings", () => {
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    ({ cookie, user: { id: userId } } = await createUser("dev@example.com"));
  });

  async function link(routes: StubRoute[], as = cookie) {
    const started = await start("github", "?intent=link", as);
    vi.stubGlobal("fetch", fetchStub(routes).fetch);
    return callback("github", { state: started.state, code: "c" }, [started.nonce, as]);
  }

  it("links the provider to the signed-in account, whatever its email", async () => {
    const res = await link(githubRoutes({ email: "other@example.com" }));

    expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/settings?tab=sign-in&linked=github`);
    expect(await prisma.userIdentity.findFirstOrThrow()).toMatchObject({ userId, providerUserId: "42" });
  });

  it("refuses an identity linked to someone else", async () => {
    const other = await createUser("other@example.com");
    await prisma.userIdentity.create({
      data: { userId: other.user.id, provider: "github", host: "github.com", providerUserId: "42", email: "o@example.com" },
    });

    const res = await link(githubRoutes());

    expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/settings?tab=sign-in&error=identity_in_use`);
    expect(await prisma.userIdentity.count({ where: { userId } })).toBe(0);
  });

  it("must finish in the session that started it", async () => {
    const started = await start("github", "?intent=link", cookie);
    const other = await createUser("other@example.com");
    vi.stubGlobal("fetch", fetchStub(githubRoutes()).fetch);

    const res = await callback("github", { state: started.state, code: "c" }, [started.nonce, other.cookie]);

    expect(res.headers.location).toBe(`${env.CLIENT_ORIGIN}/settings?tab=sign-in&error=oauth_failed`);
    expect(await prisma.userIdentity.count()).toBe(0);
  });
});

describe("/api/settings/identities", () => {
  let cookie: string;
  let userId: string;

  beforeEach(async () => {
    ({ cookie, user: { id: userId } } = await createUser("dev@example.com"));
  });

  const identity = (provider: "github" | "gitlab", providerUserId = "1") =>
    prisma.userIdentity.create({
      data: { userId, provider, host: `${provider}.com`, providerUserId, email: "dev@example.com" },
    });

  it("lists the user's identities only", async () => {
    await identity("github");
    const other = await createUser("other@example.com");
    await prisma.userIdentity.create({
      data: { userId: other.user.id, provider: "gitlab", host: "gitlab.com", providerUserId: "9", email: "o@example.com" },
    });

    const res = await request(app).get("/api/settings/identities").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.identities).toEqual([
      expect.objectContaining({ provider: "github", host: "github.com", email: "dev@example.com" }),
    ]);
  });

  it("unlinks an identity while a password remains", async () => {
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword("pw-123456") } });
    const linked = await identity("github");

    const res = await request(app).delete(`/api/settings/identities/${linked.id}`).set("Cookie", cookie);

    expect(res.status).toBe(204);
    expect(await prisma.userIdentity.count()).toBe(0);
  });

  it("unlinks one identity while another remains", async () => {
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: null } });
    const linked = await identity("github");
    await identity("gitlab");

    const res = await request(app).delete(`/api/settings/identities/${linked.id}`).set("Cookie", cookie);

    expect(res.status).toBe(204);
  });

  it("refuses to remove the last sign-in method", async () => {
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: null } });
    const linked = await identity("github");

    const res = await request(app).delete(`/api/settings/identities/${linked.id}`).set("Cookie", cookie);

    expect(res.status).toBe(409);
    expect(await prisma.userIdentity.count()).toBe(1);
  });

  it("does not count a password while password login is disabled", async () => {
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword("pw-123456") } });
    const linked = await identity("github");
    env.PASSWORD_LOGIN = "disabled";

    const res = await request(app).delete(`/api/settings/identities/${linked.id}`).set("Cookie", cookie);

    expect(res.status).toBe(409);
  });

  it("404s for someone else's identity", async () => {
    const other = await createUser("other@example.com");
    const theirs = await prisma.userIdentity.create({
      data: { userId: other.user.id, provider: "github", host: "github.com", providerUserId: "9", email: "o@example.com" },
    });

    const res = await request(app).delete(`/api/settings/identities/${theirs.id}`).set("Cookie", cookie);

    expect(res.status).toBe(404);
    expect(await prisma.userIdentity.count()).toBe(1);
  });
});
