import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.ts";
import { usageQuerySchema } from "../schemas/usage.schema.ts";
import { buildUsageReport, periodStart } from "../services/usage.ts";

export async function getUsage(req: Request, res: Response) {
  const { period, repoId } = usageQuerySchema.parse(req.query);
  const now = new Date();
  const since = periodStart(period, now);
  // The same runs review stats count, reading the small digest column only.
  // "all" scans every run kept; REVIEW_RETENTION_DAYS bounds that. Should it
  // get slow, aggregate usageByModel in SQL (jsonb_each, date_trunc) instead.
  const jobs = await prisma.reviewJob.findMany({
    where: {
      repository: { connection: { workspaceId: req.workspaceId! } },
      ...(repoId ? { repositoryId: repoId } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
      status: { notIn: ["superseded", "skipped", "cancelled"] },
    },
    select: {
      id: true,
      number: true,
      createdAt: true,
      summary: true,
      repository: { select: { id: true, fullPath: true } },
    },
  });
  res.json(buildUsageReport(jobs, period, now));
}
