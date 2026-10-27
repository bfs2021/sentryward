import { BUCKET_ORDER } from "../core/buckets.ts";
import type { Bucket, ReviewResult } from "../core/models.ts";
import { roundUsd, usageByModel, type UsageByModel } from "../core/pricing/pricing.ts";
import { SEVERITIES, type Severity } from "../core/severity.ts";

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  // The calls' recorded costs, fixed when the review ran.
  costUsd: number;
  // Calls no price was known for, so a review none had a price for reads as unknown.
  unpricedCalls: number;
}

export interface ResultSummary {
  title: string;
  webUrl?: string;
  total: number;
  bySeverity: Partial<Record<Severity, number>>;
  byBucket: Partial<Record<Bucket, number>>;
  hasBlocking: boolean;
  // Token totals kept in the digest so stats can sum them without loading results.
  usageTotals: UsageTotals;
  // The same tokens per model, with each model's recorded cost.
  usageByModel: UsageByModel;
  // Findings dropped as repeats of another (across passes, verification and
  // tool checks), for the duplicate rate. Absent on digests from before it.
  duplicates: number;
}

// Sum the per-call token usage into one total.
function usageTotals(result: ReviewResult): UsageTotals {
  const tokens = result.usage.reduce(
    (total, call) => ({
      inputTokens: total.inputTokens + call.inputTokens,
      outputTokens: total.outputTokens + call.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  const costUsd = roundUsd(result.usage.reduce((total, call) => total + (call.cost?.total ?? 0), 0));
  const unpricedCalls = result.usage.filter((call) => call.unpriced).length;
  return { calls: result.usage.length, ...tokens, costUsd, unpricedCalls };
}

// The digest stored beside the result, for lists that must not load results.
export function summarize(result: ReviewResult): ResultSummary {
  const bySeverity: Partial<Record<Severity, number>> = {};
  const byBucket: Partial<Record<Bucket, number>> = {};
  for (const finding of result.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byBucket[finding.bucket] = (byBucket[finding.bucket] ?? 0) + 1;
  }
  return {
    title: result.change.title,
    ...(result.change.webUrl ? { webUrl: result.change.webUrl } : {}),
    total: result.findings.length,
    bySeverity: Object.fromEntries(SEVERITIES.filter((s) => bySeverity[s]).map((s) => [s, bySeverity[s]])),
    byBucket: Object.fromEntries(BUCKET_ORDER.filter((b) => byBucket[b]).map((b) => [b, byBucket[b]])),
    hasBlocking: result.verdict.blocking.length > 0,
    usageTotals: usageTotals(result),
    usageByModel: usageByModel(result.usage),
    duplicates: result.validation.dropped.duplicate ?? 0,
  };
}

// The result as the API serves it: everything stored, plus the summary and
// token totals a client would otherwise recompute.
export function toJson(result: ReviewResult) {
  return {
    ...result,
    summary: summarize(result),
    usageTotals: usageTotals(result),
  };
}
