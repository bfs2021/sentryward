import { APICallError, tool } from "ai";
import { z } from "zod";
import type { ModelCapabilities } from "../review/llm/capabilities.ts";
import { excerpt } from "../review/llm/format.ts";
import {
  TOOL_PARAMS,
  completeCall,
  languageModel,
  reasoned,
  rejectsParams,
  spentTokens,
  thinkingSettings,
  type ApiKeys,
  type Endpoint,
  type ProviderBaseUrls,
  type ResolvedModel,
  type SpentTokens,
} from "../review/llm/providers.ts";

export interface ProbeResult {
  capabilities: ModelCapabilities;
  // One line per question, for the dashboard.
  detail: string;
  // Probes are billed like any call.
  spent: SpentTokens[];
}

// Small enough to cost little, hard enough that a thinking model reasons.
const THINKING_PROMPT = "What is 17 * 23? Reply with the number only.";
const PROBE_OUTPUT_TOKENS = 256;
// A probe answers a question about the endpoint; the SDK's retries on a busy
// host would only make the dashboard wait.
const PROBE_RETRIES = 0;

function message(err: unknown): string {
  return excerpt(err instanceof Error ? err.message : String(err), 160);
}

// A refusal of what was asked for answers the question; anything else (a
// revoked key, a host that is down) says nothing about the model, so the
// answer stays unknown.
function refusal(err: unknown, params: RegExp): boolean {
  return rejectsParams(err, params) || (APICallError.isInstance(err) && err.statusCode === 422);
}

async function probeThinking(model: string, resolved: ResolvedModel, spent: SpentTokens[]) {
  const started = Date.now();
  const base = { model: resolved.model, prompt: THINKING_PROMPT };
  try {
    const result = await completeCall(resolved.native, {
      ...base,
      maxRetries: PROBE_RETRIES,
      ...thinkingSettings(resolved.provider, "low", "options", { temperature: 0, maxOutputTokens: PROBE_OUTPUT_TOKENS }),
    });
    spent.push(spentTokens(model, result.usage, started));
    return reasoned(result.usage, result.reasoningText)
      ? { thinking: "options" as const, note: "thinking options work" }
      : { thinking: "none" as const, note: "thinking options were ignored" };
  } catch (err) {
    spent.push(spentTokens(model, undefined, started));
    if (!refusal(err, /thinking|reasoning|budget|effort|temperature/i)) {
      return { note: `thinking unknown (${message(err)})` };
    }
  }
  // Refused: a model whose id thinks by itself (a "-thinking" variant on a
  // proxy, say) still shows reasoning without the options.
  const plain = Date.now();
  try {
    const result = await completeCall(resolved.native, {
      ...base,
      maxRetries: PROBE_RETRIES,
      temperature: 0,
      maxOutputTokens: PROBE_OUTPUT_TOKENS,
    });
    spent.push(spentTokens(model, result.usage, plain));
    return reasoned(result.usage, result.reasoningText)
      ? { thinking: "model" as const, note: "the model thinks by itself; thinking options are refused" }
      : { thinking: "none" as const, note: "thinking options are refused" };
  } catch (err) {
    spent.push(spentTokens(model, undefined, plain));
    return { thinking: "none" as const, note: `thinking options are refused (${message(err)})` };
  }
}

async function probeTools(model: string, resolved: ResolvedModel, spent: SpentTokens[]) {
  const started = Date.now();
  try {
    const result = await completeCall(resolved.native, {
      model: resolved.model,
      prompt: 'Call the ping tool with value "ok".',
      tools: { ping: tool({ description: "Answers pong.", inputSchema: z.object({ value: z.string() }) }) },
      toolChoice: "required",
      maxRetries: PROBE_RETRIES,
      temperature: 0,
      maxOutputTokens: PROBE_OUTPUT_TOKENS,
    });
    spent.push(spentTokens(model, result.usage, started));
    // A call whose streamed deltas did not reassemble into valid input is
    // still listed, marked invalid.
    const calls = result.toolCalls.filter((call) => call.toolName === "ping");
    if (calls.some((call) => !("invalid" in call && call.invalid))) return { tools: true, note: "tool calls work" };
    return calls.length
      ? { tools: false, note: "tool calls came back broken" }
      : { tools: false, note: "tools were stripped: the reply was text" };
  } catch (err) {
    spent.push(spentTokens(model, undefined, started));
    if (refusal(err, TOOL_PARAMS)) return { tools: false, note: "tools are refused" };
    // The SDK's own complaint about a text reply to a required tool call.
    if (err instanceof Error && err.name === "AI_ToolChoiceViolationError") {
      return { tools: false, note: "tools were stripped: the reply was text" };
    }
    // A stream whose tool deltas do not reassemble into a valid call fails
    // here rather than with an HTTP status.
    if (!APICallError.isInstance(err)) return { tools: false, note: `tool calls came back broken (${message(err)})` };
    return { note: `tools unknown (${message(err)})` };
  }
}

// Two tiny calls through the same client a review would build: one with
// thinking options, one with a trivial tool. What each did is the answer.
export async function probeModel(
  model: string,
  keys: ApiKeys,
  endpoint?: Endpoint,
  baseUrls: ProviderBaseUrls = {},
): Promise<ProbeResult> {
  const resolved = languageModel(model, keys, endpoint, baseUrls);
  const spent: SpentTokens[] = [];
  const thinking = await probeThinking(model, resolved, spent);
  const tools = await probeTools(model, resolved, spent);
  const capabilities: ModelCapabilities = {
    ...(thinking.thinking ? { thinking: thinking.thinking } : {}),
    ...(tools.tools !== undefined ? { tools: tools.tools } : {}),
  };
  return { capabilities, detail: `${thinking.note}; ${tools.note}`, spent };
}
