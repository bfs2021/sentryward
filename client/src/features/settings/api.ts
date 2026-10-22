import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError } from "@/lib/api"
import type { User } from "@/features/auth/auth-context"

const ME_QUERY_KEY = ["auth", "me"]

export interface ProfileInput {
  name: string
  email: string
}

export interface PasswordInput {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

export function useUpdateProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ProfileInput) =>
      api<{ user: User }>("/settings/profile", { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: ({ user }) => queryClient.setQueryData(ME_QUERY_KEY, user),
  })
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: PasswordInput) =>
      api<void>("/settings/password", { method: "PUT", body: JSON.stringify(input) }),
  })
}

// Signing out locally is enough: ProtectedRoute sends a null user to /login.
export function useDeleteAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (password: string) =>
      api<void>("/settings/account", { method: "DELETE", body: JSON.stringify({ password }) }),
    onSuccess: () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" })
      queryClient.setQueryData(ME_QUERY_KEY, null)
    },
  })
}

// The picture goes up as the raw request body, so this skips api(), which
// always sends JSON.
async function sendAvatar(method: "PUT" | "DELETE", body?: Blob): Promise<User> {
  const res = await fetch("/api/settings/avatar", {
    method,
    body,
    credentials: "include",
    headers: body ? { "Content-Type": body.type } : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, json.message ?? "Something went wrong", json.errors)
  return json.user
}

export function useUploadAvatar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (image: Blob) => sendAvatar("PUT", image),
    onSuccess: (user) => queryClient.setQueryData(ME_QUERY_KEY, user),
  })
}

export function useRemoveAvatar() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => sendAvatar("DELETE"),
    onSuccess: (user) => queryClient.setQueryData(ME_QUERY_KEY, user),
  })
}

const TOKENS_KEY = ["settings", "tokens"]

export interface ApiToken {
  id: string
  name: string
  expiresAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

export interface ApiTokenInput {
  name: string
  // Null for a token that never expires.
  expiresInDays: number | null
}

export function useApiTokens() {
  return useQuery({
    queryKey: TOKENS_KEY,
    queryFn: () => api<{ tokens: ApiToken[] }>("/settings/tokens"),
    select: (data) => data.tokens,
  })
}

// The value comes back only from this call; the server keeps just its hash.
export function useCreateApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ApiTokenInput) =>
      api<{ token: ApiToken; value: string }>("/settings/tokens", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}

export function useRevokeApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/settings/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TOKENS_KEY }),
  })
}
