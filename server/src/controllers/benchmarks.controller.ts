import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.ts";
import { usageQuerySchema } from "../schemas/usage.schema.ts";
import { buildBenchmarkReport } from "../services/benchmarks.ts";
import { periodStart } from "../services/usage.ts";

// The runs the usage page counts, by their digest, and the findings first
// seen in the period. Findings are read row by row because the language comes
// from the file path, which SQL cannot map; REVIEW_RETENTION_DAYS and the
// period bound them. Should it get slow, group by file extension in SQL.
export async function getBenchmarks(req: Request, res: Response) {
  const { period, repoId } = usageQuerySchema.parse(req.query);
  const since = periodStart(period, new Date());
  const scope = { repository: { connection: { workspaceId: req.workspaceId! } }, ...(repoId ? { repositoryId: repoId } : {}) };
  const [jobs, findings] = await prisma.$transaction([
    prisma.reviewJob.findMany({
      where: {
        ...scope,
        ...(since ? { createdAt: { gte: since } } : {}),
        status: { notIn: ["superseded", "skipped", "cancelled"] },
      },
      select: {
        createdAt: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        summary: true,
        repository: { select: { id: true, fullPath: true } },
      },
    }),
    prisma.finding.findMany({
      where: { ...scope, ...(since ? { firstSeenAt: { gte: since } } : {}) },
      select: { repositoryId: true, file: true, model: true, category: true, state: true, lifecycle: true, ignoreReason: true },
    }),
  ]);
  res.json(buildBenchmarkReport(jobs, findings, period));
}
