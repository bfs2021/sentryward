import { useMutation, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"

// The server answers the same way whether or not the email has an account.
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (email: string) =>
      api<void>("/auth/password-reset", { method: "POST", body: JSON.stringify({ email }) }),
  })
}

// Fails for a link that is unknown, used or expired, so the page can say so
// before asking for a new password.
export function usePasswordReset(token: string) {
  return useQuery({
    queryKey: ["auth", "password-reset", token],
    queryFn: () => api<{ email: string }>(`/auth/password-reset/${encodeURIComponent(token)}`),
    retry: false,
  })
}
