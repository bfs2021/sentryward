import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import type { Workspace } from "./auth-context"
import type { SignInProvider } from "./signInProviders"

export type RegistrationMode = "open" | "invite" | "closed"

// A sign-in provider this server has configured.
export interface RegistrationProvider {
  id: SignInProvider
  host: string
}

export interface Registration {
  mode: RegistrationMode
  firstUser: boolean
  mailConfigured: boolean
  // False when the instance only allows signing in through a provider.
  passwordLogin: boolean
  providers: RegistrationProvider[]
}

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
    queryFn: () => api<Registration>("/auth/registration"),
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
