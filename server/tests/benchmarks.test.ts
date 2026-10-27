import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";
import type { ModelUsage, UsageByModel } from "../src/review/core/pricing/pricing.ts";
import { buildBenchmarkReport, MIN_SAMPLE, type BenchmarkFinding, type BenchmarkJob } from "../src/services/benchmarks.ts";
import { createUser } from "./helpers/users.ts";

const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const PROXY = "openai/my-proxy";

const usage = (overrides: Partial<ModelUsage> = {}): ModelUsage => ({
  calls: 1,
  inputTokens: 1_000,
  cachedInputTokens: 0,
  outputTokens: 100,
  latencyMs: 2_000,
  unpricedCalls: 0,
  cost: { input: 0.5, cached: 0, cacheWrite: 0, output: 0.5, reasoning: 0, total: 1 },
  ...overrides,
});

const WEB = { id: "r1", fullPath: "team/web" };
const API = { id: "r2", fullPath: "team/api" };

function job(byModel: UsageByModel, options: { repo?: typeof WEB; total?: number; duplicates?: number; durationMs?: number } = {}): BenchmarkJob {
  const started = new Date("2026-10-20T10:00:00Z");
  return {
    createdAt: started,
    status: "completed",
    startedAt: started,
    finishedAt: new Date(started.getTime() + (options.durationMs ?? 60_000)),
    repository: options.repo ?? WEB,
    summary: {
      title: "t",
      total: options.total ?? 0,
      usageByModel: byModel,
      ...(options.duplicates === undefined ? {} : { duplicates: options.duplicates }),
    },
  };
}

function finding(overrides: Partial<BenchmarkFinding> = {}): BenchmarkFinding {
  return {
    repositoryId: "r1",
    file: "src/app.ts",
    model: SONNET,
    category: "bug",
    state: "open",
    lifecycle: "new",
    ignoreReason: null,
    ...overrides,
  };
}

const confirmed = (overrides: Partial<BenchmarkFinding> = {}) => finding({ state: "resolved", lifecycle: "fixed", ...overrides });
const falsePositive = (overrides: Partial<BenchmarkFinding> = {}) =>
  finding({ state: "ignored", ignoreReason: "false_positive", ...overrides });

describe("buildBenchmarkReport", () => {
  it("compares models on cost, tokens, call time and what their findings came to", () => {
    const report = buildBenchmarkReport(
      [job({ [SONNET]: usage(), [HAIKU]: usage({ calls: 2, latencyMs: 1_000 }) }), job({ [SONNET]: usage({ latencyMs: 4_000 }) })],
      [
        confirmed(),
        falsePositive(),
        finding(),
        // An invalidated finding no longer applies: neither confirmed nor a false positive.
        finding({ state: "resolved", lifecycle: "invalidated" }),
        // Dismissed for another reason: not a false positive.
        finding({ state: "ignored", ignoreReason: "intentional" }),
        confirmed({ model: HAIKU }),
      ],
      "30d",
    );
    const sonnet = report.byModel.find((row) => row.model === SONNET)!;
    expect(sonnet).toMatchObject({
      reviews: 2,
      calls: 2,
      inputTokens: 2_000,
      cost: { usd: 2, partial: false, perReview: 1 },
      meanLatencyMs: 3_000,
      findings: { found: 5, confirmed: 1, falsePositives: 1, confirmedRate: 20, falsePositiveRate: 20 },
    });
    expect(report.byModel.find((row) => row.model === HAIKU)).toMatchObject({
      reviews: 1,
      meanLatencyMs: 500,
      findings: { found: 1, confirmed: 1, confirmedRate: 100 },
    });
    expect(report.totals).toMatchObject({ reviews: 2, calls: 4, cost: { usd: 3, perReview: 1.5 }, findings: { found: 6, confirmed: 2 } });
  });

  it("reads cost as unknown when no call had a price, and partial when some did not", () => {
    const report = buildBenchmarkReport(
      [job({ [PROXY]: usage({ unpricedCalls: 1, cost: undefined }), [SONNET]: usage({ calls: 2, unpricedCalls: 1 }) })],
      [],
      "7d",
    );
    expect(report.byModel.find((row) => row.model === PROXY)!.cost).toEqual({ usd: null, partial: false, perReview: null });
    expect(report.byModel.find((row) => row.model === SONNET)!.cost).toEqual({ usd: 1, partial: true, perReview: 1 });
    expect(report.totals.cost).toMatchObject({ usd: 1, partial: true });
  });

  it("leaves call time unknown for digests stored before it was kept", () => {
    const report = buildBenchmarkReport([job({ [SONNET]: usage({ latencyMs: undefined }) })], [], "7d");
    expect(report.byModel[0]!.meanLatencyMs).toBeNull();
  });

  it("breaks repositories down by cost, duration, findings and duplicate rate", () => {
    const report = buildBenchmarkReport(
      [
        job({ [SONNET]: usage() }, { total: 3, duplicates: 1, durationMs: 30_000 }),
        job({ [SONNET]: usage() }, { total: 4, duplicates: 2, durationMs: 90_000 }),
        // A digest from before duplicates were counted adds nothing to the rate.
        job({ [SONNET]: usage() }, { repo: API, total: 10 }),
      ],
      [confirmed(), falsePositive({ repositoryId: "r2" })],
      "30d",
    );
    expect(report.byRepository[0]).toMatchObject({
      fullPath: "team/web",
      reviews: 2,
      cost: { usd: 2, perReview: 1 },
      medianDurationMs: 60_000,
      findings: { found: 1, confirmed: 1 },
      // 3 of 10 reported were duplicates.
      duplicates: { count: 3, rate: 30 },
    });
    expect(report.byRepository[1]).toMatchObject({ fullPath: "team/api", duplicates: { count: 0, rate: null }, findings: { falsePositives: 1 } });
    expect(report.totals.duplicates).toEqual({ count: 3, rate: 30 });
  });

  it("names the best model per language and category among those with enough findings", () => {
    const many = (n: number, make: () => BenchmarkFinding) => Array.from({ length: n }, make);
    const report = buildBenchmarkReport(
      [],
      [
        // TypeScript: Sonnet confirms 3 of 5, Haiku 4 of 5; a tool finding has no model.
        ...many(3, () => confirmed({ file: "src/a.ts" })),
        ...many(2, () => finding({ file: "src/a.ts" })),
        ...many(4, () => confirmed({ file: "src/b.tsx", model: HAIKU })),
        finding({ file: "src/b.tsx", model: HAIKU }),
        finding({ file: "src/c.ts", model: null }),
        // Python: a perfect record on too few findings to count.
        ...many(MIN_SAMPLE - 1, () => confirmed({ file: "app.py", model: HAIKU, category: "security" })),
        finding({ file: "README.weird", category: "no-longer-emitted" }),
      ],
      "30d",
    );
    const typescript = report.byLanguage.find((row) => row.key === "typescript")!;
    expect(typescript.findings).toMatchObject({ found: 11, confirmed: 7 });
    expect(typescript.best).toBe(HAIKU);
    expect(typescript.models.find((row) => row.model === null)).toMatchObject({ found: 1 });
    expect(report.byLanguage.find((row) => row.key === "python")!.best).toBeNull();
    expect(report.byLanguage.find((row) => row.key === "other")!.findings.found).toBe(1);
    expect(report.byCategory.find((row) => row.key === "security")!.best).toBeNull();
    expect(report.byCategory.find((row) => row.key === "other")!.findings.found).toBe(1);
  });
});

describe("GET /api/benchmarks", () => {
  let cookie: string;
  let repoId: string;
  let otherRepoId: string;

  beforeEach(async () => {
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    const created = await createUser();
    cookie = created.cookie;
    const connection = await prisma.forgeConnection.create({
      data: { workspaceId: created.workspace.id, provider: "github", host: "github.com", kind: "github_app", installationId: "1", accountLogin: "acme" },
    });
    const repo = (fullPath: string, externalId: string) =>
      prisma.repository.create({
        data: { connectionId: connection.id, provider: "github", host: "github.com", fullPath, externalId, defaultBranch: "main", enabled: true },
      });
    repoId = (await repo("acme/web", "1")).id;
    otherRepoId = (await repo("acme/api", "2")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function run(repositoryId: string, number: number, byModel: UsageByModel, createdAt = new Date()) {
    await prisma.reviewJob.create({
      data: { repositoryId, number, headSha: "h", trigger: "manual", status: "completed", createdAt, summary: { title: "t", total: 0, usageByModel: byModel, duplicates: 0 } as object },
    });
  }

  async function seedFinding(repositoryId: string, fingerprint: string, firstSeenAt = new Date()) {
    await prisma.finding.create({
      data: {
        repositoryId,
        number: 1,
        fingerprint,
        state: "resolved",
        lifecycle: "fixed",
        title: "t",
        file: "src/app.go",
        startLine: 1,
        severity: "major",
        category: "bug",
        kind: "potential_issue",
        changeTitle: "t",
        model: SONNET,
        firstSeenAt,
      },
    });
  }

  it("reports the workspace's benchmarks for the period, scoped by repository", async () => {
    await run(repoId, 1, { [SONNET]: usage() });
    await run(otherRepoId, 2, { [HAIKU]: usage() });
    await run(repoId, 3, { [SONNET]: usage() }, new Date(Date.now() - 40 * 86_400_000));
    await seedFinding(repoId, "a");
    await seedFinding(repoId, "b", new Date(Date.now() - 40 * 86_400_000));

    const res = await request(app).get("/api/benchmarks?period=30d").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ reviews: 2, findings: { found: 1, confirmed: 1 } });
    expect(res.body.byLanguage[0]).toMatchObject({ key: "go", findings: { found: 1 } });

    const scoped = await request(app).get(`/api/benchmarks?period=all&repoId=${otherRepoId}`).set("Cookie", cookie);
    expect(scoped.body.byModel.map((row: { model: string }) => row.model)).toEqual([HAIKU]);
    expect(scoped.body.totals.findings.found).toBe(0);
  });

  it("shows nothing of another workspace and rejects bad queries", async () => {
    await run(repoId, 1, { [SONNET]: usage() });
    const other = await createUser("other@example.com");
    expect((await request(app).get("/api/benchmarks").set("Cookie", other.cookie)).body.totals.reviews).toBe(0);
    expect((await request(app).get("/api/benchmarks?period=1y").set("Cookie", cookie)).status).toBe(400);
    expect((await request(app).get("/api/benchmarks")).status).toBe(401);
  });
});
