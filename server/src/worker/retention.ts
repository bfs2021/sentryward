import { prisma } from "../lib/prisma.ts";
import { Prisma } from "../generated/prisma/client.ts";
import type { ReviewStatus } from "../generated/prisma/client.ts";

// Runs that reviewed nothing: once past the window the whole row goes.
const DELETED: ReviewStatus[] = ["superseded", "skipped", "cancelled"];
// Runs that reviewed something keep their row and summary digest, so lists,
// stats and findings (whose lastJobId points here) stay intact; only the large
// JSON columns are cleared. The newest completed or partial run of each change
// keeps them too: finding details, inline-thread answers and incremental
// reviews read its result.
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
    const ids = await trimmableIds(cutoff, batchSize);
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

// Raw because Prisma cannot express "not the newest run of its change". Rows
// with nothing stored (a run that failed before reviewing) are skipped, so they
// still read as "did not run" rather than as an expired result.
async function trimmableIds(cutoff: Date, batchSize: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT j.id FROM review_jobs j
    WHERE j.status IN ('completed', 'partial', 'failed')
      AND j.finished_at < ${cutoff}
      AND j.result_expired_at IS NULL
      AND (j.result IS NOT NULL OR j.resolved_config IS NOT NULL OR j.publication IS NOT NULL)
      AND NOT (
        j.status IN ('completed', 'partial')
        AND NOT EXISTS (
          SELECT 1 FROM review_jobs n
          WHERE n.repository_id = j.repository_id
            AND n.number = j.number
            AND n.status IN ('completed', 'partial')
            AND n.finished_at > j.finished_at
        )
      )
    LIMIT ${batchSize}
  `;
  return rows.map((row) => row.id);
}

async function batchIds(where: Prisma.ReviewJobWhereInput, batchSize: number): Promise<string[]> {
  const rows = await prisma.reviewJob.findMany({ where, select: { id: true }, take: batchSize });
  return rows.map((row) => row.id);
}
