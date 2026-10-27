import type { UsagePeriod } from "@/features/usage/types"

// Confirmed: resolved by a later run (not invalidated). False positive:
// dismissed as one. Rates are whole percentages, null with nothing found.
export interface FindingFigures {
  found: number
  confirmed: number
  falsePositives: number
  confirmedRate: number | null
  falsePositiveRate: number | null
}

// usd is null when no call had a price; partial when only some did.
export interface CostFigures {
  usd: number | null
  partial: boolean
  perReview: number | null
}

export interface TokenFigures {
  calls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export interface DuplicateFigures {
  count: number
  rate: number | null
}

export interface ModelBenchmark extends TokenFigures {
  model: string
  reviews: number
  cost: CostFigures
  meanLatencyMs: number | null
  findings: FindingFigures
}

export interface RepositoryBenchmark extends TokenFigures {
  repositoryId: string
  fullPath: string
  reviews: number
  cost: CostFigures
  medianDurationMs: number | null
  findings: FindingFigures
  duplicates: DuplicateFigures
}

// One language or category; model null is tool and rule findings.
export interface Breakdown {
  key: string
  findings: FindingFigures
  models: (FindingFigures & { model: string | null })[]
  best: string | null
}

export interface BenchmarkReport {
  period: UsagePeriod
  // Fewer findings than this and a model is never named best.
  minSample: number
  totals: TokenFigures & {
    reviews: number
    cost: CostFigures
    medianDurationMs: number | null
    findings: FindingFigures
    duplicates: DuplicateFigures
  }
  byModel: ModelBenchmark[]
  byRepository: RepositoryBenchmark[]
  byLanguage: Breakdown[]
  byCategory: Breakdown[]
}
