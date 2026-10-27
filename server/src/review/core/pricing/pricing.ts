import type { LlmUsage } from "../models.ts";
import { MODEL_PRICING, PATTERN_PRICING } from "./table.ts";

// USD per million tokens. Rates a model lacks fall back to the nearest one:
// cache reads and writes to input, reasoning to output.
export interface ModelPrice {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
  reasoning?: number;
}

// Token counts as the AI SDK reports them: inputTokens includes cache reads
// and writes, outputTokens includes reasoning.
export interface CallTokens {
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
}

// USD per part of a call. Stored with the call when it is made, so a later
// price change leaves it as it was.
export interface CallCost {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

const ZERO: CallCost = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };

// Rounded to a millionth of a dollar so float noise never reaches the API.
export function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

// Compiled once at load: priceFor runs on every model call.
const PATTERNS = PATTERN_PRICING.map(({ pattern, price }) => {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { re: new RegExp(`^${escaped.join(".*")}$`, "i"), price };
});

// A workspace's own prices, keyed by the model as configs name it
// ("provider/model") or by the id without its provider prefix.
export type PriceOverrides = Record<string, ModelPrice>;

// Ollama models run on the user's own hardware: a known price of nothing,
// unlike a model nothing prices, whose cost is unknown.
const FREE: ModelPrice = { input: 0, output: 0 };

// The workspace's own price for the model, then the built-in one: the exact
// id, the id without its provider prefix, then the first matching pattern. A
// router effort suffix such as "(medium)" in "openai/cx/gpt-5.6-sol(medium)"
// names the same model, so it is dropped first. Ollama models cost nothing
// unless the workspace prices them, even when their name matches a hosted
// model's ("ollama/qwen3-coder:30b"). No match is null: the cost is unknown.
export function priceFor(model: string, overrides: PriceOverrides = {}): ModelPrice | null {
  const id = model.replace(/\([^()]*\)$/, "");
  const base = id.split("/").pop()!;
  const own = (table: Record<string, ModelPrice>, key: string) => (Object.hasOwn(table, key) ? table[key]! : null);
  const override = own(overrides, model) ?? own(overrides, id) ?? own(overrides, base);
  if (override) return override;
  if (id.split("/")[0] === "ollama") return FREE;
  const exact = own(MODEL_PRICING, id) ?? own(MODEL_PRICING, base);
  if (exact) return exact;
  return PATTERNS.find(({ re }) => re.test(base) || re.test(id))?.price ?? null;
}

// Each part at its own rate. The AI SDK counts reasoning inside outputTokens,
// so reasoning is billed instead of that share of the output, not on top.
export function callCost(tokens: CallTokens, price: ModelPrice | null): CallCost {
  if (!price) return { ...ZERO };
  const cachedTokens = tokens.cachedInputTokens ?? 0;
  const writeTokens = tokens.cacheWriteTokens ?? 0;
  const reasoningTokens = Math.min(tokens.reasoningTokens ?? 0, tokens.outputTokens);
  const uncached = Math.max(0, tokens.inputTokens - cachedTokens - writeTokens);
  const parts = {
    input: (uncached * price.input) / 1_000_000,
    cached: (cachedTokens * (price.cached ?? price.input)) / 1_000_000,
    cacheWrite: (writeTokens * (price.cacheWrite ?? price.input)) / 1_000_000,
    output: ((tokens.outputTokens - reasoningTokens) * price.output) / 1_000_000,
    reasoning: (reasoningTokens * (price.reasoning ?? price.output)) / 1_000_000,
  };
  const total = parts.input + parts.cached + parts.cacheWrite + parts.output + parts.reasoning;
  return {
    input: roundUsd(parts.input),
    cached: roundUsd(parts.cached),
    cacheWrite: roundUsd(parts.cacheWrite),
    output: roundUsd(parts.output),
    reasoning: roundUsd(parts.reasoning),
    total: roundUsd(total),
  };
}

export function addCost(into: CallCost, from: CallCost): CallCost {
  for (const key of Object.keys(ZERO) as (keyof CallCost)[]) into[key] = roundUsd(into[key] + from[key]);
  return into;
}

// One model's calls summed. The cost is what the calls recorded; calls stored
// before costs were recorded add nothing to it, and unpricedCalls counts those
// no price was known for. latencyMs sums the calls' time; both are absent on
// digests stored before they were kept.
export interface ModelUsage extends CallTokens {
  calls: number;
  cost?: CallCost;
  unpricedCalls?: number;
  latencyMs?: number;
}

export type UsageByModel = Record<string, ModelUsage>;

export function emptyUsage(): ModelUsage {
  return {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cost: { ...ZERO },
    unpricedCalls: 0,
    latencyMs: 0,
  };
}

export function addUsage(into: UsageByModel, from: UsageByModel): UsageByModel {
  for (const [model, usage] of Object.entries(from)) {
    const total = (into[model] ??= emptyUsage());
    total.calls += usage.calls;
    total.inputTokens += usage.inputTokens;
    total.cachedInputTokens = (total.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    total.outputTokens += usage.outputTokens;
    total.reasoningTokens = (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
    if (usage.cost) addCost((total.cost ??= { ...ZERO }), usage.cost);
    total.unpricedCalls = (total.unpricedCalls ?? 0) + (usage.unpricedCalls ?? 0);
    total.latencyMs = (total.latencyMs ?? 0) + (usage.latencyMs ?? 0);
  }
  return into;
}

// Per-model totals of a run, so a run mixing review, walkthrough and verify
// models keeps each model's cost apart.
export function usageByModel(usage: LlmUsage[]): UsageByModel {
  const byModel: UsageByModel = {};
  for (const call of usage) {
    addUsage(byModel, {
      [call.model]: {
        calls: 1,
        inputTokens: call.inputTokens,
        cachedInputTokens: call.cachedInputTokens ?? 0,
        cacheWriteTokens: call.cacheWriteTokens ?? 0,
        outputTokens: call.outputTokens,
        reasoningTokens: call.reasoningTokens ?? 0,
        ...(call.cost ? { cost: call.cost } : {}),
        unpricedCalls: call.unpriced ? 1 : 0,
        latencyMs: call.latencyMs,
      },
    });
  }
  return byModel;
}

// The run's calls priced at the workspace's prices, so a review records what
// the workspace pays rather than the built-in table's figure. A call nothing
// prices records no cost and is flagged instead, so it reads as unknown.
export function priceUsage(usage: LlmUsage[], overrides: PriceOverrides): LlmUsage[] {
  return usage.map(({ cost: _cost, unpriced: _unpriced, ...call }) => ({ ...call, ...callPricing(call, priceFor(call.model, overrides)) }));
}

// The cost fields of a call: its cost, or the flag saying none was known.
export function callPricing(tokens: CallTokens, price: ModelPrice | null): { cost: CallCost } | { unpriced: true } {
  return price ? { cost: callCost(tokens, price) } : { unpriced: true };
}

export function usedTokens(usage: CallTokens): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0;
}
