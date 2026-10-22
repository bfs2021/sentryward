import type { Request, Response } from "express";
import { env } from "../config/env.ts";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { parseJson } from "../lib/webhook.ts";
import {
  handleGithubEvent,
  isGithubReviewEvent,
  verifyGithubSignature,
  type GitHubPayload,
} from "../services/providers/github.ts";
import { providerFor } from "../services/providers/index.ts";
import { webhookSecret } from "../services/webhooks.ts";
import { ACCESS_LOST_REASON, cancelForDisabledRepositories } from "../worker/queue.ts";

function rawBody(req: Request): Buffer {
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Expected a raw request body");
  return req.body;
}

// The GitHub App's single webhook, shared by every installation.
export async function githubWebhook(req: Request, res: Response) {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "GitHub webhooks are not configured");
  const raw = rawBody(req);
  const header = (name: string) => req.get(name);
  if (!verifyGithubSignature(header, raw, secret)) {
    throw new HttpError(401, "Invalid signature");
  }

  const event = req.get("x-github-event");
  const payload = parseJson<GitHubPayload>(raw);

  if (event === "ping") return res.json({ outcome: "pong" });

  // Keep the connection rather than deleting it: repositories, reviews and
  // findings cascade from it, and a reinstall reattaches it (githubCallback).
  // Without an installation id it no longer matches any event below.
  if (event === "installation" && payload.action === "deleted" && payload.installation) {
    const { count } = await prisma.forgeConnection.updateMany({
      where: { provider: "github", installationId: String(payload.installation.id) },
      data: { installationId: null },
    });
    return res.status(202).json({ outcome: "uninstalled", connections: count });
  }

  // The app lost access to these repositories, so no more events will arrive
  // for them. Disabling keeps their settings and history; accessLostAt marks
  // them to come back if access is granted again. One a user already disabled
  // is left alone. Their in-flight reviews are cancelled with the same commit.
  if (event === "installation_repositories" && payload.action === "removed" && payload.installation) {
    const installationId = String(payload.installation.id);
    const count = await prisma.$transaction(async (tx) => {
      const lost = await tx.repository.findMany({
        where: {
          provider: "github",
          enabled: true,
          externalId: { in: (payload.repositories_removed ?? []).map((repo) => String(repo.id)) },
          connection: { installationId },
        },
        select: { id: true },
      });
      const ids = lost.map((repo) => repo.id);
      const { count } = await tx.repository.updateMany({
        where: { id: { in: ids } },
        data: { enabled: false, accessLostAt: new Date() },
      });
      await cancelForDisabledRepositories(ids, ACCESS_LOST_REASON, tx);
      return count;
    });
    return res.status(202).json({ outcome: "repositories_removed", repositories: count });
  }

  if (event === "installation_repositories" && payload.action === "added" && payload.installation) {
    const { count } = await prisma.repository.updateMany({
      where: {
        provider: "github",
        accessLostAt: { not: null },
        externalId: { in: (payload.repositories_added ?? []).map((repo) => String(repo.id)) },
        connection: { installationId: String(payload.installation.id) },
      },
      data: { enabled: true, accessLostAt: null },
    });
    return res.status(202).json({ outcome: "repositories_added", repositories: count });
  }

  if (!isGithubReviewEvent(event, payload)) return res.status(202).json({ outcome: "ignored" });
  if (!payload.repository || !payload.installation) throw new HttpError(400, "Missing repository or installation");

  // Several workspaces may share one installation; the earliest enabled
  // repository owns automatic reviews so a PR is never reviewed twice.
  const repo = await prisma.repository.findFirst({
    where: {
      provider: "github",
      externalId: String(payload.repository.id),
      enabled: true,
      connection: { installationId: String(payload.installation.id) },
    },
    orderBy: { createdAt: "asc" },
    include: { connection: true },
  });
  if (!repo) return res.status(202).json({ outcome: "not_enabled" });

  const outcome = await handleGithubEvent(repo, event, payload);
  res.status(outcome.status ?? 202).json(outcome.body);
}

// A hook Sentryward registered on one repository, for any forge.
export async function repoWebhook(req: Request, res: Response) {
  const definition = providerFor(String(req.params.provider));
  const repo = await prisma.repository.findUnique({
    where: { id: String(req.params.repoId) },
    include: { connection: true },
  });
  const secret = repo?.provider === req.params.provider ? webhookSecret(repo) : null;
  const raw = rawBody(req);
  const header = (name: string) => req.get(name);
  // The same answer for an unknown repository and a wrong secret, so the URL
  // cannot be used to probe which repositories exist.
  if (!repo || !secret || !definition.repoWebhook.verify(header, raw, secret)) {
    throw new HttpError(401, "Invalid webhook credentials");
  }
  // The hook secret is stored per repository and outlives the token, so the
  // forge keeps delivering after it refused the credentials. Anything queued
  // now would fail; reconnecting the account clears the flag.
  if (repo.connection.credentialsRejectedAt) {
    return res.status(202).json({ outcome: "reconnect_required" });
  }

  const outcome = await definition.repoWebhook.handle(repo, header, raw);
  res.status(outcome.status ?? 202).json(outcome.body);
}
