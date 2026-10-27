import { ArrowDownToLine, ArrowUpFromLine, Coins, DatabaseZap, GitPullRequest, Sparkles } from "lucide-react"
import { costUnknown, formatCost } from "@/features/reviews/cost"
import { Stat } from "@/features/reviews/ReviewStatsStrip"
import { formatCount } from "./format"
import type { UsageReport } from "./types"

function Note({ children }: { children: string }) {
  return <span className="block text-xs font-normal text-muted-foreground">{children}</span>
}

export function OverviewCards({ totals }: { totals: UsageReport["totals"] }) {
  return (
    <section aria-label="Usage totals" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <Stat label="Reviews" icon={GitPullRequest}>
        {formatCount(totals.reviews)}
      </Stat>
      <Stat label="Model calls" icon={Sparkles}>
        {formatCount(totals.calls)}
      </Stat>
      <Stat label="Input tokens" icon={ArrowUpFromLine}>
        {formatCount(totals.inputTokens)}
      </Stat>
      <Stat label="Cached tokens" icon={DatabaseZap}>
        {formatCount(totals.cachedInputTokens)}
        <Note>part of input</Note>
      </Stat>
      <Stat label="Output tokens" icon={ArrowDownToLine}>
        {formatCount(totals.outputTokens)}
      </Stat>
      <Stat label="Est. cost" icon={Coins}>
        {formatCost(costUnknown(totals) ? null : totals.cost.usd)}
        <Note>Estimated, not actual billing</Note>
      </Stat>
    </section>
  )
}
