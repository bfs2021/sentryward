import { useState } from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { formatTokens } from "@/features/reviews/cost"
import { formatCount } from "./format"
import { Segmented } from "./Segmented"

type Metric = "tokens" | "calls"

const METRICS = [
  { value: "tokens", label: "Tokens" },
  { value: "calls", label: "Calls" },
] as const

// Bars are named on the axis, so one colour serves every bar.
const config: ChartConfig = {
  tokens: { label: "Tokens", color: "var(--chart-1)" },
  calls: { label: "Model calls", color: "var(--chart-1)" },
}

const FORMAT: Record<Metric, (value: number) => string> = { tokens: formatTokens, calls: formatCount }

const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value)

// Provider totals as columns, or the top models as rows (their names are long).
export function BreakdownChart({
  title,
  rows,
  layout,
  empty,
  limit,
}: {
  title: string
  rows: { name: string; tokens: number; calls: number }[]
  layout: "columns" | "rows"
  empty: string
  limit?: number
}) {
  const [metric, setMetric] = useState<Metric>("tokens")
  const data = rows
    .filter((row) => row[metric] > 0)
    .sort((a, b) => b[metric] - a[metric])
    .slice(0, limit)
  const horizontal = layout === "rows"

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <Segmented label={`${title} measure`} options={METRICS} value={metric} onChange={setMetric} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {!data.length ? (
          <p className="flex h-48 items-center justify-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-48 w-full" aria-label={title}>
            <BarChart data={data} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
              {horizontal ? (
                <>
                  <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={FORMAT[metric]} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    width={140}
                    tickFormatter={(value: string) => truncate(value, 22)}
                  />
                </>
              ) : (
                <>
                  <XAxis dataKey="name" tickLine={false} axisLine={false} interval={0} tickFormatter={(value: string) => truncate(value, 12)} />
                  <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={FORMAT[metric]} />
                </>
              )}
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    formatter={(value) => (
                      <span className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">{config[metric]!.label}</span>
                        <span className="font-mono tabular-nums">{FORMAT[metric](Number(value))}</span>
                      </span>
                    )}
                  />
                }
              />
              <Bar dataKey={metric} fill={`var(--color-${metric})`} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
