import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { RecentUsagePage, UsagePeriod, UsageReport } from "./types"

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

// Paged on the server, so a long period never sends every review at once.
export function useRecentUsage(period: UsagePeriod, page: number, size: number) {
  return useQuery({
    queryKey: ["usage", period, "recent", page, size],
    queryFn: () => api<RecentUsagePage>(`/usage/recent?period=${period}&page=${page}&limit=${size}`),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  })
}
