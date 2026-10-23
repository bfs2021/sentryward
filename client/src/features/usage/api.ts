import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { UsagePeriod, UsageReport } from "./types"

// Its own key, not under "reviews": recorded costs never change, so queueing
// or rerunning a review has no reason to refetch the whole report.
export function useUsage(period: UsagePeriod) {
  return useQuery({
    queryKey: ["usage", period],
    queryFn: () => api<UsageReport>(`/usage?period=${period}`),
    // Switching periods keeps the old figures on screen until the new ones land.
    placeholderData: keepPreviousData,
  })
}
