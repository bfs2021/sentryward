import { PROFILES } from "./profiles.ts";
import {
  DEFAULT_CONFIG,
  configOverrideSchema,
  configSchema,
  combinedRulesError,
  dashboardOverrideSchema,
  type Config,
  type ConfigOverride,
  type DashboardOverride,
  type ProfileName,
  type Rule,
  type RuleGuard,
} from "./schema.ts";
import { atLeast } from "../core/severity.ts";

export type LayerName = "default" | "profile" | "global" | "repoSettings" | "repoFile" | "trigger";

export interface ConfigLayers {
  // The owner's global config from the dashboard, validated on write.
  global?: DashboardOverride;
  // Saved in the dashboard, validated on write.
  repoSettings?: DashboardOverride;
  // `.sentryward.yaml` from the base revision, already parsed.
  repoFile?: ConfigOverride;
  // A one-off override from whatever started the review.
  trigger?: ConfigOverride;
}

export interface ResolvedConfig {
  config: Config;
  // Dotted leaf path to the layer that set it, so a result can say why a
  // setting has the value it does.
  sources: Record<string, LayerName>;
  // Rules a layer could not add (rulesFrom); the config still resolves.
  warnings: string[];
  // The same, by layer, for callers that reject a save instead of warning.
  ruleIssues: RuleIssue[];
}

export interface RuleIssue {
  layer: LayerName;
  // "clash": a rule id already set below; "limit": the layer's rules broke a
  // limit together with those below and were left out.
  kind: "clash" | "limit";
  message: string;
}

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Objects merge key by key; arrays and scalars replace. Replacing arrays is
// what a user expects from `ignore_paths: [...]` in a file.
function merge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key] as Plain, value) : value;
  }
  return out;
}

// languageInstructions is a map keyed by language; its keys are data, not
// settings, so it is recorded as one leaf.
const MAP_PATHS = new Set(["languageInstructions"]);

function recordLeaves(value: unknown, layer: LayerName, sources: Record<string, LayerName>, path = "") {
  if (isPlainObject(value) && !MAP_PATHS.has(path)) {
    for (const [key, child] of Object.entries(value)) {
      recordLeaves(child, layer, sources, path ? `${path}.${key}` : key);
    }
  } else if (value !== undefined && path) {
    sources[path] = layer;
  }
}

// Settings saved before `triggers.review` existed: `onPush: false` meant no
// automatic reviews at all and `drafts: true` included drafts. A layer that
// sets them without `review` keeps that meaning, attributed to the same layer.
export function withLegacyTriggers<T extends ConfigOverride>(layer: T): T {
  const triggers = layer.triggers;
  if (!triggers || triggers.review !== undefined) return layer;
  if (triggers.onPush === false) return { ...layer, triggers: { ...triggers, review: "manual" } };
  if (triggers.drafts === true) return { ...layer, triggers: { ...triggers, review: "all" } };
  return layer;
}

const LAYER_LABELS: Record<LayerName, string> = {
  default: "the defaults",
  profile: "the profile",
  global: "the global config",
  repoSettings: "the repository settings",
  repoFile: "the repository file",
  trigger: "the trigger",
};

// Rules combine across layers instead of replacing like other lists: each
// layer adds to those below it and can never drop or redefine one of them, so
// a repository file cannot loosen what the workspace requires. Every layer was
// validated on its own, so only the combination can break a limit; then that
// layer's additions are left out as a whole, never half of them.
function rulesFrom(layers: [LayerName, ConfigOverride | undefined][], sources: Record<string, LayerName>, issues: RuleIssue[]): Rule[] {
  let rules: Rule[] = [];
  for (const [name, layer] of layers) {
    if (!layer?.rules?.length) continue;
    const added: Rule[] = [];
    for (const rule of layer.rules) {
      const owner = sources[`rules.${rule.id}`];
      if (owner) {
        issues.push({ layer: name, kind: "clash", message: `Rule ${rule.id} in ${LAYER_LABELS[name]} was ignored: a rule with that id is already set in ${LAYER_LABELS[owner]}` });
      } else added.push(rule);
    }
    if (!added.length) continue;
    const combined = [...rules, ...added];
    const reason = combinedRulesError(combined);
    if (reason) {
      issues.push({
        layer: name,
        kind: "limit",
        message: `Rules in ${LAYER_LABELS[name]} were ignored: together with the rules below them, ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`,
      });
      continue;
    }
    rules = combined;
    for (const rule of added) sources[`rules.${rule.id}`] = name;
    sources.rules = name;
  }
  return rules;
}

function withoutRules<T extends ConfigOverride>(layer: T): T {
  if (layer.rules === undefined) return layer;
  const { rules: _rules, ...rest } = layer;
  return rest as T;
}

// Precedence, lowest first: defaults, profile preset, global config,
// repository settings, repository file, trigger. The profile itself is chosen by the highest layer
// that names one.
export function resolveConfig(layers: ConfigLayers): ResolvedConfig {
  const ordered: [LayerName, DashboardOverride | undefined][] = [
    ["global", layers.global],
    ["repoSettings", layers.repoSettings],
    ["repoFile", layers.repoFile],
    ["trigger", layers.trigger],
  ];
  // Only the dashboard layers may set endpoints.
  for (const [name, layer] of ordered) {
    if (!layer) continue;
    if (name === "global" || name === "repoSettings") dashboardOverrideSchema.parse(layer);
    else configOverrideSchema.parse(layer);
  }

  const naming = [...ordered].reverse().find(([, layer]) => layer?.profile);
  const profile: ProfileName = naming?.[1]?.profile ?? DEFAULT_CONFIG.profile;

  const sources: Record<string, LayerName> = {};
  recordLeaves(DEFAULT_CONFIG, "default", sources);
  let merged = merge({}, DEFAULT_CONFIG);

  const stack: [LayerName, DashboardOverride][] = [["profile", { ...PROFILES[profile], profile }]];
  for (const [name, layer] of ordered) {
    if (layer) stack.push([name, withLegacyTriggers(layer)]);
  }
  for (const [name, layer] of stack) {
    merged = merge(merged, withoutRules(layer) as Plain);
    recordLeaves(withoutRules(layer), name, sources);
  }
  // `profile` is decided above, not merged; attribute it to whoever named it.
  sources.profile = naming?.[0] ?? "default";
  const ruleIssues: RuleIssue[] = [];
  merged.rules = rulesFrom(ordered, sources, ruleIssues);
  const config = configSchema.parse(merged);
  const ruleGuard = guardFor(layers, config, sources);
  if (ruleGuard) config.ruleGuard = ruleGuard;

  return { config, sources, warnings: ruleIssues.map((issue) => issue.message), ruleIssues };
}

const DASHBOARD_LAYERS = new Set<LayerName>(["global", "repoSettings"]);

// Dashboard rules are held to the thresholds the dashboard layers resolve to
// on their own, profile included, or to the effective ones where those are
// stricter: a repository file or trigger can ask for more of them, never less.
// Only needed when such a layer exists and there is a dashboard rule to hold.
function guardFor(layers: ConfigLayers, config: Config, sources: Record<string, LayerName>): RuleGuard | undefined {
  if (!layers.repoFile && !layers.trigger) return undefined;
  const ids = config.rules.filter((rule) => DASHBOARD_LAYERS.has(sources[`rules.${rule.id}`]!)).map((rule) => rule.id);
  if (!ids.length) return undefined;
  const dashboard = resolveConfig({ global: layers.global, repoSettings: layers.repoSettings }).config;
  const floor = config.review.severityFloor;
  return {
    ids,
    severityFloor: atLeast(floor, dashboard.review.severityFloor) ? dashboard.review.severityFloor : floor,
    minConfidence: Math.min(config.review.minConfidence, dashboard.review.minConfidence),
    ignorePaths: dashboard.ignorePaths,
  };
}
