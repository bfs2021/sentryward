import { env } from "../config/env.ts";
import { encrypt } from "../lib/crypto.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { ForgeError } from "../review/forge/http.ts";
import { hostOrigin } from "../review/forge/types.ts";
import { decryptToken } from "./providers/token.ts";

export { pkcePair } from "../lib/oauth.ts";

// Publishing comments, discussions and commit statuses needs write access, and
// GitLab has no narrower scope that grants it.
const SCOPE = "api";
// Refresh a little early so a token cannot expire between the check and the
// forge call that uses it.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 15_000;
// Waiting on another caller's refresh counts against the transaction timeout,
// so it covers two token requests.
const REFRESH_TX_TIMEOUT_MS = 3 * TOKEN_TIMEOUT_MS;
// Left over after the token request for the update and the commit.
const COMMIT_MARGIN_MS = 5_000;
// Below this, a token request would likely outlive the transaction, so the
// refresh is not attempted and the old refresh token stays usable.
const MIN_REQUEST_BUDGET_MS = 1_000;

// A refresh GitLab refuses (the app was revoked, the user deleted or blocked)
// can only be fixed by connecting again, like a token this server cannot decrypt.
export class ReconnectRequiredError extends HttpError {
  constructor() {
    super(409, "GitLab refused to renew this connection's access; reconnect this account");
  }
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  // Null when the instance does not expire access tokens.
  expiresAt: Date | null;
}

export function gitlabOAuthConfigured(): boolean {
  return Boolean(env.GITLAB_OAUTH_CLIENT_ID && env.GITLAB_OAUTH_CLIENT_SECRET);
}

// Through the client origin, like the GitHub App's setup URL, so the browser
// sends the session cookie with the callback.
export function gitlabRedirectUri(): string {
  return `${env.CLIENT_ORIGIN}/api/connections/gitlab/oauth/callback`;
}

export function gitlabAuthorizeUrl(host: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: env.GITLAB_OAUTH_CLIENT_ID!,
    redirect_uri: gitlabRedirectUri(),
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${hostOrigin(host)}/oauth/authorize?${params}`;
}

async function tokenRequest(
  host: string,
  grant: Record<string, string>,
  timeoutMs = TOKEN_TIMEOUT_MS,
): Promise<OAuthTokens> {
  const url = `${hostOrigin(host)}/oauth/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GITLAB_OAUTH_CLIENT_ID!,
      client_secret: env.GITLAB_OAUTH_CLIENT_SECRET!,
      redirect_uri: gitlabRedirectUri(),
      ...grant,
    }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !body.access_token || !body.refresh_token) {
    throw new ForgeError(res.ok ? 502 : res.status, `POST ${url} failed (${res.status}): ${body.error ?? "no token"}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    // Counted from our clock rather than GitLab's created_at, so skew between
    // the two cannot make a token look fresh after it has expired.
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
  };
}

export function exchangeCode(host: string, code: string, verifier: string): Promise<OAuthTokens> {
  return tokenRequest(host, { grant_type: "authorization_code", code, code_verifier: verifier });
}

// The ForgeConnection columns that hold a token set, encrypted.
export function storedTokens(tokens: OAuthTokens) {
  return {
    encryptedToken: encrypt(tokens.accessToken),
    encryptedRefreshToken: encrypt(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
  };
}

function due(connection: { tokenExpiresAt: Date | null }): boolean {
  return connection.tokenExpiresAt !== null && connection.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
}

function accessTokenOf(connection: { encryptedToken: string | null }): string {
  if (!connection.encryptedToken) {
    throw new ReconnectRequiredError();
  }
  return decryptToken(connection.encryptedToken, "GitLab");
}

// The only path that refreshes, read from the database on every call rather
// than from a connection loaded earlier. GitLab rotates the refresh token on
// each use, so two jobs (or the API and a job) refreshing the same connection
// at once would leave one holding a dead token. The row lock makes the second
// caller wait, re-read, and find the token the first one stored.
//
// Once GitLab answers, the old refresh token is spent, so the new tokens must
// survive a transaction that times out or fails to commit afterwards. They are
// then written outside it, guarded on the refresh token they replaced so a
// newer write (a reconnect, another refresh) is never overwritten.
export async function gitlabAccessToken(connectionId: string): Promise<string> {
  const current = await prisma.forgeConnection.findUnique({ where: { id: connectionId } });
  if (!current) {
    throw new HttpError(404, "Connection not found");
  }
  if (!due(current)) {
    return accessTokenOf(current);
  }

  let rotated: { tokens: OAuthTokens; previous: string } | undefined;
  try {
    return await refreshLocked(connectionId, (tokens, previous) => {
      rotated = { tokens, previous };
    });
  } catch (err) {
    if (!rotated) {
      throw err;
    }
    const { tokens, previous } = rotated;
    try {
      await prisma.forgeConnection.updateMany({
        where: { id: connectionId, encryptedRefreshToken: previous },
        data: storedTokens(tokens),
      });
    } catch (saveErr) {
      // The old refresh token is already spent, so the connection will need
      // reconnecting once this access token expires.
      console.error(
        `[gitlab] could not save refreshed tokens for connection ${connectionId}; it will need reconnecting`,
        saveErr,
      );
    }
    // GitLab just issued this token, so it is valid even if the guarded
    // update found the row already replaced or could not be written.
    return tokens.accessToken;
  }
}

function refreshLocked(
  connectionId: string,
  onRotated: (tokens: OAuthTokens, previous: string) => void,
): Promise<string> {
  return prisma.$transaction(
    async (tx) => {
      // Prisma's clock starts a little earlier (connection, BEGIN); the
      // commit margin absorbs that.
      const startedAt = Date.now();
      await tx.$queryRaw`SELECT id FROM forge_connections WHERE id = ${connectionId}::uuid FOR UPDATE`;
      const locked = await tx.forgeConnection.findUnique({ where: { id: connectionId } });
      if (!locked) {
        throw new HttpError(404, "Connection not found");
      }
      if (!due(locked)) {
        return accessTokenOf(locked);
      }
      if (!locked.encryptedRefreshToken) {
        throw new ReconnectRequiredError();
      }
      const refreshToken = decryptToken(locked.encryptedRefreshToken, "GitLab");
      // Capped so GitLab's answer arrives while the transaction can still
      // commit it.
      const budget = REFRESH_TX_TIMEOUT_MS - (Date.now() - startedAt) - COMMIT_MARGIN_MS;
      if (budget < MIN_REQUEST_BUDGET_MS) {
        throw new ForgeError(503, "Timed out waiting to refresh the GitLab token; try again");
      }
      let tokens: OAuthTokens;
      try {
        tokens = await tokenRequest(
          locked.host,
          { grant_type: "refresh_token", refresh_token: refreshToken },
          Math.min(TOKEN_TIMEOUT_MS, budget),
        );
      } catch (err) {
        if (err instanceof ForgeError && (err.status === 400 || err.status === 401)) {
          throw new ReconnectRequiredError();
        }
        throw err;
      }
      onRotated(tokens, locked.encryptedRefreshToken);
      await tx.forgeConnection.update({ where: { id: connectionId }, data: storedTokens(tokens) });
      return tokens.accessToken;
    },
    { timeout: REFRESH_TX_TIMEOUT_MS },
  );
}
