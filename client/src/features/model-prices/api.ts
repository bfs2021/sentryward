import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"

// USD per million tokens. Cache and reasoning rates absent fall back to the
// input and output ones.
export interface ModelPrice {
  input: number
  output: number
  cached?: number
  cacheWrite?: number
  reasoning?: number
}

export interface SavedModelPrice {
  id: string
  model: string
  price: ModelPrice
  updatedAt: string
}

export interface ModelPrices {
  prices: SavedModelPrice[]
  // Models recent reviews called, with the built-in price each gets without
  // one of the workspace's own; null is unknown.
  models: { model: string; builtIn: ModelPrice | null }[]
}

export interface ModelPriceInput {
  model: string
  input: number
  output: number
  cached: number | null
  cacheWrite: number | null
  reasoning: number | null
}

const KEY = ["model-prices"]

export function useModelPrices() {
  return useQuery({ queryKey: KEY, queryFn: () => api<ModelPrices>("/settings/model-prices") })
}

export function useSaveModelPrice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ModelPriceInput) =>
      api<ModelPrices>("/settings/model-prices", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
  })
}

export function useDeleteModelPrice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/settings/model-prices/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
}
