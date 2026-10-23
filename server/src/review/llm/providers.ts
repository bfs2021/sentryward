import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, NoObjectGeneratedError, Output, streamText, type LanguageModel } from "ai";
import type { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { LlmUsage } from "../core/models.ts";
import { callCost, priceFor } from "../core/pricing/pricing.ts";
import { excerpt, formatInstruction, parseLenient } from "./format.ts";

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

interface ResolvedModel {
  model: LanguageModel;
  // Whether the provider itself enforces the output schema. Proxies may drop
  // `response_format` silently (9router does), so anything behind a base URL
  // is asked for JSON in the prompt and parsed leniently instead.
  native: boolean;
}

function languageModel(
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
      return { model: createAnthropic({ apiKey, baseURL })(modelId), native };
    case "openai": {
      const openai = createOpenAI({ apiKey, baseURL });
      // OpenAI-compatible proxies speak chat completions, not the Responses API
      // the SDK defaults to.
      return { model: baseURL ? openai.chat(modelId) : openai(modelId), native };
    }
    case "google":
      return { model: createGoogleGenerativeAI({ apiKey, baseURL })(modelId), native };
    case "ollama": {
      const ollama = createOpenAI({ apiKey, baseURL });
      return { model: ollama.chat(modelId), native: false };
    }
  }
}

export interface GenerateRequest<T> {
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  temperature: number;
  maxOutputTokens: number;
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
  // Tokens spent by models tried before this one whose replies were unusable.
  failedAttempts?: SpentTokens[];
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

export function createGenerate(keys: ApiKeys, endpoint?: Endpoint, baseUrls: ProviderBaseUrls = {}): Generate {
  return async <T>(request: GenerateRequest<T>): Promise<GenerateResponse<T>> => {
    const started = Date.now();
    const { model, native } = languageModel(request.model, keys, endpoint, baseUrls);
    const call = {
      model,
      // The format goes in the prompt even when the provider enforces it, so a
      // reply that slips past enforcement is still likely to parse.
      system: `${request.system}\n\n${formatInstruction(request.schema, request.schemaName)}`,
      prompt: request.prompt,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.abortSignal,
    };
    type Usage =
      | {
          inputTokens?: number;
          outputTokens?: number;
          inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
          outputTokenDetails?: { reasoningTokens?: number };
        }
      | undefined;
    const spent = (usage: Usage): SpentTokens => ({
      model: request.model,
      inputTokens: usage?.inputTokens ?? 0,
      cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
      latencyMs: Date.now() - started,
    });
    const respond = (object: T, usage: Usage) => ({ object, ...spent(usage) });
    // The reply was billed even when it cannot be used, so the error carries
    // its tokens.
    const lenient = (text: string | undefined, usage: Usage) => {
      try {
        return parseLenient(text ?? "", request.schema, request.repair);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ModelCallError(`No object generated: ${reason}. Reply: ${excerpt(text)}`, [spent(usage)]);
      }
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
      return respond(lenient(await result.text, usage), usage);
    }
    try {
      const result = await generateText({
        ...call,
        output: Output.object({ schema: request.schema, name: request.schemaName }),
      });
      return respond(result.output as T, result.usage);
    } catch (err) {
      // A near-miss the provider let through is repaired rather than lost.
      if (NoObjectGeneratedError.isInstance(err)) return respond(lenient(err.text, err.usage), err.usage);
      throw err;
    }
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      return failedAttempts.length ? { ...response, failedAttempts } : response;
    } catch (err) {
      // A cancelled review has no use for the fallbacks either.
      if (request.abortSignal?.aborted) throw err;
      errors.push(err);
      failedAttempts.push(...spentBy(err));
    }
  }
  if (errors.length === 1) throw errors[0] instanceof Error ? errors[0] : new Error(message(errors[0]));
  throw new ModelCallError(errors.map((err, i) => `${models[i]}: ${message(err)}`).join(" | "), failedAttempts);
}

// Every request made through the result carries the signal, and none starts
// once it has fired, so a cancelled review stops spending model calls.
export function abortableGenerate(generate: Generate, signal: AbortSignal): Generate {
  return async (request) => {
    signal.throwIfAborted();
    return generate({ ...request, abortSignal: signal });
  };
}
