import { prisma } from "../lib/prisma.ts";
import { Prisma } from "../generated/prisma/client.ts";
import type { ReviewStatus } from "../generated/prisma/client.ts";

// Runs that reviewed nothing: once past the window the whole row goes.
const DELETED: ReviewStatus[] = ["superseded", "skipped", "cancelled"];
// Runs that reviewed something keep their row and summary digest, so lists,
// stats and findings (whose lastJobId points here) stay intact; only the large
// JSON columns are cleared.
const TRIMMED: ReviewStatus[] = ["completed", "partial", "failed"];

export interface PruneResult {
  deleted: number;
  trimmed: number;
}

// Works through ids a batch at a time so no statement holds row locks for
// long on a busy table. Every step is idempotent, so two workers pruning at
// once only repeat each other's work.
export async function pruneReviews(
  days: number,
  { now = new Date(), batchSize = 500 }: { now?: Date; batchSize?: number } = {},
): Promise<PruneResult> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);

  let deleted = 0;
  for (;;) {
    const ids = await batchIds({ status: { in: DELETED }, finishedAt: { lt: cutoff } }, batchSize);
    if (ids.length) {
      deleted += (await prisma.reviewJob.deleteMany({ where: { id: { in: ids } } })).count;
    }
    if (ids.length < batchSize) break;
  }

  let trimmed = 0;
  for (;;) {
    const where = { status: { in: TRIMMED }, finishedAt: { lt: cutoff }, resultExpiredAt: null };
    const ids = await batchIds(where, batchSize);
    if (ids.length) {
      // The filter is repeated so a row trimmed by another worker in between
      // keeps its first expiry time.
      const { count } = await prisma.reviewJob.updateMany({
        where: { ...where, id: { in: ids } },
        data: { result: Prisma.DbNull, resolvedConfig: Prisma.DbNull, publication: Prisma.DbNull, resultExpiredAt: now },
      });
      trimmed += count;
    }
    if (ids.length < batchSize) break;
  }

  return { deleted, trimmed };
}

async function batchIds(where: Prisma.ReviewJobWhereInput, batchSize: number): Promise<string[]> {
  const rows = await prisma.reviewJob.findMany({ where, select: { id: true }, take: batchSize });
  return rows.map((row) => row.id);
}
