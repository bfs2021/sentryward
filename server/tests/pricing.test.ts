import { describe, expect, it } from "vitest";
import type { LlmUsage } from "../src/review/core/models.ts";
import { addUsage, callCost, callPricing, priceFor, priceUsage, usageByModel } from "../src/review/core/pricing/pricing.ts";
import { MODEL_PRICING } from "../src/review/core/pricing/table.ts";

const SONNET = MODEL_PRICING["claude-sonnet-5-5"]!;

describe("priceFor", () => {
  it("matches the model id without its provider prefix", () => {
    expect(priceFor("anthropic/claude-sonnet-5-5")).toBe(SONNET);
    expect(priceFor("claude-sonnet-5-5")).toBe(SONNET);
  });

  it("matches a router id by its last segment and without an effort suffix", () => {
    expect(priceFor("openai/cx/gpt-5.6-sol(medium)")).toBe(MODEL_PRICING["gpt-5.6-sol"]);
  });

  it("falls back to the first matching pattern", () => {
    // Not listed by name; "claude-opus-*" comes before the generic "claude-*".
    expect(priceFor("anthropic/claude-opus-9")).toEqual({ input: 5, output: 25, cached: 0.5, cacheWrite: 6.25, reasoning: 25 });
  });

  it("prices an Ollama model at nothing, even one named like a hosted model", () => {
    for (const model of ["ollama/qwen3-coder:30b", "ollama/deepseek-r1:14b", "ollama/glm-4.6", "ollama/auto"]) {
      expect(priceFor(model)).toEqual({ input: 0, output: 0 });
    }
  });

  it("prefers the workspace's own price: the configured id, then without its prefix", () => {
    const own = { input: 1, output: 2 };
    expect(priceFor("anthropic/claude-sonnet-5-5", { "anthropic/claude-sonnet-5-5": own })).toBe(own);
    expect(priceFor("openai/cx/claude-sonnet-5-5(high)", { "claude-sonnet-5-5": own })).toBe(own);
    expect(priceFor("ollama/llama3", { "ollama/llama3": own })).toBe(own);
    expect(priceFor("anthropic/claude-sonnet-5-5", { "openai/other": own })).toBe(SONNET);
  });

  it("matches a router id's own price without its provider prefix, before its last segment", () => {
    const routed = { input: 1, output: 4 };
    const bare = { input: 9, output: 9 };
    expect(priceFor("openai/cx/gpt-5.6-sol(medium)", { "cx/gpt-5.6-sol": routed })).toBe(routed);
    expect(priceFor("openai/cx/gpt-5.6-sol(medium)", { "gpt-5.6-sol": bare, "cx/gpt-5.6-sol": routed })).toBe(routed);
  });

  it("prices common models without an exact entry by their own family", () => {
    expect(priceFor("openai/o3-mini-2025-01-31")).toMatchObject({ input: 1.1, output: 4.4 });
    expect(priceFor("openai/gpt-4o-2024-08-06")).toEqual(priceFor("openai/gpt-4o"));
    expect(priceFor("openai/gpt-4o-mini-2024-07-18")).toMatchObject({ input: 0.15, output: 0.6 });
    expect(priceFor("anthropic/claude-3-5-haiku-latest")).toMatchObject({ input: 0.8, output: 4 });
    expect(priceFor("anthropic/claude-3-haiku-x")).toMatchObject({ input: 0.25, output: 1.25 });
    expect(priceFor("openai/gpt-4.1-2025-04-14")).toMatchObject({ input: 2, output: 8 });
  });

  it("has no price for a model nothing matches", () => {
    expect(priceFor("openai/my-proxy-model")).toBeNull();
    // Never an Object.prototype member.
    expect(priceFor("openai/constructor")).toBeNull();
  });
});

describe("callCost", () => {
  it("bills uncached input, cache reads, cache writes, output and reasoning at their own rates", () => {
    const cost = callCost(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        cacheWriteTokens: 100_000,
        outputTokens: 200_000,
        reasoningTokens: 50_000,
      },
      { input: 2, output: 10, cached: 0.2, cacheWrite: 2.5, reasoning: 12 },
    );
    expect(cost).toEqual({
      // 500k uncached at $2
      input: 1,
      // 400k at $0.20
      cached: 0.08,
      // 100k at $2.50
      cacheWrite: 0.25,
      // The 150k non-reasoning output at $10: reasoning is part of the output, not on top.
      output: 1.5,
      // 50k at $12
      reasoning: 0.6,
      total: 3.43,
    });
  });

  it("bills cache and reasoning tokens at the input and output rates when a price has none", () => {
    const cost = callCost(
      { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000, reasoningTokens: 100_000 },
      { input: 2, output: 8 },
    );
    expect(cost).toMatchObject({ input: 1, cached: 1, output: 0, reasoning: 0.8, total: 2.8 });
  });

  it("costs nothing without a price", () => {
    expect(callCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, null)).toEqual({
      input: 0,
      cached: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    });
  });
});

describe("callPricing and priceUsage", () => {
  it("flags a call no price is known for instead of costing it nothing", () => {
    expect(callPricing({ inputTokens: 10, outputTokens: 10 }, null)).toEqual({ unpriced: true });
    expect(callPricing({ inputTokens: 1_000_000, outputTokens: 0 }, { input: 3, output: 0 })).toMatchObject({ cost: { total: 3 } });
  });

  it("re-prices every call at the workspace's prices, replacing what the call recorded", () => {
    const priced = priceUsage(
      [
        call("anthropic/claude-sonnet-5-5", 1_000_000, 0, { cost: callCost({ inputTokens: 1_000_000, outputTokens: 0 }, SONNET) }),
        call("openai/my-proxy", 1_000_000, 0, { unpriced: true }),
        call("openai/unknown", 1_000_000, 0),
      ],
      { "anthropic/claude-sonnet-5-5": { input: 1, output: 1 }, "my-proxy": { input: 4, output: 4 } },
    );
    expect(priced[0]).toMatchObject({ cost: { total: 1 } });
    expect(priced[0]).not.toHaveProperty("unpriced");
    expect(priced[1]).toMatchObject({ cost: { total: 4 } });
    expect(priced[1]).not.toHaveProperty("unpriced");
    expect(priced[2]).toMatchObject({ unpriced: true });
    expect(priced[2]).not.toHaveProperty("cost");
  });
});

const call = (model: string, inputTokens: number, outputTokens: number, extra: Partial<LlmUsage> = {}): LlmUsage => ({
  purpose: "review",
  model,
  inputTokens,
  outputTokens,
  latencyMs: 1,
  ...extra,
});

describe("usageByModel and addUsage", () => {
  it("sums each model's tokens and recorded costs separately", () => {
    const cost = callCost({ inputTokens: 1_000_000, outputTokens: 0 }, SONNET);
    const byModel = usageByModel([
      call("anthropic/claude-sonnet-5-5", 1_000_000, 0, { cachedInputTokens: 10, cost }),
      call("anthropic/claude-sonnet-5-5", 1_000_000, 0, { cost }),
      call("ollama/llama3", 5, 5),
    ]);
    expect(byModel["anthropic/claude-sonnet-5-5"]).toMatchObject({
      calls: 2,
      inputTokens: 2_000_000,
      cachedInputTokens: 10,
      cost: { input: 4, total: 4 },
    });
    // A call stored before costs were recorded adds tokens and no cost.
    expect(byModel["ollama/llama3"]).toMatchObject({ calls: 1, inputTokens: 5, cost: { total: 0 } });
  });

  it("sums each model's call time and the calls no price was known for", () => {
    const byModel = usageByModel([
      call("a/x", 1, 1, { latencyMs: 300, unpriced: true }),
      call("a/x", 1, 1, { latencyMs: 100 }),
    ]);
    expect(byModel["a/x"]).toMatchObject({ calls: 2, latencyMs: 400, unpricedCalls: 1 });
  });

  it("merges per-model totals across runs", () => {
    const run = (usd: number) =>
      usageByModel([call("a/x", 1, 1, { cost: { input: usd, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: usd } })]);
    const total = addUsage(run(0.1), run(0.2));
    expect(total["a/x"]).toMatchObject({ calls: 2, inputTokens: 2, cost: { input: 0.3, total: 0.3 } });
  });
});
