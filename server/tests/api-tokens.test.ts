import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";
import { hashToken } from "../src/lib/tokens.ts";
import { API_TOKEN_PREFIX, createApiToken } from "../src/services/apiTokens.ts";
import { addMember, createTeam, createUser, inWorkspace } from "./helpers/users.ts";

let cookie: string;
let userId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  ({ cookie, user: { id: userId } } = await createUser());
});

afterAll(async () => {
  await prisma.$disconnect();
});

const bearer = (value: string) => `Bearer ${value}`;

describe("managing tokens", () => {
  it("shows the value once and stores only its hash", async () => {
    const res = await request(app)
      .post("/api/settings/tokens")
      .set("Cookie", cookie)
      .send({ name: "CI", expiresInDays: 30 })
      .expect(201);

    expect(res.body.value).toMatch(new RegExp(`^${API_TOKEN_PREFIX}`));
    expect(res.body.token).toMatchObject({ name: "CI", lastUsedAt: null });
    const expiresIn = new Date(res.body.token.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);

    const stored = await prisma.apiToken.findUniqueOrThrow({ where: { id: res.body.token.id } });
    expect(stored.tokenHash).toBe(hashToken(res.body.value));
    expect(JSON.stringify(stored)).not.toContain(res.body.value);

    const list = await request(app).get("/api/settings/tokens").set("Cookie", cookie).expect(200);
    expect(list.body.tokens).toEqual([res.body.token]);
    expect(JSON.stringify(list.body)).not.toContain(res.body.value);
  });

  it("creates a token that never expires", async () => {
    const res = await request(app)
      .post("/api/settings/tokens")
      .set("Cookie", cookie)
      .send({ name: "Forever", expiresInDays: null })
      .expect(201);
    expect(res.body.token.expiresAt).toBeNull();
  });

  it("validates the name and expiry", async () => {
    const res = await request(app)
      .post("/api/settings/tokens")
      .set("Cookie", cookie)
      .send({ name: " ", expiresInDays: 0 })
      .expect(400);
    expect(Object.keys(res.body.errors).sort()).toEqual(["expiresInDays", "name"]);
  });

  it("revokes a token, which then gets 401", async () => {
    const { token, value } = await createApiToken(userId, "CI", null);
    await request(app).get("/api/reviews").set("Authorization", bearer(value)).expect(200);

    await request(app).delete(`/api/settings/tokens/${token.id}`).set("Cookie", cookie).expect(204);

    await request(app).get("/api/reviews").set("Authorization", bearer(value)).expect(401);
    expect(await prisma.apiToken.count()).toBe(0);
  });

  it("does not revoke another user's token", async () => {
    const other = await createUser("other@example.com");
    const { token } = await createApiToken(other.user.id, "Theirs", null);
    await request(app).delete(`/api/settings/tokens/${token.id}`).set("Cookie", cookie).expect(404);
    expect(await prisma.apiToken.count()).toBe(1);

    const list = await request(app).get("/api/settings/tokens").set("Cookie", cookie).expect(200);
    expect(list.body.tokens).toEqual([]);
  });

  it("cannot be managed with a token", async () => {
    const { token, value } = await createApiToken(userId, "CI", null);
    const auth = bearer(value);
    await request(app).get("/api/settings/tokens").set("Authorization", auth).expect(403);
    await request(app).post("/api/settings/tokens").set("Authorization", auth).send({ name: "x", expiresInDays: null }).expect(403);
    await request(app).delete(`/api/settings/tokens/${token.id}`).set("Authorization", auth).expect(403);
    expect(await prisma.apiToken.count()).toBe(1);
  });

  // GET, but they add connections, so a token must not reach them.
  it.each([
    "/api/connections/github/install",
    "/api/connections/github/callback?installation_id=1&setup_action=install&state=x&code=y",
    "/api/connections/gitlab/oauth/start",
    "/api/connections/gitlab/oauth/callback?state=x&code=y",
  ])("cannot run the connection flow %s", async (path) => {
    const { value } = await createApiToken(userId, "CI", null);
    const res = await request(app).get(path).set("Authorization", bearer(value)).expect(403);
    expect(res.headers.location).toBeUndefined();
    expect(await prisma.oAuthState.count()).toBe(0);
  });

  it("removes a user's tokens with the user", async () => {
    await createApiToken(userId, "CI", null);
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.apiToken.count()).toBe(0);
  });
});

describe("authenticating with a token", () => {
  it("acts as its user and records when it was used", async () => {
    const { token, value } = await createApiToken(userId, "CI", null);
    const res = await request(app).get("/api/auth/me").set("Authorization", bearer(value)).expect(200);
    expect(res.body.user.id).toBe(userId);

    const stored = await prisma.apiToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(stored.lastUsedAt).not.toBeNull();
  });

  it("rejects an expired token", async () => {
    const { token, value } = await createApiToken(userId, "CI", 1);
    await prisma.apiToken.update({ where: { id: token.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app).get("/api/reviews").set("Authorization", bearer(value)).expect(401);
  });

  it.each([
    ["an unknown token", bearer(`${API_TOKEN_PREFIX}nope`)],
    ["a value without the prefix", bearer("nope")],
    ["another scheme", "Basic dXNlcjpwYXNz"],
  ])("rejects %s without falling back to the cookie", async (_name, header) => {
    await request(app).get("/api/reviews").set("Cookie", cookie).set("Authorization", header).expect(401);
  });

  it("may queue and rerun reviews", async () => {
    const { value } = await createApiToken(userId, "CI", null);
    const auth = bearer(value);
    // Past authentication: the body and id are what fail.
    await request(app).post("/api/reviews").set("Authorization", auth).send({}).expect(400);
    await request(app)
      .post("/api/reviews/00000000-0000-4000-8000-000000000000/rerun")
      .set("Authorization", auth)
      .expect(404);
  });

  it.each([
    ["PATCH", "/api/settings/profile"],
    ["PUT", "/api/settings/password"],
    ["DELETE", "/api/settings/account"],
    ["POST", "/api/workspaces"],
    ["POST", "/api/reviews/00000000-0000-4000-8000-000000000000/cancel"],
  ] as const)("may not %s %s", async (method, path) => {
    const { value } = await createApiToken(userId, "CI", null);
    const res = await request(app)
      [method.toLowerCase() as "patch" | "put" | "delete" | "post"](path)
      .set("Authorization", bearer(value))
      .send({ name: "Renamed" })
      .expect(403);
    expect(res.body.message).toBe("API tokens cannot be used for this request");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).name).toBe("Dev");
  });
});

describe("workspace scoping", () => {
  it("picks a team with the workspace header, as a cookie does", async () => {
    const team = await createTeam(userId);
    const { value } = await createApiToken(userId, "CI", null);
    await request(app).get("/api/reviews").set("Authorization", bearer(value)).set(...inWorkspace(team.id)).expect(200);
  });

  it("is refused a team its user is not in", async () => {
    const other = await createUser("other@example.com");
    const team = await createTeam(other.user.id);
    const { value } = await createApiToken(userId, "CI", null);
    await request(app).get("/api/reviews").set("Authorization", bearer(value)).set(...inWorkspace(team.id)).expect(404);

    // Membership is read per request, so joining takes effect at once.
    await addMember(team.id, userId);
    await request(app).get("/api/reviews").set("Authorization", bearer(value)).set(...inWorkspace(team.id)).expect(200);
  });
});
