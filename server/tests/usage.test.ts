import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { prisma } from "../src/lib/prisma.ts";
import type { ModelUsage, UsageByModel } from "../src/review/core/pricing/pricing.ts";
import { buildUsageReport, type UsageJob } from "../src/services/usage.ts";
import { createUser } from "./helpers/users.ts";

const NOW = new Date("2026-10-23T12:30:00Z");
const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const PROXY = "openai/my-proxy";

// One model's usage in a digest, with the cost it recorded (input and output
// parts only, enough to check the sums).
const usage = (inputTokens: number, outputTokens: number, usd = { input: 0, output: 0 }, cachedInputTokens = 0, calls = 1): ModelUsage => ({
  calls,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  cost: { input: usd.input, cached: 0, cacheWrite: 0, output: usd.output, reasoning: 0, total: usd.input + usd.output },
});

let seq = 0;
function job(createdAt: string, byModel: UsageByModel | null, repo = { id: "r1", fullPath: "team/web" }): UsageJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    number: seq,
    createdAt: new Date(createdAt),
    repository: repo,
    summary: { title: `Change ${seq}`, ...(byModel ? { usageByModel: byModel } : {}) },
  };
}

describe("buildUsageReport", () => {
  it("charts the last 24 hours by hour and earlier periods by day, zero-filled", () => {
    const jobs = [job("2026-10-23T11:10:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) })];

    const hourly = buildUsageReport(jobs, "24h", NOW);
    expect(hourly.unit).toBe("hour");
    // 12:00 yesterday through 12:00 today.
    expect(hourly.series).toHaveLength(25);
    expect(hourly.series.find((b) => b.start === "2026-10-23T11:00:00.000Z")).toEqual({
      start: "2026-10-23T11:00:00.000Z",
      calls: 1,
      tokens: 1_000_000,
      usd: 2,
    });
    expect(hourly.series.filter((b) => b.tokens > 0)).toHaveLength(1);

    const daily = buildUsageReport(jobs, "7d", NOW);
    expect(daily.unit).toBe("day");
    expect(daily.series.map((b) => b.start.slice(0, 10))).toEqual([
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
  });

  it("charts a long all-time history by month", () => {
    const jobs = [job("2026-01-05T00:00:00Z", { [SONNET]: usage(10, 10) }), job("2026-10-01T00:00:00Z", { [SONNET]: usage(10, 10) })];
    const report = buildUsageReport(jobs, "all", NOW);
    expect(report.unit).toBe("month");
    expect(report.series[0]!.start).toBe("2026-01-01T00:00:00.000Z");
    expect(report.series).toHaveLength(10);
  });

  it("sums the costs each review recorded, per model and provider", () => {
    const report = buildUsageReport(
      [
        job("2026-10-22T10:00:00Z", {
          [SONNET]: usage(1_000_000, 100_000, { input: 1.28, output: 1 }, 400_000),
          [HAIKU]: usage(1_000_000, 1_000_000, { input: 0.1, output: 0.5 }),
        }),
        job("2026-10-23T10:00:00Z", { [SONNET]: usage(0, 100_000, { input: 0, output: 1 }) }),
      ],
      "7d",
      NOW,
    );

    expect(report.totals).toEqual({
      reviews: 2,
      calls: 3,
      inputTokens: 2_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 1_200_000,
      cost: { usd: 3.88 },
    });
    expect(report.byModel).toEqual([
      {
        model: HAIKU,
        provider: "anthropic",
        calls: 1,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
        lastUsed: "2026-10-22T10:00:00.000Z",
        cost: { input: 0.1, cached: 0, output: 0.5, total: 0.6 },
      },
      {
        model: SONNET,
        provider: "anthropic",
        calls: 2,
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        outputTokens: 200_000,
        lastUsed: "2026-10-23T10:00:00.000Z",
        cost: { input: 1.28, cached: 0, output: 2, total: 3.28 },
      },
    ]);
    expect(report.byProvider).toEqual([{ provider: "anthropic", calls: 3, tokens: 3_200_000, usd: 3.88 }]);
  });

  it("shows cache writes as input and reasoning as output in the table", () => {
    const report = buildUsageReport(
      [
        job("2026-10-23T10:00:00Z", {
          [SONNET]: {
            calls: 1,
            inputTokens: 100,
            outputTokens: 100,
            cost: { input: 1, cached: 0.1, cacheWrite: 0.5, output: 2, reasoning: 3, total: 6.6 },
          },
        }),
      ],
      "7d",
      NOW,
    );
    expect(report.byModel[0]!.cost).toEqual({ input: 1.5, cached: 0.1, output: 5, total: 6.6 });
  });

  it("counts a model with no price at $0, and older digests without cost the same way", () => {
    const report = buildUsageReport(
      [
        job("2026-10-23T08:00:00Z", { [PROXY]: usage(10, 10) }),
        job("2026-10-23T09:00:00Z", { [SONNET]: { calls: 1, inputTokens: 1_000_000, outputTokens: 0 } }),
        job("2026-10-23T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) }),
      ],
      "7d",
      NOW,
    );

    expect(report.totals).toMatchObject({ reviews: 3, inputTokens: 2_000_010, cost: { usd: 2 } });
    expect(report.byModel.find((m) => m.model === PROXY)!.cost.total).toBe(0);
    expect(report.recent.map((r) => r.usd)).toEqual([2, 0, 0]);
  });

  it("counts runs without usage as reviews but leaves their tokens out", () => {
    const report = buildUsageReport(
      [job("2026-10-23T09:00:00Z", null), job("2026-10-23T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) })],
      "7d",
      NOW,
    );

    expect(report.totals).toMatchObject({ reviews: 2, inputTokens: 1_000_000, cost: { usd: 2 } });
    expect(report.recent).toHaveLength(1);
    expect(report.byRepository).toEqual([
      expect.objectContaining({ fullPath: "team/web", reviews: 2, inputTokens: 1_000_000, usd: 2 }),
    ]);
  });

  it("groups by repository and lists the newest reviews first", () => {
    const api = { id: "r2", fullPath: "team/api" };
    const report = buildUsageReport(
      [
        job("2026-10-21T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) }),
        job("2026-10-23T10:00:00Z", { [HAIKU]: usage(1_000_000, 0, { input: 0.1, output: 0 }) }, api),
        job("2026-10-22T10:00:00Z", { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) }),
      ],
      "7d",
      NOW,
    );

    expect(report.recent.map((r) => r.fullPath)).toEqual(["team/api", "team/web", "team/web"]);
    expect(report.recent[0]).toMatchObject({ models: [HAIKU], inputTokens: 1_000_000, usd: 0.1 });
    expect(report.byRepository.map((r) => [r.fullPath, r.reviews, r.usd, r.lastUsed])).toEqual(
      expect.arrayContaining([
        ["team/web", 2, 4, "2026-10-22T10:00:00.000Z"],
        ["team/api", 1, 0.1, "2026-10-23T10:00:00.000Z"],
      ]),
    );
  });

  it("is empty without runs", () => {
    const report = buildUsageReport([], "all", NOW);
    expect(report.totals).toMatchObject({ reviews: 0, calls: 0, cost: { usd: 0 } });
    expect(report.byModel).toEqual([]);
    expect(report.recent).toEqual([]);
  });
});

describe("GET /api/usage", () => {
  let cookie: string;
  let repoId: string;
  let otherRepoId: string;

  beforeEach(async () => {
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    const created = await createUser();
    cookie = created.cookie;
    const connection = await prisma.forgeConnection.create({
      data: {
        workspaceId: created.workspace.id,
        provider: "gitlab",
        host: "gitlab.com",
        kind: "token",
        accountLogin: "dev",
        encryptedToken: encrypt("glpat"),
      },
    });
    const repo = (fullPath: string, externalId: string) =>
      prisma.repository.create({
        data: { connectionId: connection.id, provider: "gitlab", host: "gitlab.com", fullPath, externalId, defaultBranch: "main", enabled: true },
      });
    repoId = (await repo("team/web", "1")).id;
    otherRepoId = (await repo("team/api", "2")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function run(repositoryId: string, number: number, byModel: UsageByModel, status: "completed" | "superseded" = "completed") {
    await prisma.reviewJob.create({
      data: { repositoryId, number, headSha: "h", trigger: "manual", status, summary: { title: `Change ${number}`, usageByModel: byModel } as object },
    });
  }

  it("reports the workspace's usage from recorded costs, scoped by repository", async () => {
    await run(repoId, 1, { [PROXY]: usage(1_000_000, 1_000_000, { input: 1, output: 3 }) });
    await run(otherRepoId, 2, { [SONNET]: usage(1_000_000, 0, { input: 2, output: 0 }) });
    // Superseded runs are not counted, as in review stats.
    await run(repoId, 3, { [SONNET]: usage(5_000_000, 0, { input: 10, output: 0 }) }, "superseded");

    const all = await request(app).get("/api/usage?period=30d").set("Cookie", cookie);
    expect(all.status).toBe(200);
    expect(all.body.period).toBe("30d");
    expect(all.body.totals).toMatchObject({ reviews: 2, inputTokens: 2_000_000, cost: { usd: 6 } });

    const scoped = await request(app).get(`/api/usage?repoId=${otherRepoId}`).set("Cookie", cookie);
    expect(scoped.body.period).toBe("7d");
    expect(scoped.body.totals).toMatchObject({ reviews: 1, cost: { usd: 2 } });
  });

  it("shows nothing of another workspace and rejects an unknown period", async () => {
    await run(repoId, 1, { [SONNET]: usage(10, 10) });
    const other = await createUser("other@example.com");

    const res = await request(app).get("/api/usage").set("Cookie", other.cookie);
    expect(res.body.totals.reviews).toBe(0);

    expect((await request(app).get("/api/usage?period=1y").set("Cookie", cookie)).status).toBe(400);
    expect((await request(app).get("/api/usage")).status).toBe(401);
  });
});
