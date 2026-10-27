import type { JSONValue } from "ai";
import type { THINKING_LEVELS } from "../config/schema.ts";
import type { ProviderName } from "./providers.ts";

// The shape the SDKs take as providerOptions.
export type ProviderOptions = Record<string, Record<string, JSONValue>>;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// Tokens a level may spend reasoning. Anthropic and Google take the budget
// itself; OpenAI takes an effort and spends what it likes, so the budget only
// sizes the output limit there.
const BUDGET: Record<ThinkingLevel, number> = { off: 0, low: 2_000, medium: 8_000, high: 24_000 };

export function thinkingBudget(level: ThinkingLevel | undefined): number {
  return BUDGET[level ?? "off"];
}

// Anthropic counts thinking inside max_tokens and the others count reasoning
// as output, so the answer keeps its own room on top of the budget.
export function effectiveOutputTokens(maxTokens: number, level: ThinkingLevel | undefined): number {
  return maxTokens + thinkingBudget(level);
}

// Keyed by the SDK that speaks to the endpoint, not by who serves it: an
// OpenAI-compatible proxy or Ollama gets the OpenAI option, and passes it on
// or not (see capabilities.ts for how that is found out).
export function thinkingProviderOptions(provider: ProviderName, level: ThinkingLevel): ProviderOptions | undefined {
  if (level === "off") return undefined;
  const budgetTokens = BUDGET[level];
  switch (provider) {
    case "anthropic":
      return { anthropic: { thinking: { type: "enabled", budgetTokens } } };
    case "google":
      return { google: { thinkingConfig: { thinkingBudget: budgetTokens, includeThoughts: true } } };
    case "openai":
    case "ollama":
      return { openai: { reasoningEffort: level } };
  }
}
