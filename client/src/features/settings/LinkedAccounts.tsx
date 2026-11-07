import { useEffect, useRef } from "react"
import { useSearchParams } from "react-router"
import { Loader2, Unlink } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { User } from "@/features/auth/auth-context"
import { useRegistration } from "@/features/auth/registration"
import {
  isSignInProvider,
  SIGN_IN_PROVIDERS,
  signInErrorMessage,
  signInStartHref,
} from "@/features/auth/signInProviders"
import { useIdentities, useUnlinkIdentity, type Identity } from "./api"

// A link round trip comes back to /settings?tab=sign-in with ?linked= or
// ?error=. Shown once, then dropped from the URL so a reload does not repeat it.
function useLinkFeedback() {
  const [params, setParams] = useSearchParams()
  const shown = useRef(false)
  useEffect(() => {
    if (shown.current) return
    const linked = params.get("linked")
    const error = params.get("error")
    if (!linked && !error) return
    shown.current = true
    if (linked && isSignInProvider(linked)) toast.success(`${SIGN_IN_PROVIDERS[linked].label} account linked`)
    if (error) toast.error(signInErrorMessage(error))
    setParams({ tab: "sign-in" }, { replace: true })
  }, [params, setParams])
}

function IdentityRow({ identity, canUnlink }: { identity: Identity; canUnlink: boolean }) {
  const unlink = useUnlinkIdentity()
  const known = isSignInProvider(identity.provider) ? SIGN_IN_PROVIDERS[identity.provider] : null
  const Icon = known?.icon

  async function onUnlink() {
    try {
      await unlink.mutateAsync(identity.id)
      toast.success(`${known?.label ?? identity.provider} account unlinked`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong")
    }
  }

  return (
    <li className="flex items-center gap-3 py-3">
      {Icon && <Icon className="size-5 shrink-0" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{known?.label ?? identity.provider}</p>
        <p className="truncate text-sm text-muted-foreground">
          {identity.email} · {identity.host}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onUnlink}
        disabled={!canUnlink || unlink.isPending}
        title={canUnlink ? undefined : "This is your only way to sign in"}
      >
        {unlink.isPending ? <Loader2 className="animate-spin" /> : <Unlink />}
        Unlink
      </Button>
    </li>
  )
}

export function LinkedAccounts({ user }: { user: User }) {
  useLinkFeedback()
  const { data: identities, isLoading } = useIdentities()
  const { data: registration } = useRegistration()
  const providers = (registration?.providers ?? []).filter((provider) => isSignInProvider(provider.id))
  // Mirrors the server rule, which refuses the last remaining way in anyway.
  const passwordCounts = user.hasPassword && registration?.passwordLogin !== false
  const canUnlink = (identities?.length ?? 0) > 1 || passwordCounts

  if (isLoading) return <Skeleton className="h-16 w-full" />

  return (
    <div className="flex flex-col gap-4">
      {identities && identities.length > 0 ? (
        <ul className="divide-y">
          {identities.map((identity) => (
            <IdentityRow key={identity.id} identity={identity} canUnlink={canUnlink} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No accounts linked yet.</p>
      )}
      {providers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {providers.map(({ id }) => {
            const { label, icon: Icon } = SIGN_IN_PROVIDERS[id]
            return (
              <Button key={id} variant="outline" asChild>
                <a href={signInStartHref(id, { intent: "link" })}>
                  <Icon />
                  Link {label}
                </a>
              </Button>
            )
          })}
        </div>
      )}
    </div>
  )
}
