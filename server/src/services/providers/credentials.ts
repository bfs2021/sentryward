import type { ForgeConnection } from "../../generated/prisma/client.ts";
import { prisma } from "../../lib/prisma.ts";
import { ForgeError } from "../../review/forge/http.ts";
import { ReconnectRequiredError } from "../gitlabOAuth.ts";
import { AppUninstalledError } from "./github.ts";
import { providerFor } from "./index.ts";
import { UnreadableTokenError } from "./token.ts";

export const CREDENTIALS_REJECTED_REASON =
  "The forge rejected this connection's credentials; connect the account again to resume reviews";

// A token this server can no longer decrypt, or an OAuth grant GitLab will no
// longer renew, needs reconnecting, like a revoked one. A rate limit is not a
// refusal even when answered with 403: the token works again once it resets.
export function isCredentialRejection(err: unknown): boolean {
  return (
    err instanceof UnreadableTokenError ||
    err instanceof ReconnectRequiredError ||
    err instanceof AppUninstalledError ||
    (err instanceof ForgeError && !err.rateLimited && [401, 403, 404].includes(err.status))
  );
}

// Whether the stored credentials are refused outright, as opposed to the
// forge being unreachable. Throws for anything that is not a refusal.
export async function credentialsRefused(connection: ForgeConnection): Promise<boolean> {
  try {
    await providerFor(connection.provider).checkCredentials(connection);
    return false;
  } catch (err) {
    if (isCredentialRejection(err)) return true;
    throw err;
  }
}

// Remembers the outcome of a credential check so repository hooks stop
// queueing reviews that cannot run. GitHub App connections are left out: an
// uninstall detaches them instead (webhooks.controller). Writes only when the
// state changes, so a healthy connection costs no update.
//
// A refusal is stored only if the row is unchanged since `connection` was
// read: a reconnect (or OAuth refresh) while the check ran replaced the
// credentials it tested, so the refusal no longer says anything about them.
export async function recordCredentials(
  connection: Pick<ForgeConnection, "id" | "kind" | "updatedAt">,
  ok: boolean,
): Promise<void> {
  if (connection.kind === "github_app") return;
  await prisma.forgeConnection.updateMany({
    where: ok
      ? { id: connection.id, credentialsRejectedAt: { not: null } }
      : { id: connection.id, credentialsRejectedAt: null, updatedAt: connection.updatedAt },
    data: { credentialsRejectedAt: ok ? null : new Date() },
  });
}
