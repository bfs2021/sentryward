import { APICallError } from "ai";
import { prisma } from "../lib/prisma.ts";
import type { AgenticRequest, AgenticResponse, GenerateAgentic } from "../review/llm/agentic.ts";
import { isAbort, spentBy, type Generate, type GenerateResponse, type SpentTokens } from "../review/llm/providers.ts";
import type { LlmTarget, ModelGuard } from "./privacyPolicy.ts";

// What a request was made for, by the schema it asked for. Anything else is
// recorded under its schema name rather than dropped.
const PURPOSES: Record<string, string> = {
  code_review: "review",
  walkthrough: "walkthrough",
  verification: "verify",
  thread_answer: "reply",
  connection_test: "test",
};

export type AuditPurpose = "review" | "walkthrough" | "verify" | "probe" | "reply" | "test";

// Who and what a request was made for. Repository and workspace names are
// snapshots, so the log still reads once those are gone.
export interface AuditContext {
  workspaceId: string;
  workspaceName: string;
  repositoryId?: string;
  repository?: string;
  changeNumber?: number;
  jobId?: string;
  replyId?: string;
  userId?: string;
}

// A short, fixed classification of a failure. Error messages are never stored:
// a provider's complaint or an unparseable reply can quote the code sent.
export function errorKind(err: unknown): string {
  if (isAbort(err)) return "aborted";
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  if (err instanceof Error && err.name === "PolicyViolation") return "policy";
  if (err instanceof Error && err.name === "ToolsUnsupportedError") return "tools_unsupported";
  if (APICallError.isInstance(err) && err.statusCode) return `http_${err.statusCode}`;
  if (err instanceof Error && err.name === "ModelCallError") return "unusable_reply";
  return "error";
}

interface AuditRow {
  purpose: string;
  target: LlmTarget;
  tokens?: Partial<SpentTokens>;
  outcome: "ok" | "failed";
  errorKind?: string;
}

// Best effort by design: a review already paid for must not fail because its
// audit row could not be written, so a failed write is only logged.
export async function writeAudit(ctx: AuditContext, rows: AuditRow[]): Promise<void> {
  if (!rows.length) return;
  try {
    await prisma.llmRequestLog.createMany({
      data: rows.map(({ purpose, target, tokens, outcome, errorKind }) => ({
        ...ctx,
        purpose,
        provider: target.provider,
        host: target.host,
        model: target.model,
        inputTokens: tokens?.inputTokens ?? 0,
        cachedInputTokens: tokens?.cachedInputTokens ?? 0,
        outputTokens: tokens?.outputTokens ?? 0,
        reasoningTokens: tokens?.reasoningTokens ?? 0,
        latencyMs: Math.round(tokens?.latencyMs ?? 0),
        outcome,
        errorKind: errorKind ?? null,
      })),
    });
  } catch (err) {
    console.error("[audit] could not record model requests", err);
  }
}

// Rows for tokens spent outside a Generate call (capability probes), one per
// request made.
export function recordSpent(
  ctx: AuditContext,
  purpose: AuditPurpose,
  target: LlmTarget,
  spent: SpentTokens[],
  failure?: unknown,
): Promise<void> {
  const outcome = failure === undefined ? "ok" : "failed";
  const kind = failure === undefined ? undefined : errorKind(failure);
  const rows: AuditRow[] = spent.length
    ? spent.map((tokens) => ({ purpose, target, tokens, outcome, errorKind: kind }))
    : [{ purpose, target, outcome, errorKind: kind }];
  return writeAudit(ctx, rows);
}

function successRows(purpose: string, target: (model: string) => LlmTarget, model: string, response: GenerateResponse<unknown>) {
  return [
    ...(response.failedAttempts ?? []).map((tokens) => ({
      purpose,
      target: target(tokens.model),
      tokens,
      outcome: "failed" as const,
      errorKind: "refused_options",
    })),
    { purpose, target: target(model), tokens: response, outcome: "ok" as const },
  ];
}

function failureRows(purpose: string, target: (model: string) => LlmTarget, model: string, err: unknown) {
  const kind = errorKind(err);
  const spent = spentBy(err);
  // Refused before sending, from what is already known about the model.
  if (kind === "tools_unsupported" && !spent.length) return [];
  return spent.length
    ? spent.map((tokens) => ({ purpose, target: target(tokens.model), tokens, outcome: "failed" as const, errorKind: kind }))
    : [{ purpose, target: target(model), outcome: "failed" as const, errorKind: kind }];
}

// Records every request made through the result, and with a guard refuses any
// model the privacy policy does not allow before a request goes out. Wrapped
// beneath abortableGenerate, so a call cancelled before it starts is not one.
export function auditedGenerate(
  generate: Generate,
  target: (model: string) => LlmTarget,
  ctx: AuditContext,
  guard?: ModelGuard,
): Generate {
  return async (request) => {
    guard?.allow(request.model);
    const purpose = PURPOSES[request.schemaName] ?? request.schemaName;
    try {
      const response = await generate(request);
      await writeAudit(ctx, successRows(purpose, target, request.model, response));
      return response;
    } catch (err) {
      await writeAudit(ctx, failureRows(purpose, target, request.model, err));
      throw err;
    }
  };
}

// The same for agentic passes; all of a pass's steps are one logical request.
export function auditedGenerateAgentic(
  generate: GenerateAgentic,
  target: (model: string) => LlmTarget,
  ctx: AuditContext,
  guard?: ModelGuard,
): GenerateAgentic {
  return async <T>(request: AgenticRequest<T>): Promise<AgenticResponse<T>> => {
    guard?.allow(request.model);
    const purpose = PURPOSES[request.schemaName] ?? request.schemaName;
    try {
      const response = await generate(request);
      await writeAudit(ctx, successRows(purpose, target, request.model, response));
      return response;
    } catch (err) {
      await writeAudit(ctx, failureRows(purpose, target, request.model, err));
      throw err;
    }
  };
}

type Probe = typeof import("./llmProbe.ts").probeModel;

// Capability probes are requests like any other: refused by the policy before
// they go out, and recorded with what they spent.
export function auditedProbe(probe: Probe, ctx: AuditContext, guard: ModelGuard): Probe {
  return async (model, ...rest) => {
    guard.allow(model);
    try {
      const result = await probe(model, ...rest);
      await recordSpent(ctx, "probe", guard.target(model), result.spent);
      return result;
    } catch (err) {
      await recordSpent(ctx, "probe", guard.target(model), spentBy(err), err);
      throw err;
    }
  };
}
