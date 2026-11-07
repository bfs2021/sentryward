import { env } from "../../config/env.ts";
import { oauthJson, OAuthRequestError } from "../../lib/oauth.ts";
import { githubApiBase } from "../../review/forge/githubApp.ts";
import { hostOrigin } from "../../review/forge/types.ts";
import { type SignInProviderDefinition, UnverifiedEmailError } from "./types.ts";

// The profile and the user's email addresses, which include unverified ones;
// nothing about repositories.
const SCOPE = "read:user user:email";

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export const githubSignIn: SignInProviderDefinition = {
  label: "GitHub",
  host: () => env.GITHUB_LOGIN_HOST,
  configured: () => Boolean(env.GITHUB_LOGIN_CLIENT_ID && env.GITHUB_LOGIN_CLIENT_SECRET),

  authorizeUrl({ state, challenge, redirectUri }) {
    const params = new URLSearchParams({
      client_id: env.GITHUB_LOGIN_CLIENT_ID!,
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      allow_signup: "true",
    });
    return `${hostOrigin(env.GITHUB_LOGIN_HOST)}/login/oauth/authorize?${params}`;
  },

  async exchangeCode({ code, verifier, redirectUri }) {
    // GitHub answers 200 with an `error` field for a bad code, so success is
    // only the presence of a token.
    const body = await oauthJson<{ access_token?: string }>(
      `${hostOrigin(env.GITHUB_LOGIN_HOST)}/login/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_LOGIN_CLIENT_ID,
          client_secret: env.GITHUB_LOGIN_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      },
    );
    if (!body.access_token) {
      throw new OAuthRequestError("GitHub returned no access token");
    }
    return body.access_token;
  },

  async profile(accessToken) {
    const api = githubApiBase(env.GITHUB_LOGIN_HOST);
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" };
    const user = await oauthJson<GitHubUser>(`${api}/user`, { headers });
    // The profile's public email may be blank or unverified; the primary
    // verified address is the one GitHub vouches for.
    const emails = await oauthJson<GitHubEmail[]>(`${api}/user/emails`, { headers });
    const primary = emails.find((entry) => entry.primary && entry.verified);
    if (!primary) {
      throw new UnverifiedEmailError("GitHub account has no verified primary email");
    }
    return { providerUserId: String(user.id), email: primary.email, name: user.name || user.login };
  },
};
