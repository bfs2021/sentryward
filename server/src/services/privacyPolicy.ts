import { env } from "../config/env.ts";
import { isInternalHost, type Resolve } from "../lib/hostSafety.ts";
import { prisma } from "../lib/prisma.ts";
import {
  PROVIDERS,
  providerOf,
  type Endpoint,
  type ProviderBaseUrls,
  type ProviderName,
} from "../review/llm/providers.ts";
import { OFFICIAL_BASE_URLS } from "./llmConnection.ts";

// One layer of privacy policy, instance or workspace. Empty lists allow
// everything; null retention keeps data forever.
export interface PolicyLayer {
  allowedProviders: ProviderName[];
  allowedHosts: string[];
  localOnly: boolean;
  retentionDays: number | null;
}

export interface InstancePolicy extends PolicyLayer {
  auditRetentionDays: number | null;
  // Where retentionDays came from: the admin setting, REVIEW_RETENTION_DAYS,
  // or neither.
  retentionSource: "settings" | "env" | null;
}

export interface EffectivePolicy {
  instance: InstancePolicy;
  workspace: PolicyLayer;
  localOnly: boolean;
  retentionDays: number | null;
}

export const OPEN_LAYER: PolicyLayer = { allowedProviders: [], allowedHosts: [], localOnly: false, retentionDays: null };

function providers(values: string[]): ProviderName[] {
  return values.filter((value): value is ProviderName => PROVIDERS.includes(value as ProviderName));
}

export async function instancePolicy(): Promise<InstancePolicy> {
  const row = await prisma.instanceSettings.findUnique({ where: { id: 1 } });
  const envDays = env.REVIEW_RETENTION_DAYS ?? null;
  const retentionDays = row?.retentionDays ?? envDays;
  return {
    allowedProviders: providers(row?.allowedProviders ?? []),
    allowedHosts: row?.allowedHosts ?? [],
    localOnly: row?.localOnly ?? false,
    retentionDays,
    auditRetentionDays: row?.auditRetentionDays ?? null,
    retentionSource: row?.retentionDays != null ? "settings" : envDays != null ? "env" : null,
  };
}

export async function workspacePolicy(workspaceId: string): Promise<PolicyLayer> {
  const row = await prisma.workspacePrivacy.findUnique({ where: { workspaceId } });
  if (!row) return OPEN_LAYER;
  return {
    allowedProviders: providers(row.allowedProviders),
    allowedHosts: row.allowedHosts,
    localOnly: row.localOnly,
    retentionDays: row.retentionDays,
  };
}

// The shorter of two retention periods, where null is forever.
export function shorterRetention(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

// The workspace can only narrow the instance: local-only if either says so,
// the shorter retention, and a model must pass both layers' lists (checked in
// checkModel rather than merged, so wildcards need no intersecting).
export function mergePolicy(instance: InstancePolicy, workspace: PolicyLayer): EffectivePolicy {
  return {
    instance,
    workspace,
    localOnly: instance.localOnly || workspace.localOnly,
    retentionDays: shorterRetention(instance.retentionDays, workspace.retentionDays),
  };
}

// Read on every job, uncached, so a policy change applies to the next call.
export async function policyFor(workspaceId: string): Promise<EffectivePolicy> {
  const [instance, workspace] = await Promise.all([instancePolicy(), workspacePolicy(workspaceId)]);
  return mergePolicy(instance, workspace);
}

export interface LlmTarget {
  model: string;
  provider: ProviderName;
  hostname: string;
  port: string;
  // hostname[:port], the port only when it is not the scheme's default.
  host: string;
}

function hostOf(baseUrl: string) {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === "http:" ? "80" : "443");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return { hostname, port, host: url.host };
}

// Where a model's requests go, decided as languageModel() decides it: the
// selected endpoint, the provider's stored base URL, or its official API.
// Ollama without a base URL would reach OpenAI's default host through the
// OpenAI client, so it is treated as that.
export function targetOf(endpoint: Endpoint | undefined, baseUrls: ProviderBaseUrls) {
  return (model: string): LlmTarget => {
    const provider = providerOf(model);
    const official = OFFICIAL_BASE_URLS[provider === "ollama" ? "openai" : provider];
    return { model, provider, ...hostOf(endpoint?.baseUrl ?? baseUrls[provider] ?? official) };
  };
}

// A connection's host before any model is named, for the dashboard's checks.
export function connectionTarget(provider: ProviderName, baseUrl?: string | null): LlmTarget {
  const official = OFFICIAL_BASE_URLS[provider === "ollama" ? "openai" : provider];
  return { model: provider, provider, ...hostOf(baseUrl ?? official) };
}

// Lowercase, no scheme or path, IPv6 literals bracketed: the form patterns are
// stored and compared in.
export function normalizeHostPattern(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

function splitPattern(pattern: string): { name: string; port?: string } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(pattern);
  if (bracketed) return { name: bracketed[1]!, port: bracketed[2] };
  const [name, port] = pattern.split(":");
  return { name: name!, port };
}

// `example.com` matches that host only, `*.example.com` any host below it
// (not the apex), and a `:port` must match too when one is given.
export function hostMatches(pattern: string, target: Pick<LlmTarget, "hostname" | "port">): boolean {
  const { name, port } = splitPattern(normalizeHostPattern(pattern));
  if (port && port !== target.port) return false;
  const hostname = target.hostname.toLowerCase();
  if (name.startsWith("*.")) return hostname.endsWith(name.slice(1));
  return hostname === name;
}

export const POLICY_PREFIX = "Blocked by privacy policy:";

export class PolicyViolation extends Error {
  constructor(
    readonly scope: "instance" | "workspace",
    readonly rule: "provider" | "host" | "local_only",
    readonly model: string,
    readonly host: string,
    allowed: string[] = [],
  ) {
    super(violationMessage(scope, rule, model, host, allowed));
    this.name = "PolicyViolation";
  }
}

function violationMessage(
  scope: PolicyViolation["scope"],
  rule: PolicyViolation["rule"],
  model: string,
  host: string,
  allowed: string[],
): string {
  // A bare provider stands for a connection checked before any model is named.
  const subject = model.includes("/") ? `model ${model}` : `the ${model} connection`;
  if (rule === "local_only") {
    return (
      `${POLICY_PREFIX} local-only mode is on, and ${subject} would send requests to ${host}, ` +
      "which is not a local endpoint. Use an Ollama or internal connection."
    );
  }
  const by = scope === "instance" ? "the instance settings" : "this workspace's privacy settings";
  if (rule === "provider") {
    return (
      `${POLICY_PREFIX} provider "${model.split("/")[0]}" (${subject}) is not allowed by ${by}. ` +
      `Allowed providers: ${allowed.join(", ")}.`
    );
  }
  return `${POLICY_PREFIX} host ${host} (${subject}) is not allowed by ${by}. Allowed hosts: ${allowed.join(", ")}.`;
}

// The list rules of one layer; local-only is checked once for both.
function checkLayer(layer: PolicyLayer, scope: PolicyViolation["scope"], target: LlmTarget): PolicyViolation | null {
  if (layer.allowedProviders.length && !layer.allowedProviders.includes(target.provider)) {
    return new PolicyViolation(scope, "provider", target.model, target.host, layer.allowedProviders);
  }
  if (layer.allowedHosts.length && !layer.allowedHosts.some((pattern) => hostMatches(pattern, target))) {
    return new PolicyViolation(scope, "host", target.model, target.host, layer.allowedHosts);
  }
  return null;
}

// Whether one model may be called; the instance is reported first when both
// layers refuse it.
export async function checkModel(
  policy: EffectivePolicy,
  target: LlmTarget,
  resolve?: Resolve,
): Promise<PolicyViolation | null> {
  const listed = checkLayer(policy.instance, "instance", target) ?? checkLayer(policy.workspace, "workspace", target);
  if (listed) return listed;
  if (policy.localOnly && !(await isInternalHost(target.hostname, resolve))) {
    const scope = policy.instance.localOnly ? "instance" : "workspace";
    return new PolicyViolation(scope, "local_only", target.model, target.host);
  }
  return null;
}

export interface ModelGuard {
  // Synchronous, for the call path: throws for a refused model and for any
  // model that was not checked up front (fail closed).
  allow(model: string): void;
  rejected: Map<string, PolicyViolation>;
  target: (model: string) => LlmTarget;
}

// Checks every model a run may call once, before any request goes out.
export async function guardModels(
  policy: EffectivePolicy,
  models: string[],
  endpoint: Endpoint | undefined,
  baseUrls: ProviderBaseUrls,
  resolve?: Resolve,
): Promise<ModelGuard> {
  const target = targetOf(endpoint, baseUrls);
  const checked = new Set<string>();
  const rejected = new Map<string, PolicyViolation>();
  for (const model of new Set(models)) {
    const violation = await checkModel(policy, target(model), resolve);
    checked.add(model);
    if (violation) rejected.set(model, violation);
  }
  return {
    target,
    rejected,
    allow(model) {
      const violation = rejected.get(model);
      if (violation) throw violation;
      if (!checked.has(model)) {
        throw new Error(`${POLICY_PREFIX} model ${model} was not checked against the privacy policy`);
      }
    },
  };
}

// Whether every host `inner` matches is also matched by `outer`, so a
// workspace pattern can be checked against the instance list without
// computing an intersection.
export function patternCovers(outer: string, inner: string): boolean {
  const o = splitPattern(normalizeHostPattern(outer));
  const i = splitPattern(normalizeHostPattern(inner));
  if (o.port && o.port !== i.port) return false;
  if (!i.name.startsWith("*.")) return hostMatches(outer, { hostname: i.name, port: i.port ?? o.port ?? "" });
  return o.name.startsWith("*.") && i.name.slice(1).endsWith(o.name.slice(1));
}
