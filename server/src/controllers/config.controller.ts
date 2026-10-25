import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { CATEGORIES, SEVERITIES } from "../review/core/severity.ts";
import { PROFILES } from "../review/config/profiles.ts";
import { repoSettingsRuleIssues } from "../review/config/load.ts";
import { resolveConfig } from "../review/config/resolve.ts";
import { DEFAULT_CONFIG, PROFILE_NAMES, RULE_PATTERN_ERROR, dashboardOverrideSchema, rulePatternCompiles } from "../review/config/schema.ts";
import { previewPublication } from "../review/preview/preview.ts";
import { checkRulePatternsSchema, configPreviewSchema, updateGlobalConfigSchema } from "../schemas/config.schema.ts";
import { requireStoredLlmConnection } from "../services/llm.ts";

// What the settings UI needs to render choices and show inherited values.
export function getConfigSchema(_req: Request, res: Response) {
  res.json({
    defaults: DEFAULT_CONFIG,
    profiles: Object.fromEntries(PROFILE_NAMES.map((name) => [name, PROFILES[name]])),
    severities: SEVERITIES,
    categories: CATEGORIES,
  });
}

// The saved global config and what it resolves to on its own, before any
// repository settings or repository file.
function globalConfigBody(saved: unknown) {
  // Same tolerance as a review: settings saved under an older schema are
  // reported, not fatal.
  const parsed = dashboardOverrideSchema.safeParse(saved);
  const warnings = parsed.success ? [] : ["Saved global settings are no longer valid and were ignored"];
  const settings = parsed.success ? parsed.data : {};
  const { ruleIssues: _ruleIssues, ...resolved } = resolveConfig({ global: settings });
  return { settings, ...resolved, warnings: [...warnings, ...resolved.warnings] };
}

// The global rules always win, so a save is not refused when they leave a
// repository's own rules out; the owner is told which repositories lost them,
// on every read until it is fixed.
async function repositoryRuleWarnings(workspaceId: string, globalSettings: unknown): Promise<string[]> {
  const repos = await prisma.repository.findMany({
    where: { connection: { workspaceId }, followGlobal: false },
    select: { fullPath: true, settings: true },
  });
  return repos.flatMap((repo) => {
    const rules = (repo.settings as { rules?: unknown[] } | null)?.rules;
    if (!Array.isArray(rules) || !rules.length) return [];
    return repoSettingsRuleIssues({ globalSettings, repoSettings: repo.settings }).map((issue) => `${repo.fullPath}: ${issue.message}`);
  });
}

export async function getGlobalConfig(req: Request, res: Response) {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: req.workspaceId! },
    select: { reviewSettings: true },
  });
  res.json(await globalConfigResponse(req.workspaceId!, workspace.reviewSettings));
}

async function globalConfigResponse(workspaceId: string, saved: unknown) {
  const body = globalConfigBody(saved);
  const repositories = await repositoryRuleWarnings(workspaceId, saved);
  return { ...body, warnings: [...body.warnings, ...repositories] };
}

export async function updateGlobalConfig(req: Request, res: Response) {
  const { settings } = updateGlobalConfigSchema.parse(req.body);
  if (!settings.llm?.connection) {
    throw new HttpError(400, "Validation failed", { connection: ["Select an LLM connection"] });
  }
  await requireStoredLlmConnection(req.workspaceId!, settings.llm.connection);
  const workspace = await prisma.workspace.update({
    where: { id: req.workspaceId! },
    data: { reviewSettings: settings },
    select: { reviewSettings: true },
  });
  res.json(await globalConfigResponse(req.workspaceId!, workspace.reviewSettings));
}

// Renders what a review of a sample change would post with these settings. No
// model call and nothing stored: the sample's model answers are scripted.
export async function previewConfig(req: Request, res: Response) {
  const { provider, base, settings } = configPreviewSchema.parse(req.body);
  const { config } = resolveConfig({ global: base, repoSettings: settings });
  res.json(await previewPublication(config, provider));
}

// One answer per pattern, in order: null when it compiles, the same message a
// save would give when it does not.
export function checkRulePatterns(req: Request, res: Response) {
  const { patterns } = checkRulePatternsSchema.parse(req.body);
  res.json({ errors: patterns.map((pattern) => (pattern === "" || rulePatternCompiles(pattern) ? null : RULE_PATTERN_ERROR)) });
}
