import type { Config } from "../review/config/schema.ts";
import type { LlmUsage } from "../review/core/models.ts";
import { effectiveCapabilities } from "../review/llm/capabilities.ts";
import { callUsage, modelChain, type ApiKeys, type Endpoint, type ProviderBaseUrls } from "../review/llm/providers.ts";
import { capabilityLedgerFor, endpointOf } from "../services/llmCapabilities.ts";
import type { probeModel } from "../services/llmProbe.ts";

export type Probe = typeof probeModel;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// What this review needs to know about its models: thinking when it asks for
// it, tools when its passes are agentic. Nothing else is worth a probe.
function needs(config: Config) {
  const verifyLevel = config.llm.verifyThinking ?? config.llm.thinking;
  return {
    thinking: config.llm.thinking !== "off" || (config.review.verify !== "off" && verifyLevel !== "off"),
    tools: config.review.context === "agentic",
  };
}

// The capability ledger a review runs with, after probing each model it needs
// an answer for and has none (the first time a model is used on an endpoint).
// A probe that fails is a warning: the call itself falls back at runtime.
export async function prepareCapabilities(input: {
  workspaceId: string;
  config: Config;
  keys: ApiKeys;
  endpoint: Endpoint | undefined;
  baseUrls: ProviderBaseUrls;
  probe: Probe;
  warnings: string[];
}) {
  const { config } = input;
  const where = endpointOf(input.endpoint, input.baseUrls);
  const stored = await capabilityLedgerFor(input.workspaceId, where);
  const usage: LlmUsage[] = [];
  const wanted = needs(config);
  if (wanted.thinking || wanted.tools) {
    const models = [...new Set([...modelChain(config.llm, "review"), ...modelChain(config.llm, "verify")])];
    for (const model of models) {
      if (stored.known(model)) continue;
      const caps = effectiveCapabilities(model, {
        native: !where(model).endpoint,
        detected: stored.ledger.get(model),
        override: config.llm.capabilities,
      });
      if ((!wanted.thinking || caps.thinking) && (!wanted.tools || caps.tools !== undefined)) continue;
      try {
        const probe = await input.probe(model, input.keys, input.endpoint, input.baseUrls);
        usage.push(
          ...probe.spent.map((tokens) => ({
            purpose: "probe" as const,
            model,
            ...callUsage(tokens),
            latencyMs: tokens.latencyMs,
          })),
        );
        stored.ledger.observe({ model, capabilities: probe.capabilities, source: "probe", detail: probe.detail });
      } catch (err) {
        input.warnings.push(`Could not check what ${model} supports: ${message(err)}`);
      }
    }
  }
  return {
    ledger: stored.ledger,
    usage,
    persist: () =>
      stored.persist().catch((err: unknown) => {
        console.error("[worker] could not store model capabilities", err);
      }),
  };
}
