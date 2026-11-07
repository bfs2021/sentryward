import { env } from "../../config/env.ts";
import type { SignInProvider } from "../../generated/prisma/client.ts";
import { HttpError } from "../../lib/httpError.ts";
import { githubSignIn } from "./github.ts";
import { gitlabSignIn } from "./gitlab.ts";
import type { SignInProviderDefinition } from "./types.ts";

// Identity providers for signing in and signing up, separate from forge
// connections (services/providers): a sign-in asks only for identity scopes
// and never creates a ForgeConnection. Adding a provider:
//   1. Add it to SignInProvider in prisma/schema.prisma (with a migration).
//   2. Write services/signIn/<name>.ts implementing SignInProviderDefinition,
//      returning only a verified email from profile().
//   3. Add an entry here; the registry is keyed by SignInProvider, so the
//      compiler points at whatever is missing.
//   4. Add its env vars to config/env.ts (and the PASSWORD_LOGIN refine),
//      .env.example and the README.
//   5. Add the client entry in client/src/features/auth/signInProviders.tsx.
export const SIGN_IN_PROVIDERS: Record<SignInProvider, SignInProviderDefinition> = {
  github: githubSignIn,
  gitlab: gitlabSignIn,
};

const SIGN_IN_PROVIDER_IDS = Object.keys(SIGN_IN_PROVIDERS) as SignInProvider[];

export function configuredSignInProviders(): { id: SignInProvider; host: string }[] {
  return SIGN_IN_PROVIDER_IDS.filter((id) => SIGN_IN_PROVIDERS[id].configured()).map((id) => ({
    id,
    host: SIGN_IN_PROVIDERS[id].host(),
  }));
}

export function isSignInProvider(id: string): id is SignInProvider {
  return Object.hasOwn(SIGN_IN_PROVIDERS, id);
}

// An unconfigured provider looks the same as an unknown one.
export function signInProviderFor(id: string): { id: SignInProvider; provider: SignInProviderDefinition } {
  if (!isSignInProvider(id) || !SIGN_IN_PROVIDERS[id].configured()) {
    throw new HttpError(404, "Sign-in provider not found");
  }
  return { id, provider: SIGN_IN_PROVIDERS[id] };
}

// Through the client origin, like the forge OAuth callbacks, so the browser
// sends its cookies with the callback.
export function signInRedirectUri(id: SignInProvider): string {
  return `${env.CLIENT_ORIGIN}/api/auth/oauth/${id}/callback`;
}

// Whether the user could still sign in after losing one identity: another
// identity, or a password while password login is on.
export function hasOtherSignInMethod(user: { passwordHash: string | null }, otherIdentities: number): boolean {
  return otherIdentities > 0 || (user.passwordHash !== null && env.PASSWORD_LOGIN === "enabled");
}
