import { useState } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { formatTokens } from "@/features/reviews/cost"
import { bucketLabel, formatCount, formatUsd } from "./format"
import { Segmented } from "./Segmented"
import type { UsageReport } from "./types"

type Metric = "tokens" | "calls" | "usd"

const METRICS = [
  { value: "tokens", label: "Tokens" },
  { value: "calls", label: "Calls" },
  { value: "usd", label: "Cost" },
] as const

// One series at a time: the three measures have different scales, so they
// never share an axis.
const config: ChartConfig = {
  tokens: { label: "Tokens", color: "var(--chart-1)" },
  calls: { label: "Model calls", color: "var(--chart-1)" },
  usd: { label: "Est. cost", color: "var(--chart-1)" },
}

const FORMAT: Record<Metric, (value: number) => string> = {
  tokens: formatTokens,
  calls: formatCount,
  usd: formatUsd,
}

export function UsageChart({ report }: { report: UsageReport }) {
  const [metric, setMetric] = useState<Metric>("tokens")
  const data = report.series.map((bucket) => ({ ...bucket, label: bucketLabel(bucket.start, report.unit) }))
  const empty = !data.some((bucket) => bucket[metric] > 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage over time</CardTitle>
        <CardDescription>Per {report.unit}, in UTC.</CardDescription>
        <CardAction>
          <Segmented label="Chart measure" options={METRICS} value={metric} onChange={setMetric} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="flex h-56 items-center justify-center text-sm text-muted-foreground">No data for this period</p>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-56 w-full" aria-label="Usage over time">
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={`var(--color-${metric})`} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={`var(--color-${metric})`} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={FORMAT[metric]} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    indicator="line"
                    formatter={(value) => (
                      <span className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">{config[metric]!.label}</span>
                        <span className="font-mono tabular-nums">{FORMAT[metric](Number(value))}</span>
                      </span>
                    )}
                  />
                }
              />
              <Area
                dataKey={metric}
                type="monotone"
                stroke={`var(--color-${metric})`}
                strokeWidth={2}
                fill="url(#usage-fill)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
