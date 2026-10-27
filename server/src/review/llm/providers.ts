import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText, NoObjectGeneratedError, Output, streamText, type LanguageModel } from "ai";
import type { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { LlmUsage } from "../core/models.ts";
import { callCost, priceFor } from "../core/pricing/pricing.ts";
import { effectiveCapabilities, type CapabilityLedger, type CapabilityOverride } from "./capabilities.ts";
import { excerpt, formatInstruction, parseLenient } from "./format.ts";
import { thinkingBudget, thinkingProviderOptions, type ThinkingLevel } from "./thinking.ts";

export const PROVIDERS = ["anthropic", "openai", "google", "ollama"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type ApiKeys = Partial<Record<ProviderName, string>>;
export type ProviderBaseUrls = Partial<Record<ProviderName, string>>;
// A proxy every model call goes to instead of the providers' official APIs,
// with the key to send it when the config picked one.
export interface Endpoint {
  baseUrl: string;
  apiKey?: string;
}

// A proxy such as 9router may need no key, but the SDKs refuse to build a
// client without one.
const NO_KEY = "unused";

export function providerOf(model: string): ProviderName {
  const provider = model.split("/")[0];
  if (!PROVIDERS.includes(provider as ProviderName)) {
    throw new Error(`Unsupported model provider in "${model}"`);
  }
  return provider as ProviderName;
}

// Behind an endpoint no provider is missing a key: the endpoint decides
// whether it needs one.
export function missingKeys(
  models: string[],
  keys: ApiKeys,
  endpoint?: Endpoint,
  baseUrls: ProviderBaseUrls = {},
): ProviderName[] {
  if (endpoint) return [];
  return [...new Set(models.map(providerOf))].filter((provider) => !keys[provider] && !baseUrls[provider]);
}

export interface ResolvedModel {
  model: LanguageModel;
  provider: ProviderName;
  // Whether the provider itself enforces the output schema. Proxies may drop
  // `response_format` silently (9router does), so anything behind a base URL
  // is asked for JSON in the prompt and parsed leniently instead.
  native: boolean;
}

export function languageModel(
  model: string,
  keys: ApiKeys,
  endpoint?: Endpoint,
  baseUrls: ProviderBaseUrls = {},
): ResolvedModel {
  const provider = providerOf(model);
  const modelId = model.slice(provider.length + 1);
  const baseURL = endpoint?.baseUrl ?? baseUrls[provider];
  const apiKey = endpoint
    ? (endpoint.apiKey ?? keys[provider] ?? NO_KEY)
    : (keys[provider] ?? (baseURL ? NO_KEY : undefined));
  if (!apiKey) throw new Error(`No API key for ${provider}`);
  const native = !baseURL;
  switch (provider) {
    case "anthropic":
      return { model: createAnthropic({ apiKey, baseURL })(modelId), provider, native };
    case "openai": {
      const openai = createOpenAI({ apiKey, baseURL });
      // OpenAI-compatible proxies speak chat completions, not the Responses API
      // the SDK defaults to.
      return { model: baseURL ? openai.chat(modelId) : openai(modelId), provider, native };
    }
    case "google":
      return { model: createGoogleGenerativeAI({ apiKey, baseURL })(modelId), provider, native };
    case "ollama": {
      const ollama = createOpenAI({ apiKey, baseURL });
      return { model: ollama.chat(modelId), provider, native: false };
    }
  }
}

// A 400 that names one of the options we added, as opposed to one about the
// prompt itself. Only then is the call worth repeating without them.
export const THINKING_PARAMS = /thinking|reasoning|budget|effort|temperature/i;
// Narrower than "mentions tools": a 400 about a tool's schema or about
// tool_use/tool_result pairing names tools too, but says nothing about whether
// the endpoint takes them, and what matches here is remembered.
export const TOOLS_UNSUPPORTED =
  /\b(tools?|tool_choice|function[ _]?call(ing|s)?)\b[^.]*\b(not supported|unsupported|not available|not allowed|unrecognized|unknown)\b|\b(does not|doesn't|do not|cannot) support\b[^.]*\b(tools?|function[ _]?call(ing|s)?)\b|\b(unrecognized|unknown|unsupported|extra)\b[^.]*\b(tools|tool_choice)\b/i;

export function rejectsParams(err: unknown, params: RegExp): boolean {
  if (!APICallError.isInstance(err) || err.statusCode !== 400) return false;
  return params.test(`${err.message} ${err.responseBody ?? ""}`);
}

// One wording for every way thinking turns out unavailable (refused, ignored,
// recorded as unsupported), so a review lists it once however many calls hit it.
export function thinkingUnavailable(model: string): string {
  return `Thinking is not available for ${model} on this connection, so it ran without it`;
}
export const TEMPERATURE_WITH_THINKING = "Temperature is not sent while thinking is on: providers reject or ignore it";

export interface GenerateRequest<T> {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  temperature: number;
  // The answer's own room; thinking adds its budget on top.
  maxOutputTokens: number;
  // Absent or "off" means no thinking.
  thinking?: ThinkingLevel;
  // Fixes predictable model mistakes in a reply the provider did not enforce
  // the schema on, before it is validated.
  repair?: (raw: unknown) => unknown;
  // Cancels the request, e.g. when the PR/MR is closed mid-review.
  abortSignal?: AbortSignal;
}

export interface GenerateResponse<T> {
  object: T;
  model: string;
  // Includes the cache reads and writes; outputTokens includes reasoning.
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  latencyMs: number;
  // Tokens spent by models tried before this one whose replies were unusable,
  // and by attempts this model's options were refused on.
  failedAttempts?: SpentTokens[];
  // What the call had to give up, e.g. thinking an endpoint refused.
  warnings?: string[];
}

type ResponseTokens = Pick<
  GenerateResponse<unknown>,
  "model" | "inputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens" | "reasoningTokens"
>;

// What an LlmUsage records about one call: its tokens, the detail counts only
// when there were any (so usage from providers without caching looks as it
// always did), and its cost at today's prices, kept with the call.
export function callUsage(response: ResponseTokens) {
  const detail = (key: "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens") =>
    response[key] ? { [key]: response[key] } : {};
  const tokens = {
    inputTokens: response.inputTokens,
    ...detail("cachedInputTokens"),
    ...detail("cacheWriteTokens"),
    outputTokens: response.outputTokens,
    ...detail("reasoningTokens"),
  };
  return { ...tokens, cost: callCost(tokens, priceFor(response.model)) };
}

// The one seam between the engine and a model provider. Tests pass their own.
export type Generate = <T>(request: GenerateRequest<T>) => Promise<GenerateResponse<T>>;

export type SpentTokens = ResponseTokens & { latencyMs: number };

// A failed call that still cost tokens: a reply the provider billed for but
// that could not be parsed. `spent` lets the review count that spend.
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly spent: SpentTokens[],
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

export function spentBy(err: unknown): SpentTokens[] {
  return err instanceof ModelCallError ? err.spent : [];
}

// Spent tokens as usage records, flagged so a reader can tell them from the
// calls whose replies were used.
export function failedUsage(spent: SpentTokens[], purpose: LlmUsage["purpose"], chunk?: number): LlmUsage[] {
  return spent.map((tokens) => ({
    purpose,
    model: tokens.model,
    ...callUsage(tokens),
    latencyMs: tokens.latencyMs,
    ...(chunk === undefined ? {} : { chunk }),
    failed: true,
  }));
}

export interface GenerateOptions {
  // What earlier probes and calls found the endpoint's models support, and
  // where this call records what it finds.
  ledger?: CapabilityLedger;
  // The dashboard's capabilities setting, which wins over detection.
  override?: CapabilityOverride;
}

export type ModelUsage =
  | {
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
      outputTokenDetails?: { reasoningTokens?: number };
    }
  | undefined;

export function spentTokens(model: string, usage: ModelUsage, started: number): SpentTokens {
  return {
    model,
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    latencyMs: Date.now() - started,
  };
}

// Whether a reply shows any reasoning. Not every provider splits reasoning
// out of the output count (Anthropic's usage does not), so its text counts too.
export function reasoned(usage: ModelUsage, reasoningText: string | undefined): boolean {
  return (usage?.outputTokenDetails?.reasoningTokens ?? 0) > 0 || !!reasoningText?.trim();
}

// How thinking is asked for on one call: through provider options, by a model
// that thinks by itself, or not at all.
export type ThinkingMode = "options" | "model" | "off";

export function thinkingMode(
  request: { model: string; thinking?: ThinkingLevel },
  resolved: ResolvedModel,
  options: GenerateOptions,
): { mode: ThinkingMode; warning?: string } {
  if (!request.thinking || request.thinking === "off") return { mode: "off" };
  const { thinking } = effectiveCapabilities(request.model, {
    native: resolved.native,
    detected: options.ledger?.get(request.model),
    override: options.override,
  });
  if (thinking === "none") return { mode: "off", warning: thinkingUnavailable(request.model) };
  // Unknown is tried: the runtime fallback below learns the answer.
  return { mode: thinking === "model" ? "model" : "options" };
}

// The call settings thinking changes: a larger output limit (Anthropic counts
// thinking inside max_tokens, the others count reasoning as output), no
// temperature (Anthropic rejects it alongside thinking), and the options.
export function thinkingSettings(
  provider: ProviderName,
  level: ThinkingLevel | undefined,
  mode: ThinkingMode,
  base: { temperature: number; maxOutputTokens: number },
) {
  if (mode === "off" || !level) return { temperature: base.temperature, maxOutputTokens: base.maxOutputTokens };
  const providerOptions = mode === "options" ? thinkingProviderOptions(provider, level) : undefined;
  return {
    maxOutputTokens: base.maxOutputTokens + thinkingBudget(level),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

// One call, made the way the endpoint needs it (streamed behind a base URL,
// see createGenerate), reduced to what callers read. Tool calls and steps are
// for the probe and the agentic loop; createGenerate keeps its own handling of
// structured output.
export async function completeCall(native: boolean, call: Parameters<typeof generateText>[0]) {
  if (native) {
    const result = await generateText(call);
    return {
      text: result.text,
      reasoningText: result.reasoningText,
      toolCalls: result.toolCalls,
      steps: result.steps,
      usage: result.totalUsage as ModelUsage,
    };
  }
  const result = streamText(call as Parameters<typeof streamText>[0]);
  for await (const part of result.fullStream) {
    if (part.type === "error") throw part.error;
  }
  return {
    text: await result.text,
    reasoningText: await result.reasoningText,
    toolCalls: await result.toolCalls,
    steps: await result.steps,
    usage: (await result.totalUsage) as ModelUsage,
  };
}

export function createGenerate(
  keys: ApiKeys,
  endpoint?: Endpoint,
  baseUrls: ProviderBaseUrls = {},
  options: GenerateOptions = {},
): Generate {
  return async <T>(request: GenerateRequest<T>): Promise<GenerateResponse<T>> => {
    const started = Date.now();
    const resolved = languageModel(request.model, keys, endpoint, baseUrls);
    const { model, native, provider } = resolved;
    const warnings: string[] = [];
    const failedAttempts: SpentTokens[] = [];
    const spent = (usage: ModelUsage) => spentTokens(request.model, usage, started);
    // The reply was billed even when it cannot be used, so the error carries
    // its tokens, and those of any refused attempt before it.
    const lenient = (text: string | undefined, usage: ModelUsage) => {
      try {
        return parseLenient(text ?? "", request.schema, request.repair);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ModelCallError(`No object generated: ${reason}. Reply: ${excerpt(text)}`, [
          ...failedAttempts,
          spent(usage),
        ]);
      }
    };

    // `reasoned` is undefined when the reply cannot tell either way.
    const attempt = async (mode: ThinkingMode): Promise<{ object: T; usage: ModelUsage; reasoned?: boolean }> => {
      const call = {
        model,
        // The format goes in the prompt even when the provider enforces it, so a
        // reply that slips past enforcement is still likely to parse.
        system: `${request.system}\n\n${formatInstruction(request.schema, request.schemaName)}`,
        prompt: request.prompt,
        ...thinkingSettings(provider, request.thinking, mode, request),
        abortSignal: request.abortSignal,
      };
      if (!native) {
        // Stream so bytes keep flowing: a self-hosted gateway behind Cloudflare
        // 524s a non-streaming generation that outlives the origin timeout, but
        // never a stream that is actively delivering. Draining fullStream keeps
        // the connection alive and surfaces provider errors as an `error` part,
        // which we rethrow so generateWithFallback can fall back as before.
        const result = streamText(call);
        for await (const part of result.fullStream) {
          if (part.type === "error") throw part.error;
        }
        const usage = await result.usage;
        return { object: lenient(await result.text, usage), usage, reasoned: reasoned(usage, await result.reasoningText) };
      }
      // Anthropic enforces a schema by forcing a tool call, which its API
      // refuses alongside thinking, so the prompt carries the format alone.
      if (provider === "anthropic" && mode === "options") {
        const result = await generateText(call);
        return { object: lenient(result.text, result.usage), usage: result.usage, reasoned: reasoned(result.usage, result.reasoningText) };
      }
      try {
        const result = await generateText({
          ...call,
          output: Output.object({ schema: request.schema, name: request.schemaName }),
        });
        return { object: result.output as T, usage: result.usage, reasoned: reasoned(result.usage, result.reasoningText) };
      } catch (err) {
        // A near-miss the provider let through is repaired rather than lost.
        // The error keeps no reasoning text, so only its tokens can prove
        // thinking; their absence proves nothing.
        if (NoObjectGeneratedError.isInstance(err)) {
          return {
            object: lenient(err.text, err.usage),
            usage: err.usage,
            reasoned: reasoned(err.usage, undefined) || undefined,
          };
        }
        throw err;
      }
    };

    const planned = thinkingMode(request, resolved, options);
    if (planned.warning) warnings.push(planned.warning);
    let mode = planned.mode;
    if (mode !== "off") warnings.push(TEMPERATURE_WITH_THINKING);
    let outcome;
    try {
      outcome = await attempt(mode);
    } catch (err) {
      // Proxies change without notice and native APIs retire options, so a
      // refusal of what we added is retried once without it and remembered.
      if (mode !== "options" || request.abortSignal?.aborted || !rejectsParams(err, THINKING_PARAMS)) throw err;
      failedAttempts.push(spent(undefined));
      options.ledger?.observe({
        model: request.model,
        capabilities: { thinking: "none" },
        source: "runtime",
        detail: `Rejected thinking options: ${excerpt(errorMessage(err), 200)}`,
      });
      warnings.push(thinkingUnavailable(request.model));
      mode = "off";
      outcome = await attempt(mode);
    }
    if (mode === "options") {
      if (outcome.reasoned) {
        options.ledger?.observe({ model: request.model, capabilities: { thinking: "options" }, source: "runtime" });
      } else if (outcome.reasoned === false && !native) {
        // An official API that took the options without a 400 honours them
        // (OpenAI at low effort may spend no reasoning tokens on a short
        // reply); only a proxy can silently drop them.
        options.ledger?.observe({
          model: request.model,
          capabilities: { thinking: "none" },
          source: "runtime",
          detail: "Ignored thinking options",
        });
        warnings.push(thinkingUnavailable(request.model));
      }
    }
    return {
      object: outcome.object,
      ...spent(outcome.usage),
      ...(failedAttempts.length ? { failedAttempts } : {}),
      ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
    };
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export type ModelPurpose = "review" | "walkthrough" | "verify";

// The models a call tries, in order: the purpose's own model when one is set,
// otherwise `model`, then the shared fallbacks.
export function modelChain(llm: Config["llm"], purpose: ModelPurpose): string[] {
  const primary =
    (purpose === "walkthrough" ? llm.walkthroughModel : purpose === "verify" ? llm.verifyModel : null) ?? llm.model;
  return [...new Set([primary, ...llm.fallbackModels])];
}

// Tries the primary model, then each fallback in order. Every model's error is
// kept so the primary's failure is not hidden behind the last fallback's, and
// so is what each failed model spent: on success in `failedAttempts`, when all
// fail on the ModelCallError thrown.
export async function generateWithFallback<T>(
  generate: Generate,
  models: string[],
  request: Omit<GenerateRequest<T>, "model">,
): Promise<GenerateResponse<T>> {
  const errors: unknown[] = [];
  const failedAttempts: SpentTokens[] = [];
  for (const model of models) {
    try {
      const response = await generate({ ...request, model });
      const spent = [...failedAttempts, ...(response.failedAttempts ?? [])];
      return spent.length ? { ...response, failedAttempts: spent } : response;
    } catch (err) {
      // A cancelled review has no use for the fallbacks either. The signal is
      // usually added below this call (abortableGenerate), so the error's name
      // is what tells.
      if (request.abortSignal?.aborted || isAbort(err)) throw err;
      errors.push(err);
      failedAttempts.push(...spentBy(err));
    }
  }
  if (errors.length === 1) throw errors[0] instanceof Error ? errors[0] : new Error(errorMessage(errors[0]));
  throw new ModelCallError(errors.map((err, i) => `${models[i]}: ${errorMessage(err)}`).join(" | "), failedAttempts);
}

// Every request made through the result carries the signal, and none starts
// once it has fired, so a cancelled review stops spending model calls.
export function abortableGenerate(generate: Generate, signal: AbortSignal): Generate {
  return async (request) => {
    signal.throwIfAborted();
    return generate({ ...request, abortSignal: signal });
  };
}
