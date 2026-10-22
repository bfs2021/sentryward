import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { User } from "@/features/auth/auth-context"

export interface PendingInvite {
  id: string
  email: string | null
  expiresAt: string
  createdAt: string
  invitedBy: { name: string } | null
}

export interface CreatedInvite {
  invite: PendingInvite
  // Shown once: the server keeps only a hash of the token.
  link: string
  emailed: boolean
}

export interface CreatedPasswordReset {
  // Shown once: the server keeps only a hash of the token.
  link: string
  expiresAt: string
}

export type UserSortKey = "name" | "email" | "role" | "createdAt"

export interface AdminUserQuery {
  role?: User["role"]
  q?: string
  sort?: UserSortKey
  dir?: "asc" | "desc"
  page?: number
  limit?: number
}

export interface AdminUserPage {
  users: User[]
  total: number
  page: number
  limit: number
}

const USERS_KEY = ["admin", "users"]
const INVITES_KEY = ["admin", "invites"]

// Only set params go into the URL, in a fixed order so query keys and stubs
// stay predictable.
function userSearch(params: AdminUserQuery) {
  const search = new URLSearchParams()
  for (const key of ["role", "q", "sort", "dir", "page", "limit"] as const) {
    if (params[key]) search.set(key, String(params[key]))
  }
  return search.toString()
}

export function useAdminUsers(params: AdminUserQuery = {}) {
  const query = userSearch(params)
  return useQuery({
    queryKey: [...USERS_KEY, params],
    queryFn: () => api<AdminUserPage>(`/admin/users${query ? `?${query}` : ""}`),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  })
}

export type UserEdit = Partial<Pick<User, "name" | "email" | "role">>

export function useUpdateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...edit }: UserEdit & { id: string }) =>
      api<{ user: User }>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(edit) }),
    // Editing yourself (a demotion, a new name) changes what the dashboard
    // shows, so /auth/me refreshes too.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USERS_KEY })
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] })
    },
  })
}

export function useDeleteUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  })
}

// The user's sessions only end once the link is used, so nothing cached changes.
export function useCreatePasswordReset() {
  return useMutation({
    mutationFn: (id: string) =>
      api<CreatedPasswordReset>(`/admin/users/${id}/password-reset`, { method: "POST" }),
  })
}

export function useInvites() {
  return useQuery({
    queryKey: INVITES_KEY,
    queryFn: () => api<{ invites: PendingInvite[] }>("/admin/invites").then((body) => body.invites),
  })
}

export function useCreateInvite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (email?: string) =>
      api<CreatedInvite>("/admin/invites", { method: "POST", body: JSON.stringify({ email }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  })
}

export function useRevokeInvite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/admin/invites/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  })
}

// Issues a fresh link (the old one stops working) and renews the expiry, so
// the list refreshes too.
export function useResendInvite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ invite: PendingInvite }>(`/admin/invites/${id}/resend`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INVITES_KEY }),
  })
}
