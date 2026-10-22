import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { Workspace } from "./auth-context"

export type RegistrationMode = "open" | "invite" | "closed"

export interface Invite {
  email: string | null
  expiresAt: string
  invitedBy: { name: string } | null
  // Set for a team invite, which existing users can accept; an instance
  // invite only lets someone register.
  role: "admin" | "member" | null
  workspace: { name: string } | null
}

export function useRegistration() {
  return useQuery({
    queryKey: ["auth", "registration"],
    // mailConfigured tells the forgot password page whether a reset can be
    // emailed or needs an admin.
    queryFn: () =>
      api<{ mode: RegistrationMode; firstUser: boolean; mailConfigured: boolean }>("/auth/registration"),
    retry: false,
  })
}

export function useInvite(token: string) {
  return useQuery({
    queryKey: ["auth", "invite", token],
    queryFn: () => api<{ invite: Invite }>(`/auth/invites/${encodeURIComponent(token)}`).then((body) => body.invite),
    retry: false,
  })
}

// A signed-in user joining a team. The session list refreshes so the new
// workspace can be switched to straight away.
export function useAcceptInvite(token: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api<{ workspace: Workspace }>(`/auth/invites/${encodeURIComponent(token)}/accept`, { method: "POST" }).then(
        (body) => body.workspace,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["auth", "workspaces"] }),
  })
}
