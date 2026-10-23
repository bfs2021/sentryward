import { describe, expect, it } from "vitest";
import type { LlmUsage } from "../src/review/core/models.ts";
import { addUsage, callCost, priceFor, usageByModel } from "../src/review/core/pricing/pricing.ts";
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

  it("has no price for a model nothing matches", () => {
    expect(priceFor("ollama/llama3")).toBeNull();
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

  it("merges per-model totals across runs", () => {
    const run = (usd: number) =>
      usageByModel([call("a/x", 1, 1, { cost: { input: usd, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: usd } })]);
    const total = addUsage(run(0.1), run(0.2));
    expect(total["a/x"]).toMatchObject({ calls: 2, inputTokens: 2, cost: { input: 0.3, total: 0.3 } });
  });
});
