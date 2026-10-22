import jwt from "jsonwebtoken";
import { ForgeHttp, linkHeaderNext, type FetchLike } from "./http.ts";
import { hostOrigin } from "./types.ts";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  // e.g. https://github.com, where the OAuth endpoints live.
  webOrigin: string;
  apiBaseUrl: string;
  fetch?: FetchLike;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

// Installation tokens live an hour; refresh a few minutes early so a long
// review never starts with a token about to lapse.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class GitHubApp {
  private cache = new Map<string, CachedToken>();
  private http: ForgeHttp;

  constructor(private config: GitHubAppConfig) {
    this.http = new ForgeHttp({
      baseUrl: config.apiBaseUrl,
      fetch: config.fetch,
      headers: async () => ({
        Authorization: `Bearer ${this.appJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
    });
  }

  appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    // iat is backdated to absorb clock drift, as GitHub recommends.
    return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: this.config.appId }, this.config.privateKey, {
      algorithm: "RS256",
    });
  }

  async installationToken(installationId: string): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return cached.token;
    }
    const body = await this.http.json<{ token: string; expires_at: string }>(
      `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      { method: "POST" },
    );
    this.cache.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  // An installation id arrives as a plain query parameter, so anyone could
  // replay someone else's. The OAuth code GitHub sends with it ("Request user
  // authorization during installation") proves who came back, and the
  // installation must be one that user can see.
  async userHasInstallation(code: string, installationId: string): Promise<boolean> {
    const doFetch = this.config.fetch ?? globalThis.fetch;
    const res = await doFetch(`${this.config.webOrigin}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !body.access_token) {
      return false;
    }

    const userHttp = new ForgeHttp({
      baseUrl: this.config.apiBaseUrl,
      fetch: this.config.fetch,
      headers: async () => ({
        Authorization: `Bearer ${body.access_token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
    });
    const installations = await userHttp.paginate<{ id: number }>(
      "/user/installations?per_page=100",
      linkHeaderNext,
      10,
      (page) => (page as { installations: { id: number }[] }).installations,
    );
    return installations.some((installation) => String(installation.id) === installationId);
  }

  async installation(
    installationId: string,
  ): Promise<{ id: number; account: { id: number; login: string }; suspended_at?: string | null }> {
    return this.http.json(`/app/installations/${encodeURIComponent(installationId)}`);
  }
}

export function githubApiBase(host: string): string {
  if (host === "github.com") {
    return "https://api.github.com";
  }
  return `${hostOrigin(host)}/api/v3`;
}
