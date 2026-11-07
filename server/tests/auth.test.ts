import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import { prisma } from "../src/lib/prisma.ts";
import { AUTH_COOKIE } from "../src/lib/jwt.ts";
import { createInvite } from "../src/services/invites.ts";
import { createUser } from "./helpers/users.ts";

// Keep the real argon2 implementation, but wrap verifyPassword so the login
// timing tests can count how many verifications an unknown-email request runs.
vi.mock("../src/lib/password.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/password.ts")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const validUser = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  password: "supersecret123",
  confirmPassword: "supersecret123",
};

function authCookie(res: request.Response) {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  return cookies.find((c) => c.startsWith(`${AUTH_COOKIE}=`));
}

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/auth/register", () => {
  it("creates a user, sets an httpOnly cookie and never returns the hash", async () => {
    const res = await request(app).post("/api/auth/register").send(validUser);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: validUser.name, email: validUser.email });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(authCookie(res)).toMatch(/HttpOnly/i);

    const stored = await prisma.user.findUniqueOrThrow({ where: { email: validUser.email } });
    expect(stored.passwordHash).not.toBe(validUser.password);
  });

  it("rejects a duplicate email case-insensitively", async () => {
    await request(app).post("/api/auth/register").send(validUser);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, email: "ADA@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.errors).toEqual({ email: ["An account with this email already exists"] });
  });

  it("returns 409 when a concurrent registration claims the same email", async () => {
    const [a, b] = await Promise.all([
      request(app).post("/api/auth/register").send(validUser),
      request(app).post("/api/auth/register").send(validUser),
    ]);

    // Both requests pass the up-front email check, so exactly one wins the
    // unique index; the loser must be a 409, not a 500.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(a.body.user?.email ?? b.body.user?.email).toBe(validUser.email);
    // Same field error as the up-front check, so the form shows it on the email field.
    const loser = a.status === 409 ? a : b;
    expect(loser.body.errors).toEqual({ email: ["An account with this email already exists"] });
  });

  it("returns field errors for invalid input", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "", email: "nope", password: "short", confirmPassword: "different" });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.errors)).toEqual(
      expect.arrayContaining(["name", "email", "password"]),
    );
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await request(app).post("/api/auth/register").send(validUser);
  });

  it("logs in with correct credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: validUser.email, password: validUser.password });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(validUser.email);
    expect(authCookie(res)).toBeDefined();
  });

  it("rejects a wrong password with a generic message", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: validUser.email, password: "wrongpassword" });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password");
  });

  it("rejects an unknown email with the same generic message", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "whatever123" });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password");
  });

  it("runs exactly one password verification when the email is unknown", async () => {
    const password = await import("../src/lib/password.ts");
    const verify = vi.mocked(password.verifyPassword);
    verify.mockResolvedValue(false);

    try {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "nobody@example.com", password: "whatever123" });

      expect(res.status).toBe(401);
      // The unknown-email path must not skip the argon2 work, or the response
      // time would reveal whether the email has an account.
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
    }
  });

  it("answers a provider-only account like a wrong password, after one verification", async () => {
    await prisma.user.create({ data: { name: "Linus", email: "linus@example.com", passwordHash: null } });
    const password = await import("../src/lib/password.ts");
    const verify = vi.mocked(password.verifyPassword);
    verify.mockClear();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "linus@example.com", password: "whatever123" });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password");
    // Same argon2 work as any other refusal, so timing cannot reveal how the
    // account signs in.
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("verifies the stored hash once for a wrong password", async () => {
    const password = await import("../src/lib/password.ts");
    const verify = vi.mocked(password.verifyPassword);
    verify.mockResolvedValue(false);

    try {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: validUser.email, password: "wrongpassword" });

      expect(res.status).toBe(401);
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
    }
  });

  it("checks unknown emails against a stable dummy hash made like real ones", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/password.ts")>("../src/lib/password.ts");
    const dummy = await actual.dummyPasswordHash();

    expect(await actual.dummyPasswordHash()).toBe(dummy);
    expect(await actual.verifyPassword(dummy, "whatever123")).toBe(false);
    // Same algorithm and cost parameters as hashPassword, so verifying it takes
    // as long as verifying a real account's hash.
    const params = (hash: string) => hash.split("$").slice(1, 4).join("$");
    expect(params(dummy)).toBe(params(await actual.hashPassword("x")));
  });
});

describe("GET /api/auth/me and POST /api/auth/logout", () => {
  it("returns 401 without a cookie", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns the current user with a valid cookie, and logout clears it", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send(validUser);

    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(validUser.email);

    const logoutRes = await agent.post("/api/auth/logout");
    expect(logoutRes.status).toBe(204);

    const afterLogout = await agent.get("/api/auth/me");
    expect(afterLogout.status).toBe(401);
  });

  it("rejects a tampered token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Cookie", `${AUTH_COOKIE}=not.a.valid.token`);
    expect(res.status).toBe(401);
  });
});

describe("registration modes and invites", () => {
  const originalMode = env.REGISTRATION_MODE;

  beforeEach(async () => {
    await prisma.invite.deleteMany();
  });

  afterEach(() => {
    env.REGISTRATION_MODE = originalMode;
  });

  async function inviteToken(email?: string) {
    const { user } = await createUser("admin@example.com", "admin");
    const { link } = await createInvite({ email, invitedById: user.id, inviterName: user.name });
    return link.split("/invite/")[1]!;
  }

  it("makes the first account an admin, even when registration is closed", async () => {
    env.REGISTRATION_MODE = "closed";

    const res = await request(app).post("/api/auth/register").send(validUser);

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("admin");
  });

  it("makes later accounts members in open mode", async () => {
    await createUser("admin@example.com", "admin");

    const res = await request(app).post("/api/auth/register").send(validUser);

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("member");
  });

  it("refuses new accounts when registration is closed", async () => {
    env.REGISTRATION_MODE = "closed";
    await createUser("admin@example.com", "admin");

    const res = await request(app).post("/api/auth/register").send(validUser);

    expect(res.status).toBe(403);
    expect(await prisma.user.count({ where: { email: validUser.email } })).toBe(0);
  });

  it("requires a valid invite in invite mode, and spends it once", async () => {
    env.REGISTRATION_MODE = "invite";
    const token = await inviteToken();

    const without = await request(app).post("/api/auth/register").send(validUser);
    expect(without.status).toBe(403);

    const bogus = await request(app).post("/api/auth/register").send({ ...validUser, inviteToken: "nope" });
    expect(bogus.status).toBe(400);

    const ok = await request(app).post("/api/auth/register").send({ ...validUser, inviteToken: token });
    expect(ok.status).toBe(201);

    const reused = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, email: "grace@example.com", inviteToken: token });
    expect(reused.status).toBe(400);
  });

  it("rejects an invite meant for another email without spending it", async () => {
    env.REGISTRATION_MODE = "invite";
    const token = await inviteToken("grace@example.com");

    const res = await request(app).post("/api/auth/register").send({ ...validUser, inviteToken: token });

    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeDefined();
    expect(await prisma.invite.count({ where: { acceptedAt: null } })).toBe(1);
  });

  it("rejects an expired invite", async () => {
    env.REGISTRATION_MODE = "invite";
    const token = await inviteToken();
    await prisma.invite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post("/api/auth/register").send({ ...validUser, inviteToken: token });

    expect(res.status).toBe(400);
  });

  it("reports the mode and shows a valid invite", async () => {
    env.REGISTRATION_MODE = "invite";
    const token = await inviteToken("grace@example.com");

    const mode = await request(app).get("/api/auth/registration");
    expect(mode.body).toEqual({
      mode: "invite",
      firstUser: false,
      mailConfigured: false,
      passwordLogin: true,
      // From vitest.config.ts: both sign-in providers are configured.
      providers: [
        { id: "github", host: "github.com" },
        { id: "gitlab", host: "gitlab.acme.com" },
      ],
    });

    const shown = await request(app).get(`/api/auth/invites/${token}`);
    expect(shown.status).toBe(200);
    expect(shown.body.invite).toMatchObject({ email: "grace@example.com", invitedBy: { name: "Dev" } });

    const missing = await request(app).get("/api/auth/invites/unknown");
    expect(missing.status).toBe(404);
  });
});

describe("PASSWORD_LOGIN=disabled", () => {
  afterEach(() => {
    env.PASSWORD_LOGIN = "enabled";
  });

  it("refuses password sign-in, sign-up and resets", async () => {
    await request(app).post("/api/auth/register").send(validUser);
    env.PASSWORD_LOGIN = "disabled";

    const login = await request(app).post("/api/auth/login").send({ email: validUser.email, password: validUser.password });
    const register = await request(app)
      .post("/api/auth/register")
      .send({ ...validUser, email: "other@example.com" });
    const reset = await request(app).post("/api/auth/password-reset").send({ email: validUser.email });

    expect([login.status, register.status, reset.status]).toEqual([403, 403, 403]);
    expect(authCookie(login)).toBeUndefined();
    const mode = await request(app).get("/api/auth/registration");
    expect(mode.body.passwordLogin).toBe(false);
  });
});
