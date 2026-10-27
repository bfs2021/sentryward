import type { FindingLifecycle, FindingState, IgnoreReason, ReviewStatus } from "../generated/prisma/client.ts";
import { median, percent } from "../lib/stats.ts";
import { addUsage, roundUsd, usedTokens, type UsageByModel } from "../review/core/pricing/pricing.ts";
import { CATEGORIES, type Category } from "../review/core/severity.ts";
import { detectLanguage } from "../review/diff/language.ts";
import { totalsOf, type UsagePeriod } from "./usage.ts";

// Below this many decided findings a model's rates say little, so it is never
// named the best for a language or category (the page marks such rows too).
export const MIN_SAMPLE = 5;

// Files no language is detected for, and categories the engine no longer emits.
const OTHER = "other";

export interface BenchmarkJob {
  createdAt: Date;
  status: ReviewStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  summary: unknown;
  repository: { id: string; fullPath: string };
}

export interface BenchmarkFinding {
  repositoryId: string;
  file: string;
  // The model of the pass that raised it; null for tool and rule findings.
  model: string | null;
  category: string;
  state: FindingState;
  lifecycle: FindingLifecycle;
  ignoreReason: IgnoreReason | null;
}

// What became of the findings first seen in the period. Confirmed and false
// positive mean what the findings stats mean by them: resolved by a later run
// (not invalidated), and dismissed as a false positive. The rates are over
// decided (the two together), as in the calibration stats: open findings,
// other dismissals and invalidated ones decided nothing, and counting them
// would mark down a model whose findings are still open.
export interface FindingFigures {
  found: number;
  confirmed: number;
  falsePositives: number;
  decided: number;
  confirmedRate: number | null;
  falsePositiveRate: number | null;
}

// usd is null when no call had a known price, and partial when only some did:
// a sum that leaves calls out would read lower than what was spent.
export interface CostFigures {
  usd: number | null;
  partial: boolean;
  perReview: number | null;
}

export interface TokenFigures {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface BenchmarkReport {
  period: UsagePeriod;
  minSample: number;
  totals: TokenFigures & {
    reviews: number;
    cost: CostFigures;
    medianDurationMs: number | null;
    findings: FindingFigures;
    duplicates: DuplicateFigures;
  };
  byModel: (TokenFigures & {
    model: string;
    reviews: number;
    cost: CostFigures;
    // Mean time per call, over the calls whose time was recorded.
    meanLatencyMs: number | null;
    findings: FindingFigures;
  })[];
  byRepository: (TokenFigures & {
    repositoryId: string;
    fullPath: string;
    reviews: number;
    cost: CostFigures;
    medianDurationMs: number | null;
    findings: FindingFigures;
    duplicates: DuplicateFigures;
  })[];
  byLanguage: Breakdown[];
  byCategory: Breakdown[];
}

// Findings dropped as repeats of another, over the findings kept plus those
// dropped, for reviews whose digest counted them.
export interface DuplicateFigures {
  count: number;
  rate: number | null;
}

// One language or category: its findings overall, then per model. The tool
// and rule findings are a row with model null. best is the model with the
// highest confirmed rate (fewest false positives on a tie) among those with
// at least MIN_SAMPLE decided findings.
export interface Breakdown {
  key: string;
  findings: FindingFigures;
  models: (FindingFigures & { model: string | null })[];
  best: string | null;
}

interface Tally {
  found: number;
  confirmed: number;
  falsePositives: number;
}

const emptyTally = (): Tally => ({ found: 0, confirmed: 0, falsePositives: 0 });

function count(tally: Tally, finding: BenchmarkFinding) {
  tally.found += 1;
  if (finding.state === "resolved" && finding.lifecycle !== "invalidated") tally.confirmed += 1;
  if (finding.state === "ignored" && finding.ignoreReason === "false_positive") tally.falsePositives += 1;
}

function figures(tally: Tally | undefined): FindingFigures {
  const t = tally ?? emptyTally();
  const decided = t.confirmed + t.falsePositives;
  return { ...t, decided, confirmedRate: percent(t.confirmed, decided), falsePositiveRate: percent(t.falsePositives, decided) };
}

function tallyBy<K>(findings: BenchmarkFinding[], keyOf: (finding: BenchmarkFinding) => K): Map<K, Tally> {
  const tallies = new Map<K, Tally>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const tally = tallies.get(key) ?? emptyTally();
    count(tally, finding);
    tallies.set(key, tally);
  }
  return tallies;
}

function tallyAll(findings: BenchmarkFinding[]): Tally {
  const tally = emptyTally();
  for (const finding of findings) count(tally, finding);
  return tally;
}

interface Digest {
  byModel: UsageByModel;
  // Findings the result kept, and those dropped as duplicates; duplicates is
  // null on digests from before it was counted.
  total: number;
  duplicates: number | null;
}

function digestOf(summary: unknown): Digest {
  const digest = summary as { usageByModel?: UsageByModel; total?: number; duplicates?: number } | null;
  return {
    byModel: digest?.usageByModel ?? {},
    total: digest?.total ?? 0,
    duplicates: typeof digest?.duplicates === "number" ? digest.duplicates : null,
  };
}

function costFigures(totals: { calls: number; unpricedCalls: number; usd: number }, reviews: number): CostFigures {
  const unknown = totals.calls > 0 && totals.unpricedCalls === totals.calls;
  const usd = unknown ? null : roundUsd(totals.usd);
  return {
    usd,
    partial: totals.unpricedCalls > 0 && !unknown,
    perReview: usd === null || !reviews ? null : roundUsd(usd / reviews),
  };
}

function split<T extends { calls: number; unpricedCalls: number; usd: number }>(totals: T, reviews: number) {
  const { unpricedCalls: _unpriced, usd: _usd, ...tokens } = totals;
  return { ...tokens, cost: costFigures(totals, reviews) };
}

function duplicateFigures(digests: Digest[]): DuplicateFigures {
  let count = 0;
  let reported = 0;
  for (const digest of digests) {
    if (digest.duplicates === null) continue;
    count += digest.duplicates;
    reported += digest.total + digest.duplicates;
  }
  return { count, rate: percent(count, reported) };
}

// Failed runs are left out, as in the review stats: an error can end a run
// early and would make reviews look faster than they are.
function medianDuration(jobs: BenchmarkJob[]): number | null {
  return median(
    jobs
      .filter((job) => (job.status === "completed" || job.status === "partial") && job.startedAt && job.finishedAt)
      .map((job) => job.finishedAt!.getTime() - job.startedAt!.getTime()),
  );
}

function breakdowns(findings: BenchmarkFinding[], keyOf: (finding: BenchmarkFinding) => string): Breakdown[] {
  const groups = new Map<string, BenchmarkFinding[]>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }
  return [...groups]
    .map(([key, group]) => {
      const models = [...tallyBy(group, (finding) => finding.model)]
        .map(([model, tally]) => ({ model, ...figures(tally) }))
        .sort((a, b) => b.found - a.found);
      const ranked = models
        .filter((row) => row.model !== null && row.decided >= MIN_SAMPLE)
        .sort((a, b) => b.confirmedRate! - a.confirmedRate! || a.falsePositiveRate! - b.falsePositiveRate! || b.found - a.found);
      return { key, findings: figures(tallyAll(group)), models, best: ranked[0]?.model ?? null };
    })
    .sort((a, b) => b.findings.found - a.findings.found);
}

// Models compared on what they cost and what their findings came to, from
// the digests the usage page reads and the findings first seen in the period.
// Costs are those each review recorded when it ran, as on the usage page.
// Cost per review is over the reviews that called a model: queued runs and
// those that failed before any call spent nothing and would dilute it.
export function buildBenchmarkReport(jobs: BenchmarkJob[], findings: BenchmarkFinding[], period: UsagePeriod): BenchmarkReport {
  const all: UsageByModel = {};
  const models = new Map<string, { reviews: number; latencyMs: number; timedCalls: number }>();
  const repos = new Map<string, { fullPath: string; jobs: BenchmarkJob[]; digests: Digest[]; byModel: UsageByModel; billed: number }>();
  const digests: Digest[] = [];
  let billed = 0;

  for (const job of jobs) {
    const digest = digestOf(job.summary);
    digests.push(digest);
    addUsage(all, digest.byModel);
    const repo = repos.get(job.repository.id) ?? { fullPath: job.repository.fullPath, jobs: [], digests: [], byModel: {}, billed: 0 };
    repos.set(job.repository.id, repo);
    repo.jobs.push(job);
    repo.digests.push(digest);
    addUsage(repo.byModel, digest.byModel);
    if (Object.values(digest.byModel).some(usedTokens)) {
      billed += 1;
      repo.billed += 1;
    }
    for (const [model, usage] of Object.entries(digest.byModel)) {
      if (!usedTokens(usage)) continue;
      const entry = models.get(model) ?? { reviews: 0, latencyMs: 0, timedCalls: 0 };
      entry.reviews += 1;
      if (usage.latencyMs !== undefined) {
        entry.latencyMs += usage.latencyMs;
        entry.timedCalls += usage.calls;
      }
      models.set(model, entry);
    }
  }

  const byModelFindings = tallyBy(findings, (finding) => finding.model);
  const byRepoFindings = tallyBy(findings, (finding) => finding.repositoryId);

  return {
    period,
    minSample: MIN_SAMPLE,
    totals: {
      reviews: jobs.length,
      ...split(totalsOf(all), billed),
      medianDurationMs: medianDuration(jobs),
      findings: figures(tallyAll(findings)),
      duplicates: duplicateFigures(digests),
    },
    byModel: [...models]
      .map(([model, entry]) => ({
        model,
        reviews: entry.reviews,
        ...split(totalsOf({ [model]: all[model]! }), entry.reviews),
        meanLatencyMs: entry.timedCalls ? Math.round(entry.latencyMs / entry.timedCalls) : null,
        findings: figures(byModelFindings.get(model)),
      }))
      .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    byRepository: [...repos]
      .map(([repositoryId, repo]) => ({
        repositoryId,
        fullPath: repo.fullPath,
        reviews: repo.jobs.length,
        ...split(totalsOf(repo.byModel), repo.billed),
        medianDurationMs: medianDuration(repo.jobs),
        findings: figures(byRepoFindings.get(repositoryId)),
        duplicates: duplicateFigures(repo.digests),
      }))
      .sort((a, b) => b.reviews - a.reviews || a.fullPath.localeCompare(b.fullPath)),
    byLanguage: breakdowns(findings, (finding) => detectLanguage(finding.file) ?? OTHER),
    byCategory: breakdowns(findings, (finding) => (CATEGORIES.includes(finding.category as Category) ? finding.category : OTHER)),
  };
}
