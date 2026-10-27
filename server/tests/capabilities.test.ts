import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { app } from "../src/app.ts";
import { DEFAULT_CONFIG, type Config } from "../src/review/config/schema.ts";
import { effectiveCapabilities, memoryLedger, nativeDefaults } from "../src/review/llm/capabilities.ts";
import { createGenerate, TEMPERATURE_WITH_THINKING, thinkingUnavailable } from "../src/review/llm/providers.ts";
import { encrypt } from "../src/lib/crypto.ts";
import { prisma } from "../src/lib/prisma.ts";
import { capabilityLedgerFor, endpointOf } from "../src/services/llmCapabilities.ts";
import { probeModel } from "../src/services/llmProbe.ts";
import { prepareCapabilities, type Probe } from "../src/worker/capabilities.ts";
import { fetchStub, type StubRoute } from "./helpers/fetchStub.ts";
import { createUser } from "./helpers/users.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ask = (model: string, thinking?: "low" | "medium" | "high") => ({
  model,
  system: "s",
  prompt: "p",
  schema: z.object({ ok: z.boolean() }),
  schemaName: "result",
  temperature: 0.2,
  maxOutputTokens: 1000,
  ...(thinking ? { thinking } : {}),
});

// An OpenAI chat-completions stream: optional reasoning tokens in the usage,
// optional tool-call deltas instead of text.
function chatStream(options: { content?: string; reasoningTokens?: number; toolArgs?: string[] } = {}) {
  const chunk = (extra: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", ...extra })}`;
  const deltas = options.toolArgs
    ? options.toolArgs.map((args, i) =>
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  i === 0
                    ? { index: 0, id: "call_1", type: "function", function: { name: "ping", arguments: args } }
                    : { index: 0, function: { arguments: args } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      )
    : [chunk({ choices: [{ index: 0, delta: { role: "assistant", content: options.content ?? '{"ok":true}' }, finish_reason: null }] })];
  return [
    ...deltas,
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: options.toolArgs ? "tool_calls" : "stop" }] }),
    chunk({
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        ...(options.reasoningTokens ? { completion_tokens_details: { reasoning_tokens: options.reasoningTokens } } : {}),
      },
    }),
    "data: [DONE]",
    "",
  ].join("\n\n");
}

const ROUTER = /^http:\/\/router\.test\/v1\/chat\/completions$/;
const stream = (body: string, times?: number): StubRoute => ({
  method: "POST",
  url: ROUTER,
  body,
  headers: { "content-type": "text/event-stream" },
  ...(times ? { times } : {}),
});
const router = { baseUrl: "http://router.test/v1", apiKey: "k" };

describe("capability precedence", () => {
  it("seeds native models from their family and leaves the rest unknown", () => {
    expect(nativeDefaults("anthropic/claude-sonnet-5-5")).toEqual({ thinking: "options", tools: true });
    expect(nativeDefaults("anthropic/claude-3-5-haiku-latest")).toEqual({ thinking: "none", tools: true });
    expect(nativeDefaults("openai/gpt-4o")).toMatchObject({ thinking: "none" });
    expect(nativeDefaults("google/gemini-2.5-pro")).toMatchObject({ thinking: "options" });
    expect(nativeDefaults("ollama/qwen3")).toEqual({});
  });

  it("puts the setting over detection, and detection over the table", () => {
    const model = "anthropic/claude-sonnet-5-5";
    expect(effectiveCapabilities(model, { native: true, detected: { thinking: "none" } }).thinking).toBe("none");
    expect(
      effectiveCapabilities(model, {
        native: true,
        detected: { thinking: "none" },
        override: { thinking: "options", tools: "auto" },
      }).thinking,
    ).toBe("options");
    // Behind a base URL nothing is assumed.
    expect(effectiveCapabilities(model, { native: false })).toEqual({ thinking: undefined, tools: undefined });
  });

  it("keeps only observations that change what is known", () => {
    const { ledger, observations } = memoryLedger({ "openai/x": { thinking: "none" } });
    ledger.observe({ model: "openai/x", capabilities: { thinking: "none" }, source: "runtime" });
    ledger.observe({ model: "openai/x", capabilities: { tools: true }, source: "runtime" });
    expect(observations).toHaveLength(1);
    expect(ledger.get("openai/x")).toEqual({ thinking: "none", tools: true });
  });
});

describe("thinking behind a base URL", () => {
  it("sends the effort, leaves out temperature and adds the budget to the output limit", async () => {
    const { fetch, calls } = fetchStub([stream(chatStream({ reasoningTokens: 30 }))]);
    vi.stubGlobal("fetch", fetch);
    const { ledger, observations } = memoryLedger();

    const response = await createGenerate({}, router, {}, { ledger })(ask("openai/gpt-x", "medium"));

    const body = JSON.parse(calls[0]!.body!);
    expect(body.reasoning_effort).toBe("medium");
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(1000 + 8000);
    expect(response.warnings).toEqual([TEMPERATURE_WITH_THINKING]);
    expect(observations).toEqual([{ model: "openai/gpt-x", capabilities: { thinking: "options" }, source: "runtime" }]);
  });

  it("retries once without the options an endpoint rejects, and remembers", async () => {
    const { fetch, calls } = fetchStub([
      { method: "POST", url: ROUTER, status: 400, body: { error: { message: "Unrecognized request argument: reasoning_effort" } }, times: 1 },
      stream(chatStream()),
    ]);
    vi.stubGlobal("fetch", fetch);
    const { ledger, observations } = memoryLedger();

    const response = await createGenerate({}, router, {}, { ledger })(ask("openai/gpt-x", "high"));

    expect(calls).toHaveLength(2);
    const retry = JSON.parse(calls[1]!.body!);
    expect(retry.reasoning_effort).toBeUndefined();
    expect(retry.temperature).toBe(0.2);
    expect(response.object).toEqual({ ok: true });
    expect(response.failedAttempts).toHaveLength(1);
    expect(response.warnings).toContain(thinkingUnavailable("openai/gpt-x"));
    expect(observations[0]).toMatchObject({ capabilities: { thinking: "none" }, source: "runtime" });
    expect(observations[0]!.detail).toMatch(/Rejected thinking options/);
  });

  it("does not retry a 400 about something else", async () => {
    const { fetch, calls } = fetchStub([
      { method: "POST", url: ROUTER, status: 400, body: { error: { message: "prompt is too long" } } },
    ]);
    vi.stubGlobal("fetch", fetch);

    await expect(createGenerate({}, router)(ask("openai/gpt-x", "high"))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("warns when an endpoint ignores the options", async () => {
    vi.stubGlobal("fetch", fetchStub([stream(chatStream())]).fetch);
    const { ledger } = memoryLedger();

    const response = await createGenerate({}, router, {}, { ledger })(ask("ollama/qwen3", "low"));

    expect(response.warnings).toContain(thinkingUnavailable("ollama/qwen3"));
    expect(ledger.get("ollama/qwen3")).toEqual({ thinking: "none" });
  });

  it("sends nothing to a model recorded without thinking", async () => {
    const { fetch, calls } = fetchStub([stream(chatStream())]);
    vi.stubGlobal("fetch", fetch);
    const { ledger } = memoryLedger({ "openai/gpt-x": { thinking: "none" } });

    const response = await createGenerate({}, router, {}, { ledger })(ask("openai/gpt-x", "high"));

    const body = JSON.parse(calls[0]!.body!);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(1000);
    expect(response.warnings).toEqual([thinkingUnavailable("openai/gpt-x")]);
  });

  it("only sizes the output for a model that thinks by itself", async () => {
    const { fetch, calls } = fetchStub([stream(chatStream())]);
    vi.stubGlobal("fetch", fetch);

    await createGenerate({}, router, {}, { override: { thinking: "model", tools: "auto" } })(
      ask("openai/cx/claude-sonnet-5-5-thinking", "low"),
    );

    const body = JSON.parse(calls[0]!.body!);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(3000);
  });
});

describe("thinking on an official API", () => {
  const MESSAGES = /^https:\/\/api\.anthropic\.com\/v1\/messages$/;
  const message = (content: unknown[]) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 50 },
  });

  it("sends Anthropic thinking without forcing a tool and parses the text", async () => {
    const { fetch, calls } = fetchStub([
      {
        method: "POST",
        url: MESSAGES,
        body: message([
          { type: "thinking", thinking: "Let me check.", signature: "sig" },
          { type: "text", text: '{"ok":true}' },
        ]),
      },
    ]);
    vi.stubGlobal("fetch", fetch);

    const response = await createGenerate({ anthropic: "sk-ant" })(ask("anthropic/claude-sonnet-5-5", "low"));

    const body = JSON.parse(calls[0]!.body!);
    // The SDK turns a budget into adaptive thinking on models that want it.
    expect(["enabled", "adaptive"]).toContain(body.thinking.type);
    expect(body.max_tokens).toBe(3000);
    expect(body.temperature).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(response.object).toEqual({ ok: true });
    expect(response.warnings).toEqual([TEMPERATURE_WITH_THINKING]);
  });

  it("does not take a native reply without reasoning as ignored options", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStub([{ method: "POST", url: MESSAGES, body: message([{ type: "text", text: '{"ok":true}' }]) }]).fetch,
    );
    const { ledger } = memoryLedger();

    const response = await createGenerate({ anthropic: "sk-ant" }, undefined, {}, { ledger })(
      ask("anthropic/claude-sonnet-5-5", "low"),
    );

    expect(response.object).toEqual({ ok: true });
    expect(response.warnings).toEqual([TEMPERATURE_WITH_THINKING]);
    expect(ledger.get("anthropic/claude-sonnet-5-5")).toEqual({});
  });

  it("runs a native model without thinking support as asked, minus thinking", async () => {
    const { fetch, calls } = fetchStub([
      {
        method: "POST",
        url: MESSAGES,
        body: message([{ type: "tool_use", id: "t1", name: "json", input: { ok: true } }]),
      },
    ]);
    vi.stubGlobal("fetch", fetch);

    const response = await createGenerate({ anthropic: "sk-ant" })(ask("anthropic/claude-3-5-haiku-latest", "high"));

    const body = JSON.parse(calls[0]!.body!);
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(1000);
    expect(response.warnings).toEqual([thinkingUnavailable("anthropic/claude-3-5-haiku-latest")]);
  });
});

describe("probeModel", () => {
  it("records thinking and tools that work", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStub([stream(chatStream({ content: "391", reasoningTokens: 12 }), 1), stream(chatStream({ toolArgs: ['{"value":', '"ok"}'] }))]).fetch,
    );

    const probe = await probeModel("openai/gpt-x", {}, router);

    expect(probe.capabilities).toEqual({ thinking: "options", tools: true });
    expect(probe.spent).toHaveLength(2);
  });

  it("records tools as stripped when text comes back", async () => {
    vi.stubGlobal("fetch", fetchStub([stream(chatStream({ content: "391" }))]).fetch);

    const probe = await probeModel("ollama/qwen3", {}, undefined, { ollama: "http://router.test/v1" });

    expect(probe.capabilities).toEqual({ thinking: "none", tools: false });
    expect(probe.detail).toMatch(/ignored.*stripped/);
  });

  it("records tools as broken when streamed deltas do not make a call", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStub([stream(chatStream({ content: "391" }), 1), stream(chatStream({ toolArgs: ['{"value":', "oops"] }))]).fetch,
    );

    const probe = await probeModel("openai/gpt-x", {}, router);

    expect(probe.capabilities.tools).toBe(false);
  });

  it("keeps both answers unknown when the host times out", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    const probe = await probeModel("openai/gpt-x", {}, router);

    expect(probe.capabilities).toEqual({});
    expect(probe.detail).toMatch(/thinking unknown.*tools unknown/);
  });

  it("records thinking as refused and keeps an unrelated failure unknown", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStub([
        { method: "POST", url: ROUTER, status: 400, body: { error: { message: "thinking is not supported" } }, times: 1 },
        stream(chatStream({ content: "391" }), 1),
        { method: "POST", url: ROUTER, status: 500, body: { error: { message: "busy" } } },
      ]).fetch,
    );

    const probe = await probeModel("openai/gpt-x", {}, router);

    expect(probe.capabilities).toEqual({ thinking: "none" });
    expect(probe.detail).toMatch(/refused.*tools unknown/);
  });
});

describe("stored capabilities", () => {
  let cookie: string;
  let workspaceId: string;

  beforeEach(async () => {
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    ({ cookie, workspace: { id: workspaceId } } = await createUser());
  });

  const row = (model: string, endpoint: string, extra: Record<string, unknown> = {}) =>
    prisma.llmCapability.create({
      data: { workspaceId, provider: model.split("/")[0]!, endpoint, model, source: "probe", thinking: "options", tools: true, ...extra },
    });

  it("seeds a ledger with the rows for the endpoint each model is reached at", async () => {
    await row("openai/gpt-x", "http://router.test/v1");
    await row("openai/gpt-y", "");
    const { ledger, known } = await capabilityLedgerFor(workspaceId, endpointOf(router, {}));
    expect(ledger.get("openai/gpt-x")).toEqual({ thinking: "options", tools: true });
    expect(known("openai/gpt-y")).toBe(false);
  });

  it("probes a model the review needs to know about once, and stores the answer", async () => {
    const config: Config = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, model: "openai/gpt-x", thinking: "medium" } };
    const probe = vi.fn<Probe>(async () => ({
      capabilities: { thinking: "none" as const, tools: false },
      detail: "thinking options were ignored; tools were stripped: the reply was text",
      spent: [{ model: "openai/gpt-x", inputTokens: 5, outputTokens: 1, latencyMs: 3 }],
    }));
    const prepare = () =>
      prepareCapabilities({ workspaceId, config, keys: {}, endpoint: router, baseUrls: {}, probe, warnings: [] });

    const first = await prepare();
    expect(first.ledger.get("openai/gpt-x")).toEqual({ thinking: "none", tools: false });
    expect(first.usage).toEqual([expect.objectContaining({ purpose: "probe", model: "openai/gpt-x", inputTokens: 5 })]);
    await first.persist();

    const second = await prepare();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(second.usage).toEqual([]);
    const stored = await prisma.llmCapability.findFirstOrThrow({ where: { workspaceId, model: "openai/gpt-x" } });
    expect(stored).toMatchObject({ endpoint: "http://router.test/v1", thinking: "none", tools: false, source: "probe" });
  });

  it("stores a probe that answered nothing, and asks again only after a day", async () => {
    const config: Config = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, model: "openai/gpt-x", thinking: "medium" } };
    const probe = vi.fn<Probe>(async () => ({
      capabilities: {},
      detail: "thinking unknown (busy); tools unknown (busy)",
      spent: [],
    }));
    const prepare = async () => {
      const prepared = await prepareCapabilities({ workspaceId, config, keys: {}, endpoint: router, baseUrls: {}, probe, warnings: [] });
      await prepared.persist();
      return prepared;
    };

    await prepare();
    await prepare();
    expect(probe).toHaveBeenCalledTimes(1);
    const stored = await prisma.llmCapability.findFirstOrThrow({ where: { workspaceId, model: "openai/gpt-x" } });
    expect(stored).toMatchObject({ thinking: null, tools: null, detail: "thinking unknown (busy); tools unknown (busy)" });

    await prisma.llmCapability.update({
      where: { id: stored.id },
      data: { checkedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });
    await prepare();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("probes the models a review needs at the same time", async () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, model: "openai/gpt-x", fallbackModels: ["openai/gpt-y"], thinking: "medium" },
    };
    let running = 0;
    let peak = 0;
    const probe = vi.fn<Probe>(async (model) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { capabilities: { thinking: "options" as const }, detail: model, spent: [] };
    });

    const prepared = await prepareCapabilities({ workspaceId, config, keys: {}, endpoint: router, baseUrls: {}, probe, warnings: [] });

    expect(peak).toBe(2);
    expect(prepared.ledger.get("openai/gpt-y")).toEqual({ thinking: "options" });
  });

  it("does not probe when nothing needs an answer, or the table has one", async () => {
    const probe = vi.fn<Probe>();
    await prepareCapabilities({ workspaceId, config: DEFAULT_CONFIG, keys: {}, endpoint: router, baseUrls: {}, probe, warnings: [] });
    const native: Config = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, thinking: "high" } };
    await prepareCapabilities({ workspaceId, config: native, keys: { anthropic: "k" }, endpoint: undefined, baseUrls: {}, probe, warnings: [] });
    expect(probe).not.toHaveBeenCalled();
  });

  it("turns a failed probe into a warning", async () => {
    const config: Config = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, model: "openai/gpt-x", thinking: "low" } };
    const warnings: string[] = [];
    await prepareCapabilities({
      workspaceId,
      config,
      keys: {},
      endpoint: router,
      baseUrls: {},
      probe: async () => {
        throw new Error("host down");
      },
      warnings,
    });
    expect(warnings).toEqual(["Could not check what openai/gpt-x supports: host down"]);
  });

  it("lists a connection's rows by host and forgets them when it is saved or removed", async () => {
    await prisma.llmCredential.create({
      data: { workspaceId, provider: "openai", encryptedKey: encrypt("sk-secret-1234"), baseUrl: "http://router.test/v1" },
    });
    await row("anthropic/claude-x", "http://router.test/v1", { detail: "thinking options work" });
    await row("openai/gpt-y", "");

    const listed = await request(app).get("/api/settings/api-keys/openai/capabilities").set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.capabilities).toEqual([
      expect.objectContaining({ model: "anthropic/claude-x", endpoint: "http://router.test/v1", thinking: "options", tools: true }),
    ]);

    vi.stubGlobal("fetch", fetchStub([{ url: /\/v1\/models$/, body: { data: [] } }]).fetch);
    const saved = await request(app)
      .put("/api/settings/api-keys/openai")
      .set("Cookie", cookie)
      .send({ apiKey: "sk-secret-5678", baseUrl: "http://other.test/v1" });
    expect(saved.status).toBe(200);
    expect(await prisma.llmCapability.count({ where: { workspaceId, endpoint: "http://router.test/v1" } })).toBe(0);
    // Another connection's official-API rows are untouched.
    expect(await prisma.llmCapability.count({ where: { workspaceId } })).toBe(1);
  });

  it("probes a model after a passing test and returns what it found", async () => {
    await prisma.llmCredential.create({
      data: { workspaceId, provider: "openai", encryptedKey: encrypt("sk-secret-1234"), baseUrl: "http://router.test/v1" },
    });
    vi.stubGlobal(
      "fetch",
      fetchStub([
        stream(chatStream(), 1),
        stream(chatStream({ content: "391", reasoningTokens: 9 }), 1),
        stream(chatStream({ toolArgs: ['{"value":"ok"}'] })),
      ]).fetch,
    );

    const res = await request(app)
      .post("/api/settings/api-keys/openai/test")
      .set("Cookie", cookie)
      .send({ model: "openai/gpt-x" });

    expect(res.body.result).toMatchObject({ ok: true, capabilities: { thinking: "options", tools: true } });
    expect(await prisma.llmCapability.findFirst({ where: { workspaceId, model: "openai/gpt-x" } })).toMatchObject({
      endpoint: "http://router.test/v1",
      thinking: "options",
      tools: true,
    });
  });
});

describe("thinking budgets", () => {
  it("keeps the whole reply, thinking included, out of the prompt ceiling", async () => {
    const { diffTokenBudget } = await import("../src/review/context/budget.ts");
    const at = (thinking: Config["llm"]["thinking"], maxTokens = 8000) =>
      ({ ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, contextBudget: null, maxTokens, thinking } }) as Config;
    // A tight window makes the ceiling, not the per-pass cap, the limit.
    const window = 200_000;
    const overhead = window - 8000 - 2000 - 20_000;
    expect(diffTokenBudget(at("off"), overhead)).toBe(20_000);
    expect(diffTokenBudget(at("medium"), overhead)).toBe(12_000);
  });

  it("asks the verifier to think at its own level, with its cap on top of the budget", async () => {
    const { verifyFinding } = await import("../src/review/llm/verify.ts");
    const { makeChangeSet } = await import("./helpers/changeSet.ts");
    const { fakeModel } = await import("./helpers/model.ts");
    const { generate, requests } = fakeModel({ verification: { verdict: "confirmed", reason: "ok" } });
    const config: Config = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, thinking: "high", verifyThinking: "low" } };
    const finding = { file: "src/app.ts", startLine: 11 } as Parameters<typeof verifyFinding>[2];

    await verifyFinding(generate, makeChangeSet(), finding, { diff: "", context: "" }, config);

    expect(requests[0]).toMatchObject({ thinking: "low", maxOutputTokens: 1000 });
  });
});
