import { Button } from "@/components/ui/button"
import { Field, FieldSeparator } from "@/components/ui/field"
import type { RegistrationProvider } from "./registration"
import { isSignInProvider, SIGN_IN_PROVIDERS, signInStartHref } from "./signInProviders"

// One button per provider the server has configured, so none is offered that
// would fail. Signing in and signing up are the same round trip.
export function SignInButtons({
  providers,
  invite,
  returnTo,
  separator,
}: {
  providers: RegistrationProvider[] | undefined
  invite?: string
  // Where a login lands afterwards instead of /home.
  returnTo?: string
  // An "or" line between the buttons and a password form below them.
  separator?: boolean
}) {
  const known = (providers ?? []).filter((provider) => isSignInProvider(provider.id))
  if (known.length === 0) return null

  return (
    <>
      <Field>
        {known.map(({ id }) => {
          const { label, icon: Icon } = SIGN_IN_PROVIDERS[id]
          return (
            <Button key={id} variant="outline" asChild>
              <a href={signInStartHref(id, { invite, returnTo })}>
                <Icon />
                Continue with {label}
              </a>
            </Button>
          )
        })}
      </Field>
      {separator && <FieldSeparator>or</FieldSeparator>}
    </>
  )
}
