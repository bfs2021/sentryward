import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"

const NOTIFICATIONS_KEY = ["notifications"]

export type NotificationKind = "webhook" | "slack" | "email"
export type NotificationEvent = "blocked" | "failed" | "completed"

export const EVENT_OPTIONS: { value: NotificationEvent; label: string; description: string }[] = [
  { value: "blocked", label: "Blocked", description: "A review found blocking issues" },
  { value: "failed", label: "Failed", description: "A review could not run or finish" },
  { value: "completed", label: "Completed", description: "Any finished review, blocked or not" },
]

export const KIND_LABELS: Record<NotificationKind, string> = {
  webhook: "Webhook",
  slack: "Slack",
  email: "Email",
}

export interface NotificationTarget {
  id: string
  kind: NotificationKind
  name: string
  events: NotificationEvent[]
  // Only the host of a URL leaves the server; null for email targets.
  host: string | null
  // Saved under a different server ENCRYPTION_KEY; only adding it again helps.
  undecryptable: boolean
  recipientIds: string[]
  // A paused target keeps its settings but gets no deliveries.
  active: boolean
  createdAt: string
  updatedAt: string
}

export type NotificationTargetInput =
  | { kind: "webhook" | "slack"; name: string; events: NotificationEvent[]; url: string }
  | { kind: "email"; name: string; events: NotificationEvent[]; recipientIds: string[] }

export interface NotificationTargetUpdate {
  name?: string
  events?: NotificationEvent[]
  recipientIds?: string[]
  active?: boolean
}

export type TestResult = { ok: true } | { ok: false; error: string }

export function useNotificationTargets() {
  return useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => api<{ targets: NotificationTarget[]; mailConfigured: boolean }>("/notifications"),
  })
}

// A webhook's signing secret comes back only from this call.
export function useCreateNotificationTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: NotificationTargetInput) =>
      api<{ target: NotificationTarget; secret?: string }>("/notifications", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  })
}

export function useUpdateNotificationTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: NotificationTargetUpdate & { id: string }) =>
      api<{ target: NotificationTarget }>(`/notifications/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  })
}

export function useTestNotificationTarget() {
  return useMutation({
    mutationFn: (id: string) =>
      api<{ result: TestResult }>(`/notifications/${id}/test`, { method: "POST" }).then((body) => body.result),
  })
}

export function useDeleteNotificationTarget() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/notifications/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  })
}
