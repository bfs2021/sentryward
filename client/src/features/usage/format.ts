import type { UsageReport } from "./types"

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})
const count = new Intl.NumberFormat("en-US")

// Per-model and per-repository costs are often fractions of a cent, so up to
// four decimals show.
export function formatUsd(amount: number) {
  return usd.format(amount)
}

export function formatCount(value: number) {
  return count.format(value)
}

// Buckets are UTC, so days and months are labelled in UTC to match them.
export function bucketLabel(start: string, unit: UsageReport["unit"]) {
  const date = new Date(start)
  if (unit === "hour") return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  if (unit === "day") return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" })
}
