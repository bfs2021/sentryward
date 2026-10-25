export const USAGE_PERIODS = ["24h", "7d", "30d", "90d", "all"] as const
export type UsagePeriod = (typeof USAGE_PERIODS)[number]

// USD per part of a model's usage, as each review recorded it: cache writes
// count as input and reasoning as output.
export interface CostBreakdown {
  input: number
  cached: number
  output: number
  total: number
}

export interface UsageTokens {
  calls: number
  // Includes cachedInputTokens.
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export interface ModelUsageRow extends UsageTokens {
  model: string
  provider: string
  lastUsed: string
  // All zero for a model without a price.
  cost: CostBreakdown
}

export interface RepositoryUsageRow extends UsageTokens {
  repositoryId: string
  fullPath: string
  reviews: number
  lastUsed: string | null
  usd: number
}

export interface RecentReviewUsage {
  id: string
  number: number
  title: string | null
  fullPath: string
  createdAt: string
  models: string[]
  inputTokens: number
  outputTokens: number
  usd: number
}

export interface UsageReport {
  period: UsagePeriod
  // How the series is bucketed, in UTC.
  unit: "hour" | "day" | "month"
  // Costs are what reviews recorded when they ran; nothing is re-priced.
  totals: UsageTokens & { reviews: number; cost: { usd: number } }
  series: { start: string; calls: number; tokens: number; usd: number }[]
  byModel: ModelUsageRow[]
  byProvider: { provider: string; calls: number; tokens: number; usd: number }[]
  byRepository: RepositoryUsageRow[]
}

// One page of GET /usage/recent; page is clamped to the last one.
export interface RecentUsagePage {
  reviews: RecentReviewUsage[]
  total: number
  page: number
}
