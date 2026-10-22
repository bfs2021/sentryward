import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.ts";
import { mailer } from "../src/lib/mailer.ts";
import { prisma } from "../src/lib/prisma.ts";
import { createUser } from "./helpers/users.ts";

let admin: Awaited<ReturnType<typeof createUser>>;
let member: Awaited<ReturnType<typeof createUser>>;

beforeEach(async () => {
  await prisma.invite.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  admin = await createUser("admin@example.com", "admin");
  member = await createUser("member@example.com");
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("access", () => {
  it.each([
    ["get", "/api/admin/users"],
    ["get", "/api/admin/invites"],
    ["post", "/api/admin/invites"],
    ["post", "/api/admin/users/00000000-0000-4000-8000-000000000000/password-reset"],
  ] as const)("%s %s is admin-only", async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
    expect((await request(app)[method](path).set("Cookie", member.cookie)).status).toBe(403);
    expect((await request(app)[method](path).set("Cookie", admin.cookie)).status).not.toBe(403);
  });

  it("applies a demotion on the next request without a new login", async () => {
    await createUser("other-admin@example.com", "admin");
    await prisma.user.update({ where: { id: admin.user.id }, data: { role: "member" } });

    const res = await request(app).get("/api/admin/users").set("Cookie", admin.cookie);

    expect(res.status).toBe(403);
  });
});

describe("users", () => {
  it("lists users with their role and no password hash", async () => {
    const res = await request(app).get("/api/admin/users").set("Cookie", admin.cookie);

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users[0]).toMatchObject({ email: "admin@example.com", role: "admin" });
    expect(res.body.users[0].passwordHash).toBeUndefined();
    expect(res.body).toMatchObject({ total: 2, page: 1, limit: 20 });
  });

  describe("listing", () => {
    beforeEach(async () => {
      await prisma.user.update({ where: { id: admin.user.id }, data: { name: "Ada Lovelace" } });
      await prisma.user.update({ where: { id: member.user.id }, data: { name: "Grace Hopper" } });
    });

    async function list(query: string) {
      const res = await request(app).get(`/api/admin/users?${query}`).set("Cookie", admin.cookie);
      expect(res.status).toBe(200);
      return res.body as { users: { email: string }[]; total: number };
    }

    it("filters by role", async () => {
      const body = await list("role=member");

      expect(body.total).toBe(1);
      expect(body.users.map((u) => u.email)).toEqual(["member@example.com"]);
    });

    it("searches name and email, ignoring case", async () => {
      expect((await list("q=GRACE")).users.map((u) => u.email)).toEqual(["member@example.com"]);
      expect((await list("q=admin@")).users.map((u) => u.email)).toEqual(["admin@example.com"]);
      expect((await list("q=nobody")).total).toBe(0);
    });

    it("sorts by a column", async () => {
      const body = await list("sort=name&dir=desc");

      expect(body.users.map((u) => u.email)).toEqual(["member@example.com", "admin@example.com"]);
    });

    it("paginates", async () => {
      const body = await list("sort=email&limit=1&page=2");

      expect(body.total).toBe(2);
      expect(body.users.map((u) => u.email)).toEqual(["member@example.com"]);
    });

    it("rejects sorting by a column it does not expose", async () => {
      const res = await request(app).get("/api/admin/users?sort=passwordHash").set("Cookie", admin.cookie);

      expect(res.status).toBe(400);
    });
  });

  it("promotes and demotes", async () => {
    const promoted = await request(app)
      .patch(`/api/admin/users/${member.user.id}`)
      .set("Cookie", admin.cookie)
      .send({ role: "admin" });
    expect(promoted.status).toBe(200);
    expect(promoted.body.user.role).toBe("admin");

    const demoted = await request(app)
      .patch(`/api/admin/users/${admin.user.id}`)
      .set("Cookie", admin.cookie)
      .send({ role: "member" });
    expect(demoted.status).toBe(200);
  });

  it("edits a user's name and email, lowercasing the email", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${member.user.id}`)
      .set("Cookie", admin.cookie)
      .send({ name: "Grace Hopper", email: "Grace@Example.com" });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: "Grace Hopper", email: "grace@example.com", role: "member" });
  });

  it("edits the only admin's name without tripping the last-admin guard", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${admin.user.id}`)
      .set("Cookie", admin.cookie)
      .send({ name: "Ada Lovelace" });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: "Ada Lovelace", role: "admin" });
  });

  it("refuses an email that belongs to someone else", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${member.user.id}`)
      .set("Cookie", admin.cookie)
      .send({ email: "admin@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.errors.email).toEqual(["An account with this email already exists"]);
  });

  it("rejects an empty edit", async () => {
    const res = await request(app).patch(`/api/admin/users/${member.user.id}`).set("Cookie", admin.cookie).send({});

    expect(res.status).toBe(400);
  });

  it("never leaves the instance without an admin", async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${admin.user.id}`)
      .set("Cookie", admin.cookie)
      .send({ role: "member" });

    expect(res.status).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).role).toBe("admin");
  });

  it("deletes another user but not yourself", async () => {
    const self = await request(app).delete(`/api/admin/users/${admin.user.id}`).set("Cookie", admin.cookie);
    expect(self.status).toBe(400);

    const other = await request(app).delete(`/api/admin/users/${member.user.id}`).set("Cookie", admin.cookie);
    expect(other.status).toBe(204);
    expect(await prisma.user.count({ where: { id: member.user.id } })).toBe(0);
  });

  it("returns 404 for an unknown user", async () => {
    const res = await request(app)
      .delete("/api/admin/users/00000000-0000-4000-8000-000000000000")
      .set("Cookie", admin.cookie);

    expect(res.status).toBe(404);
  });
});

describe("password reset links", () => {
  it("creates a link that sets a new password, without mail configured", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(false);
    const send = vi.spyOn(mailer, "send");

    const res = await request(app)
      .post(`/api/admin/users/${member.user.id}/password-reset`)
      .set("Cookie", admin.cookie);

    expect(res.status).toBe(201);
    expect(res.body.link).toMatch(/\/reset-password\/[\w-]+$/);
    expect(send).not.toHaveBeenCalled();
    const stored = await prisma.passwordReset.findFirstOrThrow({ where: { userId: member.user.id } });
    expect(stored.createdById).toBe(admin.user.id);

    // Creating the link alone leaves the user signed in.
    expect((await request(app).get("/api/auth/me").set("Cookie", member.cookie)).status).toBe(200);

    const token = res.body.link.split("/").pop();
    const reset = await request(app)
      .post(`/api/auth/password-reset/${token}`)
      .send({ password: "brand-new-pass", confirmPassword: "brand-new-pass" });
    expect(reset.status).toBe(200);
    expect(reset.body.user.email).toBe("member@example.com");
    expect((await request(app).get("/api/auth/me").set("Cookie", member.cookie)).status).toBe(401);
  });

  it("refuses a link for yourself", async () => {
    const res = await request(app)
      .post(`/api/admin/users/${admin.user.id}/password-reset`)
      .set("Cookie", admin.cookie);

    expect(res.status).toBe(400);
    expect(await prisma.passwordReset.count()).toBe(0);
  });

  it("returns 404 for an unknown user", async () => {
    const res = await request(app)
      .post("/api/admin/users/00000000-0000-4000-8000-000000000000/password-reset")
      .set("Cookie", admin.cookie);

    expect(res.status).toBe(404);
  });
});

describe("invites", () => {
  it("returns a link without emailing when SMTP is not configured", async () => {
    const send = vi.spyOn(mailer, "send");

    const res = await request(app)
      .post("/api/admin/invites")
      .set("Cookie", admin.cookie)
      .send({ email: "grace@example.com" });

    expect(res.status).toBe(201);
    expect(res.body.link).toMatch(/\/invite\/[\w-]{20,}$/);
    expect(res.body.emailed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("emails the link when SMTP is configured, storing only a hash of the token", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    const send = vi.spyOn(mailer, "send").mockResolvedValue();

    const res = await request(app)
      .post("/api/admin/invites")
      .set("Cookie", admin.cookie)
      .send({ email: "grace@example.com" });

    expect(res.body.emailed).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "grace@example.com" }));
    expect(send.mock.calls[0]![0].text).toContain(res.body.link);

    const token = res.body.link.split("/invite/")[1];
    const stored = await prisma.invite.findFirstOrThrow();
    expect(stored.tokenHash).not.toContain(token);
  });

  it("still creates the invite when the email fails", async () => {
    vi.spyOn(mailer, "configured").mockReturnValue(true);
    vi.spyOn(mailer, "send").mockRejectedValue(new Error("smtp down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/api/admin/invites")
      .set("Cookie", admin.cookie)
      .send({ email: "grace@example.com" });

    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(false);
  });

  it("refuses to invite an email that already has an account", async () => {
    const res = await request(app)
      .post("/api/admin/invites")
      .set("Cookie", admin.cookie)
      .send({ email: "member@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.errors.email).toBeDefined();
  });

  describe("resend", () => {
    // An email invite created with SMTP on, returning its id and token.
    async function emailInvite() {
      vi.spyOn(mailer, "configured").mockReturnValue(true);
      const send = vi.spyOn(mailer, "send").mockResolvedValue();
      const res = await request(app)
        .post("/api/admin/invites")
        .set("Cookie", admin.cookie)
        .send({ email: "grace@example.com" });
      send.mockClear();
      return { id: res.body.invite.id as string, token: res.body.link.split("/invite/")[1] as string, send };
    }

    const show = (token: string) => request(app).get(`/api/auth/invites/${token}`);

    it("emails a new link, retires the old one and renews the expiry", async () => {
      const { id, token, send } = await emailInvite();
      const before = await prisma.invite.findUniqueOrThrow({ where: { id } });
      await prisma.invite.update({ where: { id }, data: { expiresAt: new Date(Date.now() + 60_000) } });

      const res = await request(app).post(`/api/admin/invites/${id}/resend`).set("Cookie", admin.cookie);

      expect(res.status).toBe(200);
      expect(res.body.invite).toMatchObject({ id, email: "grace@example.com" });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "grace@example.com" }));
      const newToken = /\/invite\/([\w-]+)/.exec(send.mock.calls[0]![0].text)![1]!;
      expect((await show(token)).status).toBeGreaterThanOrEqual(400);
      expect((await show(newToken)).status).toBe(200);
      const after = await prisma.invite.findUniqueOrThrow({ where: { id } });
      expect(after.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      expect(after.tokenHash).not.toBe(before.tokenHash);
    });

    it("refuses an open link, which has no one to email", async () => {
      const created = await request(app).post("/api/admin/invites").set("Cookie", admin.cookie).send({});

      const res = await request(app)
        .post(`/api/admin/invites/${created.body.invite.id}/resend`)
        .set("Cookie", admin.cookie);

      expect(res.status).toBe(400);
    });

    it("refuses when email is not set up", async () => {
      const { id, token } = await emailInvite();
      vi.spyOn(mailer, "configured").mockReturnValue(false);

      const res = await request(app).post(`/api/admin/invites/${id}/resend`).set("Cookie", admin.cookie);

      expect(res.status).toBe(409);
      expect((await show(token)).status).toBe(200);
    });

    it("keeps the old link working when the email fails", async () => {
      const { id, token, send } = await emailInvite();
      send.mockRejectedValue(new Error("smtp down"));
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const res = await request(app).post(`/api/admin/invites/${id}/resend`).set("Cookie", admin.cookie);

      expect(res.status).toBe(502);
      expect((await show(token)).status).toBe(200);
    });

    it("returns 404 for a workspace invite or an unknown id", async () => {
      const invite = await prisma.invite.create({
        data: {
          tokenHash: "x",
          email: "grace@example.com",
          workspaceId: admin.workspace.id,
          role: "member",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const workspace = await request(app).post(`/api/admin/invites/${invite.id}/resend`).set("Cookie", admin.cookie);
      const unknown = await request(app)
        .post("/api/admin/invites/00000000-0000-4000-8000-000000000000/resend")
        .set("Cookie", admin.cookie);

      expect(workspace.status).toBe(404);
      expect(unknown.status).toBe(404);
    });
  });

  it("lists pending invites and revokes one", async () => {
    await request(app).post("/api/admin/invites").set("Cookie", admin.cookie).send({});
    const list = await request(app).get("/api/admin/invites").set("Cookie", admin.cookie);
    expect(list.body.invites).toHaveLength(1);
    expect(list.body.invites[0]).toMatchObject({ email: null, invitedBy: { name: "Dev" } });
    expect(list.body.invites[0].tokenHash).toBeUndefined();

    const revoked = await request(app)
      .delete(`/api/admin/invites/${list.body.invites[0].id}`)
      .set("Cookie", admin.cookie);
    expect(revoked.status).toBe(204);
    expect(await prisma.invite.count()).toBe(0);
  });
});
