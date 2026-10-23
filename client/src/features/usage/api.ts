import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { UsagePeriod, UsageReport } from "./types"

// Under "reviews" so saving model prices, which invalidates that prefix,
// re-prices the page too.
export function useUsage(period: UsagePeriod) {
  return useQuery({
    queryKey: ["reviews", "usage", period],
    queryFn: () => api<UsageReport>(`/usage?period=${period}`),
    // Switching periods keeps the old figures on screen until the new ones land.
    placeholderData: keepPreviousData,
  })
}
