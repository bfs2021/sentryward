import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { median, percent } from "../lib/stats.ts";
import { Prisma } from "../generated/prisma/client.ts";
import { reviewResultSchema } from "../review/core/models.ts";
import { CATEGORIES, SEVERITIES, type Category } from "../review/core/severity.ts";
import {
  findingCalibrationQuerySchema,
  findingIdParamSchema,
  findingStatsQuerySchema,
  listFindingsQuerySchema,
  updateFindingSchema,
} from "../schemas/findings.schema.ts";

const listFields = {
  id: true,
  number: true,
  state: true,
  lifecycle: true,
  title: true,
  file: true,
  startLine: true,
  severity: true,
  category: true,
  kind: true,
  changeTitle: true,
  author: true,
  lastJobId: true,
  firstSeenAt: true,
  lastSeenAt: true,
  resolvedAt: true,
  ignoredAt: true,
  ignoreReason: true,
  ignoreNote: true,
  repository: { select: { id: true, provider: true, host: true, fullPath: true } },
} as const;

function ownedBy(workspaceId: string) {
  return { repository: { connection: { workspaceId } } };
}

type ListQuery = ReturnType<typeof listFindingsQuerySchema.parse>;
type Dir = ListQuery["dir"];

// Severity is stored most severe first, so "desc" (most severe on top) reads
// the enum backwards. Authors are unknown for backfilled rows; those go last
// either way.
const SORT_ORDER: Record<ListQuery["sort"], (dir: Dir) => Prisma.FindingOrderByWithRelationInput> = {
  title: (dir) => ({ title: dir }),
  number: (dir) => ({ number: dir }),
  repository: (dir) => ({ repository: { fullPath: dir } }),
  state: (dir) => ({ state: dir }),
  severity: (dir) => ({ severity: dir === "desc" ? "asc" : "desc" }),
  category: (dir) => ({ category: dir }),
  kind: (dir) => ({ kind: dir }),
  author: (dir) => ({ author: { sort: dir, nulls: "last" } }),
  lastSeenAt: (dir) => ({ lastSeenAt: dir }),
};

type BreakdownRow<K> = { key: K; found: number; falsePositives: number; rate: number | null };

function breakdownRow<K>(key: K, found: number, falsePositives: number): BreakdownRow<K> {
  return { key, found, falsePositives, rate: percent(falsePositives, found) };
}

// Noisiest first, so the rows worth acting on lead.
function byRate<K>(a: BreakdownRow<K>, b: BreakdownRow<K>) {
  return (b.rate ?? -1) - (a.rate ?? -1) || b.found - a.found;
}

// findings.category is a plain string, so a category the engine no longer
// emits lands here instead of vanishing from the totals.
const OTHER_CATEGORY = "other";

// "#12" (GitHub) and "!12" (GitLab) are how people write change numbers.
const NUMBER_QUERY = /^[#!]?(\d{1,9})$/;

export async function listFindings(req: Request, res: Response) {
  const { repoId, state, lifecycle, ignoreReason, severity, category, kind, q, sort, dir, page, limit } = listFindingsQuerySchema.parse(req.query);
  const where: Prisma.FindingWhereInput = {
    ...ownedBy(req.workspaceId!),
    ...(repoId ? { repositoryId: repoId } : {}),
    ...(state ? { state } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(ignoreReason ? { ignoreReason } : {}),
    ...(severity ? { severity } : {}),
    ...(category ? { category } : {}),
    ...(kind ? { kind } : {}),
  };
  if (q) {
    const asNumber = NUMBER_QUERY.exec(q);
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { file: { contains: q, mode: "insensitive" } },
      { author: { contains: q, mode: "insensitive" } },
      { repository: { fullPath: { contains: q, mode: "insensitive" } } },
      ...(asNumber ? [{ number: Number(asNumber[1]) }] : []),
    ];
  }
  const [findings, total] = await prisma.$transaction([
    prisma.finding.findMany({
      where,
      // The id tiebreak keeps rows from shifting between pages when values collide.
      orderBy: [SORT_ORDER[sort](dir), { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: listFields,
    }),
    prisma.finding.count({ where }),
  ]);
  res.json({ findings, total, page, limit });
}

export async function getFindingStats(req: Request, res: Response) {
  const { repoId, days } = findingStatsQuerySchema.parse(req.query);
  const since = new Date(Date.now() - days * 86_400_000);
  const scope = { ...ownedBy(req.workspaceId!), ...(repoId ? { repositoryId: repoId } : {}) };
  const [open, recent, staleOpen, resolvedRecently, byKind] = await prisma.$transaction([
    prisma.finding.groupBy({
      by: ["severity"],
      where: { ...scope, state: "open" },
      orderBy: { severity: "asc" },
      _count: { _all: true },
    }),
    // Ignored findings were never going to be fixed; they would only drag the
    // rate down. Invalidated ones no longer apply, but were not fixed either.
    prisma.finding.groupBy({
      by: ["state"],
      where: { ...scope, firstSeenAt: { gte: since }, state: { not: "ignored" }, lifecycle: { not: "invalidated" } },
      orderBy: { state: "asc" },
      _count: { _all: true },
    }),
    // Usually left behind by changes that were merged or closed without another run.
    prisma.finding.count({ where: { ...scope, state: "open", firstSeenAt: { lt: since } } }),
    prisma.finding.findMany({
      where: { ...scope, state: "resolved", lifecycle: { not: "invalidated" }, resolvedAt: { gte: since } },
      select: { firstSeenAt: true, resolvedAt: true },
    }),
    // Everything first seen in the period. Unlike the resolution rate, this
    // counts ignored findings: dismissing one as a false positive is exactly
    // what the false-positive rate measures. Split so the totals and every
    // breakdown fold from one query.
    prisma.finding.groupBy({
      by: ["category", "severity", "model", "ruleId", "state", "ignoreReason"],
      where: { ...scope, firstSeenAt: { gte: since } },
      orderBy: { category: "asc" },
      _count: { _all: true },
    }),
  ]);
  const count = (row: { _count?: unknown }) => (row._count as { _all: number })._all;
  const isFalsePositive = (row: (typeof byKind)[number]) => row.state === "ignored" && row.ignoreReason === "false_positive";
  const openBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<(typeof SEVERITIES)[number], number>;
  for (const row of open) {
    if (row.severity in openBySeverity) openBySeverity[row.severity as keyof typeof openBySeverity] = count(row);
  }
  const total = recent.reduce((sum, row) => sum + count(row), 0);
  const resolved = recent.filter((row) => row.state === "resolved").reduce((sum, row) => sum + count(row), 0);
  const found = byKind.reduce((sum, row) => sum + count(row), 0);
  const falsePositives = byKind.filter(isFalsePositive).reduce((sum, row) => sum + count(row), 0);
  // Groups with no findings are left out; how few is too few to show is the
  // dashboard's call.
  const tally = <K>(keyOf: (row: (typeof byKind)[number]) => K) => {
    const totals = new Map<K, { found: number; falsePositives: number }>();
    for (const row of byKind) {
      const key = keyOf(row);
      const entry = totals.get(key) ?? { found: 0, falsePositives: 0 };
      entry.found += count(row);
      if (isFalsePositive(row)) entry.falsePositives += count(row);
      totals.set(key, entry);
    }
    return [...totals].map(([key, t]) => breakdownRow(key, t.found, t.falsePositives));
  };
  const severityOrder = (row: BreakdownRow<string>) => SEVERITIES.indexOf(row.key as (typeof SEVERITIES)[number]);
  res.json({
    days,
    open: open.reduce((sum, row) => sum + count(row), 0),
    openBySeverity,
    resolved,
    total,
    resolutionRate: percent(resolved, total),
    staleOpen,
    medianTimeToResolve: median(resolvedRecently.map((f) => f.resolvedAt!.getTime() - f.firstSeenAt.getTime())),
    falsePositives,
    found,
    falsePositiveRate: percent(falsePositives, found),
    falsePositivesBy: {
      category: tally((row) => (CATEGORIES.includes(row.category as Category) ? row.category : OTHER_CATEGORY)).sort(byRate),
      severity: tally((row) => row.severity).sort((a, b) => severityOrder(a) - severityOrder(b)),
      // The model of the review pass that raised each finding; null for tool
      // and rule findings and rows from before it was recorded.
      model: tally((row) => row.model).sort(byRate),
      // The `.sentryward.yaml` rule each rule finding violates; every other
      // finding has none and is left out, so this is findings per rule.
      rule: tally((row) => row.ruleId)
        .filter((row) => row.key !== null)
        .sort(byRate),
    },
  });
}

const CALIBRATION_NOTE =
  "Confidence is the model's own estimate, as first reported. Each bucket shows how findings reported at that confidence turned out: confirmed (a later run that read the file no longer reported it) or dismissed as false positives. A false positive that a later run stops reporting also counts as confirmed, so the confirmed rate is an upper bound.";

// How the confidence models report has matched what happened to their
// findings, in tenths. A finding is confirmed once a later run that read its
// file stopped reporting it, and a false positive once someone dismissed it as
// one. "Stopped reporting" also catches false positives that drop out (a
// reworded title, a verify demotion, plain nondeterminism), and nothing stored
// tells those apart, so confirmed is an upper bound. Open findings, other
// dismissals and invalidated ones decided nothing, so the rates are over
// `decided`. Raw because Prisma cannot group by an expression.
export async function getFindingCalibration(req: Request, res: Response) {
  const { repoId, days, groupBy } = findingCalibrationQuerySchema.parse(req.query);
  const since = new Date(Date.now() - days * 86_400_000);
  const key = { none: Prisma.sql`NULL::text`, model: Prisma.sql`f.model`, category: Prisma.sql`f.category` }[groupBy];
  const conditions = [
    Prisma.sql`c.workspace_id = ${req.workspaceId!}::uuid`,
    Prisma.sql`f.confidence IS NOT NULL`,
    Prisma.sql`f.first_seen_at >= ${since}`,
  ];
  if (repoId) conditions.push(Prisma.sql`f.repository_id = ${repoId}::uuid`);
  const rows = await prisma.$queryRaw<{ key: string | null; bucket: number; found: number; confirmed: number; falsePositives: number }[]>`
    SELECT ${key} AS key,
      LEAST(floor(f.confidence * 10), 9)::int AS bucket,
      count(*)::int AS found,
      count(*) FILTER (WHERE f.state = 'resolved' AND f.lifecycle <> 'invalidated')::int AS confirmed,
      count(*) FILTER (WHERE f.state = 'ignored' AND f.ignore_reason = 'false_positive')::int AS "falsePositives"
    FROM findings f
    JOIN repositories r ON r.id = f.repository_id
    JOIN forge_connections c ON c.id = r.connection_id
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY 1, 2
  `;
  type Bucket = { min: number; max: number; found: number; confirmed: number; falsePositives: number };
  const groups = new Map<string | null, Map<number, Bucket>>();
  for (const row of rows) {
    const groupKey =
      groupBy === "category" && !CATEGORIES.includes(row.key as Category) ? OTHER_CATEGORY : row.key;
    const buckets = groups.get(groupKey) ?? new Map<number, Bucket>();
    const bucket = buckets.get(row.bucket) ?? {
      min: row.bucket / 10,
      max: (row.bucket + 1) / 10,
      found: 0,
      confirmed: 0,
      falsePositives: 0,
    };
    bucket.found += row.found;
    bucket.confirmed += row.confirmed;
    bucket.falsePositives += row.falsePositives;
    buckets.set(row.bucket, bucket);
    groups.set(groupKey, buckets);
  }
  const result = [...groups].map(([groupKey, buckets]) => {
    const rowsOut = [...buckets.values()]
      .sort((a, b) => a.min - b.min)
      .map((bucket) => {
        const decided = bucket.confirmed + bucket.falsePositives;
        return {
          ...bucket,
          decided,
          confirmedRate: percent(bucket.confirmed, decided),
          falsePositiveRate: percent(bucket.falsePositives, decided),
        };
      });
    return { key: groupKey, found: rowsOut.reduce((sum, b) => sum + b.found, 0), buckets: rowsOut };
  });
  // Largest groups first; how few is too few to trust is the reader's call.
  result.sort((a, b) => b.found - a.found);
  res.json({ days, groupBy, selfReported: true, note: CALIBRATION_NOTE, groups: result });
}

// The row plus the full finding from the run that last reported it. A result
// written by an older version, or a deleted run, leaves only the row.
export async function getFinding(req: Request, res: Response) {
  const { id } = findingIdParamSchema.parse(req.params);
  const row = await prisma.finding.findFirst({
    where: { id, ...ownedBy(req.workspaceId!) },
    select: { ...listFields, fingerprint: true, lastJob: { select: { result: true } } },
  });
  if (!row) {
    throw new HttpError(404, "Finding not found");
  }
  const { fingerprint, lastJob, ...finding } = row;
  const parsed = lastJob?.result ? reviewResultSchema.safeParse(lastJob.result) : null;
  const result = parsed?.success ? parsed.data : null;
  res.json({
    finding,
    detail: result?.findings.find((f) => f.fingerprint === fingerprint) ?? null,
    change: result?.change ?? null,
  });
}

export async function updateFinding(req: Request, res: Response) {
  const { id } = findingIdParamSchema.parse(req.params);
  const input = updateFindingSchema.parse(req.body);
  const existing = await prisma.finding.findFirst({
    where: { id, ...ownedBy(req.workspaceId!) },
    select: { id: true, lifecycle: true },
  });
  if (!existing) {
    throw new HttpError(404, "Finding not found");
  }
  // Reopening puts it back in the worker's hands (the next run resolves it if
  // it is gone) and forgets why it was ignored.
  const data =
    input.state === "ignored"
      ? { state: input.state, ignoredAt: new Date(), ignoreReason: input.reason, ignoreNote: input.note || null }
      : { state: input.state, ignoredAt: null, ignoreReason: null, ignoreNote: null };
  // Either way it is no longer resolved, so "fixed" or "invalidated" would
  // contradict its state until a run reports on it again.
  const gone = existing.lifecycle === "fixed" || existing.lifecycle === "invalidated";
  const finding = await prisma.finding.update({
    where: { id },
    data: { ...data, resolvedAt: null, ...(gone ? { lifecycle: "still_open" as const } : {}) },
    select: listFields,
  });
  res.json({ finding });
}
