import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ReviewStatus } from "../src/generated/prisma/client.ts";
import { prisma } from "../src/lib/prisma.ts";
import { pruneReviews } from "../src/worker/retention.ts";
import { createUser } from "./helpers/users.ts";

const NOW = new Date("2026-06-01T00:00:00Z");
const OLD = new Date("2026-04-01T00:00:00Z"); // 61 days before NOW
const RECENT = new Date("2026-05-20T00:00:00Z"); // 12 days before NOW

let repoId: string;

beforeEach(async () => {
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  const { workspace } = await createUser();
  const connection = await prisma.forgeConnection.create({
    data: { workspaceId: workspace.id, provider: "gitlab", host: "gitlab.com", kind: "token", accountLogin: "dev" },
  });
  const repo = await prisma.repository.create({
    data: {
      connectionId: connection.id,
      provider: "gitlab",
      host: "gitlab.com",
      fullPath: "team/web",
      externalId: "1",
      defaultBranch: "main",
      enabled: true,
    },
  });
  repoId = repo.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function job(status: ReviewStatus, finishedAt: Date | null) {
  return prisma.reviewJob.create({
    data: {
      repositoryId: repoId,
      number: 7,
      headSha: "head",
      trigger: "manual",
      status,
      finishedAt,
      result: { big: true },
      resolvedConfig: { config: {} },
      publication: { inlinePosted: [] },
      summary: { title: "T" },
    },
  });
}

const load = (id: string) => prisma.reviewJob.findUnique({ where: { id } });

describe("pruneReviews", () => {
  it("deletes old runs that reviewed nothing", async () => {
    const old = await Promise.all((["superseded", "skipped", "cancelled"] as const).map((s) => job(s, OLD)));
    const recent = await job("superseded", RECENT);

    const pruned = await pruneReviews(30, { now: NOW });

    expect(pruned.deleted).toBe(3);
    for (const { id } of old) expect(await load(id)).toBeNull();
    expect(await load(recent.id)).not.toBeNull();
  });

  it("clears the large columns of old finished runs but keeps the row, summary and finding links", async () => {
    const old = await Promise.all((["completed", "partial", "failed"] as const).map((s) => job(s, OLD)));
    const finding = await prisma.finding.create({
      data: {
        repositoryId: repoId,
        number: 7,
        fingerprint: "fp",
        title: "Bug",
        file: "a.ts",
        startLine: 1,
        severity: "major",
        category: "bug",
        kind: "inline",
        changeTitle: "T",
        lastJobId: old[0]!.id,
      },
    });

    const pruned = await pruneReviews(30, { now: NOW });

    expect(pruned).toEqual({ deleted: 0, trimmed: 3 });
    for (const { id } of old) {
      const row = await load(id);
      expect(row).toMatchObject({
        result: null,
        resolvedConfig: null,
        publication: null,
        summary: { title: "T" },
        resultExpiredAt: NOW,
      });
    }
    expect((await prisma.finding.findUnique({ where: { id: finding.id } }))!.lastJobId).toBe(old[0]!.id);
  });

  it("keeps recent runs and runs still in flight untouched", async () => {
    const kept = [
      await job("completed", RECENT),
      await job("skipped", RECENT),
      await job("queued", null),
      await job("running", null),
    ];

    expect(await pruneReviews(30, { now: NOW })).toEqual({ deleted: 0, trimmed: 0 });
    for (const { id } of kept) {
      expect(await load(id)).toMatchObject({ result: { big: true }, resultExpiredAt: null });
    }
  });

  it("works through more rows than one batch, and a second pass finds nothing left", async () => {
    for (let i = 0; i < 5; i++) await job("superseded", OLD);
    for (let i = 0; i < 5; i++) await job("completed", OLD);

    expect(await pruneReviews(30, { now: NOW, batchSize: 2 })).toEqual({ deleted: 5, trimmed: 5 });
    expect(await pruneReviews(30, { now: NOW, batchSize: 2 })).toEqual({ deleted: 0, trimmed: 0 });
    expect(await prisma.reviewJob.count({ where: { repositoryId: repoId } })).toBe(5);
  });
});
