import { cacheKey, cached, type ForgeCache } from "../forge/cache.ts";
import type { ForgeAdapter } from "../forge/types.ts";
import { parseRepoFile, REPO_CONFIG_FILES } from "./repoFile.ts";
import { resolveConfig, type ResolvedConfig, type RuleIssue } from "./resolve.ts";
import { dashboardOverrideSchema, type Config, type ConfigOverride, type DashboardOverride } from "./schema.ts";

export interface LoadConfigInput {
  adapter: ForgeAdapter;
  project: string;
  // The revision the repository file is read from. For a review this is the
  // base, never the head: a change must not be able to loosen its own review.
  ref: string;
  globalSettings?: unknown;
  repoSettings?: unknown;
  // The repository follows the global config, so its own settings are ignored
  // (but kept, so turning this off brings them back).
  followGlobal?: boolean;
  trigger?: ConfigOverride;
  // Files at a sha never change, so a cached read is as good as a fresh one.
  cache?: ForgeCache;
}

export interface LoadedConfig extends ResolvedConfig {
  repoFile: string | null;
  warnings: string[];
}

type SavedSettings = Pick<LoadConfigInput, "globalSettings" | "repoSettings" | "followGlobal">;

// Saved settings were valid when written; a schema change since then must
// not take every review of the repository down with it.
function savedLayers(input: SavedSettings, warnings: string[]) {
  function saved(value: unknown, label: string): DashboardOverride | undefined {
    if (value === undefined) return undefined;
    const parsed = dashboardOverrideSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    warnings.push(`Saved ${label} settings are no longer valid and were ignored`);
    return undefined;
  }
  return {
    global: saved(input.globalSettings, "global"),
    repoSettings: input.followGlobal ? undefined : saved(input.repoSettings, "repository"),
  };
}

// The configuration before the repository file is read, for decisions that
// come first: whether to read through the cache, and whether a webhook may
// cancel a review without a forge call.
export function loadDashboardConfig(input: SavedSettings): Config {
  return resolveConfig(savedLayers(input, [])).config;
}

// Rules a repository's own settings could not add on top of the global
// config, so a save can be refused instead of the rules being left out of
// every review with only a warning.
export function repoSettingsRuleIssues(input: SavedSettings): RuleIssue[] {
  return resolveConfig(savedLayers(input, [])).ruleIssues.filter((issue) => issue.layer === "repoSettings");
}

export async function loadReviewConfig(input: LoadConfigInput): Promise<LoadedConfig> {
  const warnings: string[] = [];
  const { global, repoSettings } = savedLayers(input, warnings);

  let repoFile: string | null = null;
  let fileOverride: ConfigOverride | undefined;
  for (const name of REPO_CONFIG_FILES) {
    const text = await cached(input.cache, cacheKey("file", input.adapter.host, input.project, name, input.ref), () =>
      input.adapter.getFileAtRef(input.project, name, input.ref),
    );
    if (text === null) continue;
    // Like roborak, the first file found wins; the two are never merged.
    repoFile = name;
    const result = parseRepoFile(name, text);
    fileOverride = result.override;
    warnings.push(...result.warnings);
    break;
  }

  const resolved = resolveConfig({ global, repoSettings, repoFile: fileOverride, trigger: input.trigger });
  return { ...resolved, repoFile, warnings: [...warnings, ...resolved.warnings] };
}
