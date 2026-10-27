import type { Config } from "../config/schema.ts";

// What an endpoint and model support, described by behaviour rather than by
// who serves it. The same question has different answers per model on one
// endpoint (native APIs included: not every model takes thinking options),
// per Ollama model, and per proxy (9router, OmniRoute, LiteLLM, OpenRouter
// and the like differ in whether they forward thinking options, translate them
// across wire formats, or pass tool calls through), and any of them can change
// without notice. So nothing here names a proxy: answers come from probes and
// from what calls actually did, and a built-in table only seeds native models.

// options: the provider's thinking options work. model: the model id thinks
// by itself (e.g. a "-thinking" variant), so only the output budget applies.
// none: no thinking on this model and endpoint.
export const THINKING_SUPPORT = ["options", "model", "none"] as const;
export type ThinkingSupport = (typeof THINKING_SUPPORT)[number];

// Absent fields are unknown: the call tries, and falls back if refused.
export interface ModelCapabilities {
  thinking?: ThinkingSupport;
  tools?: boolean;
}

export type CapabilityOverride = Config["llm"]["capabilities"];

export type CapabilitySource = "probe" | "runtime";

export interface CapabilityObservation {
  model: string;
  capabilities: ModelCapabilities;
  source: CapabilitySource;
  // What was seen, for the dashboard, e.g. "ignored thinking options".
  detail?: string;
}

// The capabilities recorded for one endpoint, keyed by "provider/model". The
// worker loads it from the database and persists what a review observed; the
// engine never touches storage.
export interface CapabilityLedger {
  get(model: string): ModelCapabilities;
  observe(observation: CapabilityObservation): void;
}

export function memoryLedger(initial: Record<string, ModelCapabilities> = {}) {
  const known = new Map(Object.entries(initial));
  const observations: CapabilityObservation[] = [];
  const ledger: CapabilityLedger = {
    get: (model) => known.get(model) ?? {},
    observe(observation) {
      const before = known.get(observation.model) ?? {};
      const after = { ...before, ...observation.capabilities };
      // Only a change is worth storing; a review repeats the same answer once
      // per pass.
      if (after.thinking === before.thinking && after.tools === before.tools) return;
      known.set(observation.model, after);
      observations.push(observation);
    },
  };
  return { ledger, observations };
}

// Starting points for official APIs only, by model family. Probes and calls
// overrule them; an unlisted model is unknown. Ids are matched without the
// provider prefix.
const NATIVE_DEFAULTS: Record<string, [RegExp, ModelCapabilities][]> = {
  anthropic: [
    [/-thinking\b/, { thinking: "model", tools: true }],
    [/^claude-(3-7-|(opus|sonnet|haiku)-[4-9]|[4-9]-)/, { thinking: "options", tools: true }],
    [/^claude-3/, { thinking: "none", tools: true }],
  ],
  openai: [
    [/^(o\d|gpt-5)/, { thinking: "options", tools: true }],
    [/^gpt-(4|3\.5)/, { thinking: "none", tools: true }],
  ],
  google: [
    [/^gemini-(2\.5|[3-9])/, { thinking: "options", tools: true }],
    [/^gemini-(1|2\.0)/, { thinking: "none", tools: true }],
  ],
};

export function nativeDefaults(model: string): ModelCapabilities {
  const slash = model.indexOf("/");
  const rows = NATIVE_DEFAULTS[model.slice(0, slash)] ?? [];
  const id = model.slice(slash + 1);
  return rows.find(([pattern]) => pattern.test(id))?.[1] ?? {};
}

// The user's setting wins, then what was detected, then (official APIs only)
// the table above.
export function effectiveCapabilities(
  model: string,
  input: { native: boolean; detected?: ModelCapabilities; override?: CapabilityOverride },
): ModelCapabilities {
  const defaults = input.native ? nativeDefaults(model) : {};
  const detected = input.detected ?? {};
  const override = input.override;
  return {
    thinking:
      override && override.thinking !== "auto" ? override.thinking : (detected.thinking ?? defaults.thinking),
    tools: override && override.tools !== "auto" ? override.tools : (detected.tools ?? defaults.tools),
  };
}
