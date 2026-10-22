import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { loadReviewConfig } from "../review/config/load.ts";
import { hostOrigin } from "../review/forge/types.ts";
import { adapterForConnection, loadWorkspaceConnection, toHttpError } from "../services/forge.ts";
import { requireStoredLlmConnection } from "../services/llm.ts";
import { ensureWebhook, removeWebhook } from "../services/webhooks.ts";
import {
  availableReposQuerySchema,
  enableRepoSchema,
  listReposQuerySchema,
  repoIdParamSchema,
  updateRepoSchema,
} from "../schemas/repos.schema.ts";

const publicRepo = {
  id: true,
  connectionId: true,
  provider: true,
  host: true,
  fullPath: true,
  externalId: true,
  defaultBranch: true,
  enabled: true,
  settings: true,
  followGlobal: true,
  createdAt: true,
} as const;

// The repositories a user has added. Read from the database only, so the page
// loads without asking the forge for every repository the account can see.
export async function listRepos(req: Request, res: Response) {
  const { connectionId } = listReposQuerySchema.parse(req.query);
  // Keeps the 404 for a connection the user does not own; the query below is
  // scoped by owner either way.
  if (connectionId) await loadWorkspaceConnection(req.workspaceId!, connectionId);

  const stored = await prisma.repository.findMany({
    where: { connection: { workspaceId: req.workspaceId! }, ...(connectionId && { connectionId }) },
    include: { connection: { select: { accountLogin: true, provider: true, host: true } } },
    orderBy: { fullPath: "asc" },
  });
  res.json({
    repos: stored.map((repo) => ({
      id: repo.id,
      connectionId: repo.connectionId,
      account: { login: repo.connection.accountLogin, provider: repo.connection.provider, host: repo.connection.host },
      externalId: repo.externalId,
      fullPath: repo.fullPath,
      defaultBranch: repo.defaultBranch,
      webUrl: `${hostOrigin(repo.connection.host)}/${repo.fullPath}`,
      enabled: repo.enabled,
      settings: repo.settings,
      followGlobal: repo.followGlobal,
    })),
  });
}

// Everything the account can see, for picking repositories to add. The forge
// is the source of truth for which repositories exist; the database only marks
// the ones already added.
export async function listAvailableRepos(req: Request, res: Response) {
  const { connectionId } = availableReposQuerySchema.parse(req.query);
  const connection = await loadWorkspaceConnection(req.workspaceId!, connectionId);

  const forgeRepos = await adapterForConnection(connection)
    .listRepos()
    .catch((err: unknown) => {
      throw toHttpError(err, connection.provider);
    });
  const stored = await prisma.repository.findMany({ where: { connectionId } });
  const byExternalId = new Map(stored.map((repo) => [repo.externalId, repo]));

  res.json({
    repos: forgeRepos.map((repo) => {
      const saved = byExternalId.get(repo.externalId);
      return { ...repo, id: saved?.id ?? null, enabled: saved?.enabled ?? false, settings: saved?.settings ?? {} };
    }),
  });
}

export async function enableRepo(req: Request, res: Response) {
  const { connectionId, externalId } = enableRepoSchema.parse(req.body);
  const connection = await loadWorkspaceConnection(req.workspaceId!, connectionId);

  const forgeRepo = await adapterForConnection(connection)
    .getRepo(externalId)
    .catch((err: unknown) => {
      throw toHttpError(err, connection.provider);
    });
  const details = { fullPath: forgeRepo.fullPath, defaultBranch: forgeRepo.defaultBranch, enabled: true, accessLostAt: null };
  const saved = await prisma.repository.upsert({
    where: { connectionId_externalId: { connectionId, externalId: forgeRepo.externalId } },
    update: details,
    create: {
      ...details,
      connectionId,
      externalId: forgeRepo.externalId,
      provider: connection.provider,
      host: connection.host,
    },
  });
  // Manual reviews work either way; the webhook only adds automatic ones.
  const webhook = await ensureWebhook(saved, connection);
  const repo = await prisma.repository.findUniqueOrThrow({ where: { id: saved.id }, select: publicRepo });
  res.status(201).json({ repo, webhook });
}

async function loadOwnedRepo(workspaceId: string, id: string) {
  const repo = await prisma.repository.findFirst({
    where: { id, connection: { workspaceId } },
    include: { connection: { include: { workspace: { select: { reviewSettings: true } } } } },
  });
  if (!repo) {
    throw new HttpError(404, "Repository not found");
  }
  return repo;
}

export async function updateRepo(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const { enabled, settings, followGlobal } = updateRepoSchema.parse(req.body);
  const existing = await loadOwnedRepo(req.workspaceId!, id);

  if (settings?.llm && "connection" in settings.llm) {
    if (!settings.llm.connection) {
      throw new HttpError(400, "Validation failed", { connection: ["Select an LLM connection"] });
    }
    await requireStoredLlmConnection(req.workspaceId!, settings.llm.connection);
  }

  // Turning a repository on or off by hand overrides any access-loss marker,
  // so a reinstall no longer flips it back.
  const accessLostAt = enabled === undefined ? undefined : null;
  const updated = await prisma.repository.update({
    where: { id },
    data: { enabled, settings, followGlobal, accessLostAt },
  });
  let webhook;
  if (enabled === true) webhook = await ensureWebhook(updated, existing.connection);
  if (enabled === false) await removeWebhook(updated, existing.connection);
  const repo = await prisma.repository.findUniqueOrThrow({ where: { id }, select: publicRepo });
  res.json({ repo, ...(webhook ? { webhook } : {}) });
}

// Review jobs and posted findings go with it (cascade), so re-adding the
// repository later starts without history.
export async function deleteRepo(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const repo = await loadOwnedRepo(req.workspaceId!, id);
  // Take Sentryward's hook off the forge while the row still holds its id.
  await removeWebhook(repo, repo.connection).catch(() => undefined);
  await prisma.repository.delete({ where: { id } });
  res.status(204).end();
}

// The configuration a review of the default branch would run with right now,
// with where each value came from and anything wrong with the repository file.
export async function getRepoConfig(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const repo = await loadOwnedRepo(req.workspaceId!, id);

  const loaded = await loadReviewConfig({
    adapter: adapterForConnection(repo.connection),
    project: repo.fullPath,
    ref: repo.defaultBranch,
    globalSettings: repo.connection.workspace.reviewSettings,
    repoSettings: repo.settings,
    followGlobal: repo.followGlobal,
  }).catch((err: unknown) => {
    throw toHttpError(err, repo.provider);
  });
  res.json({ ref: repo.defaultBranch, ...loaded });
}

// Open pull/merge requests, for picking one to review by hand. Read live from
// the forge; Sentryward only knows about changes it has already reviewed.
export async function listRepoChanges(req: Request, res: Response) {
  const { id } = repoIdParamSchema.parse(req.params);
  const repo = await loadOwnedRepo(req.workspaceId!, id);

  const changes = await adapterForConnection(repo.connection)
    .listOpenChanges(repo.fullPath)
    .catch((err: unknown) => {
      throw toHttpError(err, repo.provider);
    });
  res.json({ changes });
}
