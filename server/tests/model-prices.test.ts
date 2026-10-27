import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";
import { addMember, createTeam, createUser, inWorkspace } from "./helpers/users.ts";

describe("/api/settings/model-prices", () => {
  let cookie: string;
  let workspaceId: string;

  beforeEach(async () => {
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    const created = await createUser();
    cookie = created.cookie;
    workspaceId = created.workspace.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("saves, replaces and removes a price", async () => {
    const saved = await request(app)
      .put("/api/settings/model-prices")
      .set("Cookie", cookie)
      .send({ model: "openai/my-proxy", input: 1.5, output: 6 });
    expect(saved.status).toBe(200);
    expect(saved.body.prices).toEqual([expect.objectContaining({ model: "openai/my-proxy", price: { input: 1.5, output: 6 } })]);

    const replaced = await request(app)
      .put("/api/settings/model-prices")
      .set("Cookie", cookie)
      .send({ model: "openai/my-proxy", input: 2, output: 8, cached: 0.2 });
    expect(replaced.body.prices).toHaveLength(1);
    expect(replaced.body.prices[0].price).toEqual({ input: 2, output: 8, cached: 0.2 });

    const id = replaced.body.prices[0].id;
    expect((await request(app).delete(`/api/settings/model-prices/${id}`).set("Cookie", cookie)).status).toBe(204);
    expect((await request(app).get("/api/settings/model-prices").set("Cookie", cookie)).body.prices).toEqual([]);
    expect((await request(app).delete(`/api/settings/model-prices/${id}`).set("Cookie", cookie)).status).toBe(404);
  });

  it("lists the models recent reviews called with their built-in price, null when unknown", async () => {
    const connection = await prisma.forgeConnection.create({
      data: { workspaceId, provider: "github", host: "github.com", kind: "github_app", installationId: "1", accountLogin: "acme" },
    });
    const repo = await prisma.repository.create({
      data: { connectionId: connection.id, provider: "github", host: "github.com", fullPath: "acme/web", externalId: "1", defaultBranch: "main" },
    });
    const used = { calls: 1, inputTokens: 10, outputTokens: 1 };
    await prisma.reviewJob.create({
      data: {
        repositoryId: repo.id,
        number: 1,
        headSha: "h",
        trigger: "manual",
        status: "completed",
        summary: { usageByModel: { "openai/my-proxy": used, "anthropic/claude-sonnet-5-5": used } },
      },
    });
    const res = await request(app).get("/api/settings/model-prices").set("Cookie", cookie);
    expect(res.body.models).toEqual([
      { model: "anthropic/claude-sonnet-5-5", builtIn: expect.objectContaining({ input: 2, output: 10 }) },
      { model: "openai/my-proxy", builtIn: null },
    ]);
  });

  it("rejects invalid prices with field errors", async () => {
    const res = await request(app)
      .put("/api/settings/model-prices")
      .set("Cookie", cookie)
      .send({ model: "has space", input: -1, output: 1 });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.errors).sort()).toEqual(["input", "model"]);
  });

  it("lets members read prices but only admins change them, within their workspace", async () => {
    const owner = await createUser("owner@example.com");
    const team = await createTeam(owner.user.id);
    const member = await createUser("member@example.com");
    await addMember(team.id, member.user.id, "member");
    await request(app).put("/api/settings/model-prices").set("Cookie", owner.cookie).set(...inWorkspace(team.id)).send({ model: "x/y", input: 1, output: 1 });

    const read = await request(app).get("/api/settings/model-prices").set("Cookie", member.cookie).set(...inWorkspace(team.id));
    expect(read.body.prices).toHaveLength(1);
    const write = await request(app)
      .put("/api/settings/model-prices")
      .set("Cookie", member.cookie)
      .set(...inWorkspace(team.id))
      .send({ model: "x/z", input: 1, output: 1 });
    expect(write.status).toBe(403);
    const remove = await request(app)
      .delete(`/api/settings/model-prices/${read.body.prices[0].id}`)
      .set("Cookie", member.cookie)
      .set(...inWorkspace(team.id));
    expect(remove.status).toBe(403);

    // Another workspace's admin cannot remove it by id.
    expect((await request(app).delete(`/api/settings/model-prices/${read.body.prices[0].id}`).set("Cookie", cookie)).status).toBe(404);
    // Nor see it.
    expect((await request(app).get("/api/settings/model-prices").set("Cookie", cookie)).body.prices).toEqual([]);
  });
});
