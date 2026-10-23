const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

// Always marked as an estimate: these are list prices at the time each review
// ran, not what the provider billed.
export function formatCost(amount: number) {
  if (amount > 0 && amount < 0.01) return "<$0.01 est."
  return `~${usd.format(amount)} est.`
}

export function formatTokens(count: number) {
  return compact.format(count)
}
