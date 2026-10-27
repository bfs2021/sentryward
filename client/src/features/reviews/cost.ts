const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

// A cost no call had a price for reads as unknown rather than $0.00. Results
// and digests from before unpriced calls were counted have none, so they read
// as before.
export function costUnknown(row: { calls: number; unpricedCalls?: number }) {
  return row.calls > 0 && row.unpricedCalls === row.calls
}

// Always marked as an estimate: these are list prices at the time each review
// ran, not what the provider billed. null is a cost nothing priced.
export function formatCost(amount: number | null) {
  if (amount === null) return "Unknown"
  if (amount > 0 && amount < 0.01) return "<$0.01 est."
  return `~${usd.format(amount)} est.`
}

export function formatTokens(count: number) {
  return compact.format(count)
}
