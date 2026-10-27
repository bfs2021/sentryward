import { Coins, Copy, GitPullRequest, ThumbsDown, ThumbsUp, Timer } from "lucide-react"
import { Stat } from "@/features/reviews/ReviewStatsStrip"
import { formatCount, formatUsd } from "@/features/usage/format"
import { formatDuration } from "@/lib/time"
import { Cost, Rate } from "./format"
import type { BenchmarkReport } from "./types"

function Note({ children }: { children: string }) {
  return <span className="block text-xs font-normal text-muted-foreground">{children}</span>
}

export function BenchmarkCards({ totals }: { totals: BenchmarkReport["totals"] }) {
  return (
    <section aria-label="Benchmark totals" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <Stat label="Reviews" icon={GitPullRequest}>
        {formatCount(totals.reviews)}
      </Stat>
      <Stat label="Est. cost" icon={Coins}>
        <Cost usd={totals.cost.usd} partial={totals.cost.partial} />
        <Note>
          {totals.cost.perReview === null ? "per review unknown" : `${formatUsd(totals.cost.perReview)} per review`}
        </Note>
      </Stat>
      <Stat label="Median duration" icon={Timer}>
        {totals.medianDurationMs === null ? "-" : formatDuration(totals.medianDurationMs)}
      </Stat>
      <Stat label="Confirmed" icon={ThumbsUp}>
        <Rate value={totals.findings.confirmedRate} />
        <Note>{`${formatCount(totals.findings.confirmed)} of ${formatCount(totals.findings.found)} findings`}</Note>
      </Stat>
      <Stat label="False positives" icon={ThumbsDown}>
        <Rate value={totals.findings.falsePositiveRate} />
        <Note>{`${formatCount(totals.findings.falsePositives)} dismissed as wrong`}</Note>
      </Stat>
      <Stat label="Duplicates" icon={Copy}>
        <Rate value={totals.duplicates.rate} />
        <Note>{`${formatCount(totals.duplicates.count)} dropped as repeats`}</Note>
      </Stat>
    </section>
  )
}
