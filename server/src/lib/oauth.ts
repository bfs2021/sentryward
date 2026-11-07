import { createHash, randomBytes } from "node:crypto";

// Pieces shared by the OAuth round trips: connecting a forge (services/gitlabOAuth.ts)
// and signing in with a provider (services/signIn).

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// An unguessable value for `state` or a browser nonce.
export function randomState(): string {
  return randomBytes(32).toString("base64url");
}

export class OAuthRequestError extends Error {}

const OAUTH_TIMEOUT_MS = 15_000;

// A request to a provider's token or profile endpoint. Redirects are not
// followed so credentials only ever go to the configured host, and a hung
// provider cannot hold the callback open.
export async function oauthJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", "User-Agent": "Sentryward", ...init.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OAuthRequestError(`Request to ${new URL(url).host} failed: ${(error as Error).message}`);
  }
  if (!res.ok) {
    throw new OAuthRequestError(`${new URL(url).host} answered ${res.status}`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new OAuthRequestError(`${new URL(url).host} answered with invalid JSON`);
  }
}
