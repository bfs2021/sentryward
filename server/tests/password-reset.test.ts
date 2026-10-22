import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { app } from "../src/app.ts";
import { env } from "../src/config/env.ts";
import { AUTH_COOKIE } from "../src/lib/jwt.ts";
import { mailer } from "../src/lib/mailer.ts";
import { hashPassword } from "../src/lib/password.ts";
import { prisma } from "../src/lib/prisma.ts";
import { hashToken } from "../src/lib/tokens.ts";
import {
  ADMIN_RESET_TTL_MS,
  createPasswordReset,
  EMAILED_RESET_COOLDOWN_MS,
  requestPasswordReset,
} from "../src/services/passwordResets.ts";
import { createUser } from "./helpers/users.ts";

const NEW_PASSWORD = { password: "brand-new-pass", confirmPassword: "brand-new-pass" };

let user: Awaited<ReturnType<typeof createUser>>;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  user = await createUser("ada@example.com");
  await prisma.user.update({ where: { id: user.user.id }, data: { passwordHash: await hashPassword("old-password") } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function tokenOf(link: string): string {
  return link.split("/").pop()!;
}

function authCookie(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  return cookies.find((c) => c.startsWith(`${AUTH_COOKIE}=`))!.split(";")[0]!;
}

async function requestReset(email: string) {
  return request(app).post("/api/auth/password-reset").send({ email });
}

describe("POST /api/auth/password-reset", () => {
  it("emails a single-use link for a known email and stores only its hash", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();

    const res = await requestReset("ADA@example.com");

    expect(res.status).toBe(202);
    // The request is handled after the response, so wait for it.
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const mail = send.mock.calls[0]![0];
    expect(mail.to).toBe("ada@example.com");
    const token = mail.text.match(/reset-password\/([\w-]+)/)![1]!;
    const stored = await prisma.passwordReset.findFirstOrThrow({ where: { userId: user.user.id } });
    expect(stored.tokenHash).toBe(hashToken(token));
    expect(stored.tokenHash).not.toContain(token);
    expect(stored.createdById).toBeNull();
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
  });

  it("answers an unknown email exactly as a known one, and sends nothing", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();

    const known = await requestReset("ada@example.com");
    const unknown = await requestReset("nobody@example.com");

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await requestPasswordReset("nobody@example.com");
    expect(send).toHaveBeenCalledOnce();
  });

  it("creates nothing and sends nothing when mail is not configured", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(false);
    const send = vi.spyOn(mailer, "send");

    expect((await requestReset("ada@example.com")).status).toBe(202);
    await requestPasswordReset("ada@example.com");

    expect(send).not.toHaveBeenCalled();
    expect(await prisma.passwordReset.count()).toBe(0);
  });

  it("still answers when the email fails to send, and logs instead of throwing", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    vi.spyOn(mailer, "send").mockRejectedValue(new Error("smtp down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await requestReset("ada@example.com")).status).toBe(202);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
  });

  it("sends at most one email per account within the cooldown", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();

    await requestPasswordReset("ada@example.com");
    await requestPasswordReset("ada@example.com");

    expect(send).toHaveBeenCalledOnce();
    const first = await prisma.passwordReset.findFirstOrThrow({ where: { userId: user.user.id } });

    // Once the cooldown has passed, a new link replaces the earlier one.
    await prisma.passwordReset.update({
      where: { id: first.id },
      data: { createdAt: new Date(Date.now() - EMAILED_RESET_COOLDOWN_MS - 1000) },
    });
    await requestPasswordReset("ada@example.com");

    expect(send).toHaveBeenCalledTimes(2);
    const remaining = await prisma.passwordReset.findMany({ where: { userId: user.user.id } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).not.toBe(first.id);
  });

  it("leaves an admin's link working when a reset is requested by email", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    vi.spyOn(mailer, "send").mockResolvedValue();
    const admin = await createUser("admin@example.com", "admin");
    const handedOver = await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS, createdById: admin.user.id });

    await requestPasswordReset("ada@example.com");

    expect(await prisma.passwordReset.count({ where: { userId: user.user.id } })).toBe(2);
    const res = await request(app).post(`/api/auth/password-reset/${tokenOf(handedOver.link)}`).send(NEW_PASSWORD);
    expect(res.status).toBe(200);
  });

  it("sweeps expired links when a new one is created", async () => {
    const other = await createUser("grace@example.com");
    await createPasswordReset(other.user.id, { ttlMs: ADMIN_RESET_TTL_MS });
    await prisma.passwordReset.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS });

    expect(await prisma.passwordReset.count({ where: { userId: other.user.id } })).toBe(0);
  });

  it("validates the email", async () => {
    const res = await requestReset("not-an-email");

    expect(res.status).toBe(400);
    expect(res.body.errors.email).toBeDefined();
  });

  it("reports whether mail is configured on the registration endpoint", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);

    const res = await request(app).get("/api/auth/registration");

    expect(res.body.mailConfigured).toBe(true);
  });
});

describe("completing a reset", () => {
  it("shows the account email for a valid link", async () => {
    const { link } = await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS });

    const res = await request(app).get(`/api/auth/password-reset/${tokenOf(link)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: "ada@example.com" });
  });

  it("changes the password, signs the user in and ends other sessions", async () => {
    const { link } = await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS });

    const res = await request(app).post(`/api/auth/password-reset/${tokenOf(link)}`).send(NEW_PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("ada@example.com");
    expect((await request(app).get("/api/auth/me").set("Cookie", authCookie(res))).status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", user.cookie)).status).toBe(401);

    const oldLogin = await request(app).post("/api/auth/login").send({ email: "ada@example.com", password: "old-password" });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post("/api/auth/login").send({ email: "ada@example.com", ...NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Cookie", authCookie(newLogin))).status).toBe(200);
  });

  it("works only once", async () => {
    const { link } = await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS });
    await request(app).post(`/api/auth/password-reset/${tokenOf(link)}`).send(NEW_PASSWORD);

    const again = await request(app)
      .post(`/api/auth/password-reset/${tokenOf(link)}`)
      .send({ password: "another-pass", confirmPassword: "another-pass" });

    expect(again.status).toBe(400);
    expect((await request(app).get(`/api/auth/password-reset/${tokenOf(link)}`)).status).toBe(404);
  });

  it("rejects an expired link", async () => {
    const { link } = await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS });
    await prisma.passwordReset.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await request(app).get(`/api/auth/password-reset/${tokenOf(link)}`)).status).toBe(404);
    const res = await request(app).post(`/api/auth/password-reset/${tokenOf(link)}`).send(NEW_PASSWORD);
    expect(res.status).toBe(400);
    expect((await request(app).get("/api/auth/me").set("Cookie", user.cookie)).status).toBe(200);
  });

  it("stops an older link working once a newer one is issued", async () => {
    const first = await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS });
    const second = await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS });

    expect((await request(app).post(`/api/auth/password-reset/${tokenOf(first.link)}`).send(NEW_PASSWORD)).status).toBe(400);
    expect((await request(app).post(`/api/auth/password-reset/${tokenOf(second.link)}`).send(NEW_PASSWORD)).status).toBe(200);
  });

  it("lets only one of two concurrent uses of a link win", async () => {
    const { link } = await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS });
    const url = `/api/auth/password-reset/${tokenOf(link)}`;

    const results = await Promise.all([
      request(app).post(url).send(NEW_PASSWORD),
      request(app).post(url).send({ password: "another-pass", confirmPassword: "another-pass" }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await prisma.passwordReset.count({ where: { usedAt: { not: null } } })).toBe(1);
    const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: user.user.id } });
    expect(sessionVersion).toBe(1);
  });

  it("rejects an unknown token and a weak or mismatched password", async () => {
    const { link } = await createPasswordReset(user.user.id, { ttlMs: ADMIN_RESET_TTL_MS });

    expect((await request(app).post("/api/auth/password-reset/nope").send(NEW_PASSWORD)).status).toBe(400);
    const weak = await request(app)
      .post(`/api/auth/password-reset/${tokenOf(link)}`)
      .send({ password: "short", confirmPassword: "different" });
    expect(weak.status).toBe(400);
    expect(weak.body.errors.password).toBeDefined();
    expect(weak.body.errors.confirmPassword).toBeDefined();
  });
});

describe("session versions", () => {
  it("still accepts a token issued before versions existed", async () => {
    const legacy = jwt.sign({ sub: user.user.id }, env.JWT_SECRET, { expiresIn: 60 });

    const res = await request(app).get("/api/auth/me").set("Cookie", `${AUTH_COOKIE}=${legacy}`);

    expect(res.status).toBe(200);
  });

  it("signs out a deleted user's session", async () => {
    await prisma.user.delete({ where: { id: user.user.id } });

    expect((await request(app).get("/api/auth/me").set("Cookie", user.cookie)).status).toBe(401);
  });
});
