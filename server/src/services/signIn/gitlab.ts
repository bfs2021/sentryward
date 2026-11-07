import { env } from "../../config/env.ts";
import { oauthJson, OAuthRequestError } from "../../lib/oauth.ts";
import { hostOrigin } from "../../review/forge/types.ts";
import { type SignInProviderDefinition, UnverifiedEmailError } from "./types.ts";

// Read-only access to the signed-in user's profile, unlike the `api` scope the
// forge connection needs.
const SCOPE = "read_user";

interface GitLabUser {
  id: number;
  username: string;
  name: string | null;
  email?: string | null;
  confirmed_at?: string | null;
}

export const gitlabSignIn: SignInProviderDefinition = {
  label: "GitLab",
  host: () => env.GITLAB_LOGIN_HOST,
  configured: () => Boolean(env.GITLAB_LOGIN_CLIENT_ID && env.GITLAB_LOGIN_CLIENT_SECRET),

  authorizeUrl({ state, challenge, redirectUri }) {
    const params = new URLSearchParams({
      client_id: env.GITLAB_LOGIN_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${hostOrigin(env.GITLAB_LOGIN_HOST)}/oauth/authorize?${params}`;
  },

  async exchangeCode({ code, verifier, redirectUri }) {
    const body = await oauthJson<{ access_token?: string }>(`${hostOrigin(env.GITLAB_LOGIN_HOST)}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GITLAB_LOGIN_CLIENT_ID!,
        client_secret: env.GITLAB_LOGIN_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }).toString(),
    });
    if (!body.access_token) {
      throw new OAuthRequestError("GitLab returned no access token");
    }
    return body.access_token;
  },

  async profile(accessToken) {
    const user = await oauthJson<GitLabUser>(`${hostOrigin(env.GITLAB_LOGIN_HOST)}/api/v4/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // `email` is the primary address; confirmed_at says GitLab has verified
    // the account's email (instances without confirmation set it on creation).
    if (!user.email || !user.confirmed_at) {
      throw new UnverifiedEmailError("GitLab account has no confirmed email");
    }
    return { providerUserId: String(user.id), email: user.email, name: user.name || user.username };
  },
};
