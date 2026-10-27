import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { UsagePeriod } from "@/features/usage/types"
import type { BenchmarkReport } from "./types"

export function useBenchmarks(period: UsagePeriod, repoId?: string) {
  const search = new URLSearchParams({ period })
  if (repoId) search.set("repoId", repoId)
  return useQuery({
    queryKey: ["benchmarks", period, repoId ?? null],
    queryFn: () => api<BenchmarkReport>(`/benchmarks?${search}`),
    // Another period or repository keeps the old figures up until the new ones land.
    placeholderData: keepPreviousData,
  })
}
