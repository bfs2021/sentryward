import type { ComponentType, SVGProps } from "react"
import { GitHubIcon, GitLabIcon } from "@/features/forge/icons"

// The sign-in providers the server knows (server/src/services/signIn/index.ts).
// Which ones are configured comes from GET /auth/registration; this only holds
// how each looks. Keyed by every provider so adding one without an entry here
// fails the type check.
export type SignInProvider = "github" | "gitlab"

export interface SignInProviderDefinition {
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

export const SIGN_IN_PROVIDERS: Record<SignInProvider, SignInProviderDefinition> = {
  github: { label: "GitHub", icon: GitHubIcon },
  gitlab: { label: "GitLab", icon: GitLabIcon },
}

export function isSignInProvider(id: string): id is SignInProvider {
  return Object.hasOwn(SIGN_IN_PROVIDERS, id)
}

// Where the browser goes to start a round trip. A navigation, not a fetch: the
// server redirects to the provider and back.
export function signInStartHref(provider: SignInProvider, options: { intent?: "login" | "link"; invite?: string } = {}) {
  const params = new URLSearchParams({ intent: options.intent ?? "login" })
  if (options.invite) params.set("invite", options.invite)
  return `/api/auth/oauth/${provider}/start?${params}`
}

// The codes a provider callback redirects back with (?error=).
const SIGN_IN_ERRORS: Record<string, string> = {
  oauth_failed: "Signing in with that provider didn't work. Please try again.",
  oauth_denied: "Sign-in was cancelled at the provider.",
  email_unverified: "That account has no verified email address. Verify one with the provider and try again.",
  email_registered:
    "An account with this email already exists. Log in with your password, then link the provider from Settings.",
  identity_in_use: "That provider account is already linked to another Sentryward account.",
  registration_closed: "Registration is closed on this Sentryward instance. Ask an admin for access.",
  invite_required: "An invite is required to create an account here. Ask an admin to invite you.",
  invite_invalid: "This invite is invalid, has expired, or is for a different email address.",
}

export function signInErrorMessage(code: string | null): string | null {
  if (!code) return null
  return SIGN_IN_ERRORS[code] ?? SIGN_IN_ERRORS.oauth_failed
}
