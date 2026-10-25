import { prisma } from "../lib/prisma.ts";
import {
  memoryLedger,
  type CapabilityObservation,
  type ModelCapabilities,
  type ThinkingSupport,
} from "../review/llm/capabilities.ts";
import { providerOf, type Endpoint, type ProviderBaseUrls, type ProviderName } from "../review/llm/providers.ts";
import { normalizeBaseUrl } from "./llmConnection.ts";

// "" stands for the provider's official API.
export function endpointKey(baseUrl?: string | null): string {
  return baseUrl ? normalizeBaseUrl(baseUrl) : "";
}

// Where each model of a review is reached, the way languageModel() decides it.
export function endpointOf(endpoint: Endpoint | undefined, baseUrls: ProviderBaseUrls) {
  return (model: string) => {
    const provider = providerOf(model);
    return { provider, endpoint: endpointKey(endpoint?.baseUrl ?? baseUrls[provider]) };
  };
}

function fromRow(row: { thinking: string | null; tools: boolean | null }): ModelCapabilities {
  return {
    ...(row.thinking ? { thinking: row.thinking as ThinkingSupport } : {}),
    ...(row.tools !== null ? { tools: row.tools } : {}),
  };
}

// Only what was observed is written, so a runtime note about thinking keeps
// what a probe found about tools.
export async function recordCapabilities(
  workspaceId: string,
  where: (model: string) => { provider: ProviderName; endpoint: string },
  observations: CapabilityObservation[],
): Promise<void> {
  for (const observation of observations) {
    const { provider, endpoint } = where(observation.model);
    const { thinking, tools } = observation.capabilities;
    const fields = {
      ...(thinking !== undefined ? { thinking } : {}),
      ...(tools !== undefined ? { tools } : {}),
      source: observation.source,
      detail: observation.detail ?? null,
      checkedAt: new Date(),
    };
    await prisma.llmCapability.upsert({
      where: { workspaceId_provider_endpoint_model: { workspaceId, provider, endpoint, model: observation.model } },
      create: { workspaceId, provider, endpoint, model: observation.model, ...fields },
      update: fields,
    });
  }
}

// A ledger seeded with what this workspace recorded for the endpoints the
// review will call; `persist` stores what the review observed. Persisting is
// best effort for the caller: a lost note is learned again next time.
export async function capabilityLedgerFor(workspaceId: string, where: ReturnType<typeof endpointOf>) {
  const rows = await prisma.llmCapability.findMany({ where: { workspaceId } });
  const initial: Record<string, ModelCapabilities> = {};
  for (const row of rows) {
    try {
      const at = where(row.model);
      if (at.provider === row.provider && at.endpoint === row.endpoint) initial[row.model] = fromRow(row);
    } catch {
      // A model id from an older release that no longer parses.
    }
  }
  const { ledger, observations } = memoryLedger(initial);
  return {
    ledger,
    observations,
    known: (model: string) => model in initial,
    persist: () => recordCapabilities(workspaceId, where, observations.splice(0)),
  };
}

// A custom host runs any provider's models, so its rows are found by host; an
// official API runs only its own.
function connectionRows(workspaceId: string, provider: ProviderName, baseUrl?: string | null) {
  return baseUrl ? { workspaceId, endpoint: endpointKey(baseUrl) } : { workspaceId, provider, endpoint: "" };
}

export async function listCapabilities(workspaceId: string, provider: ProviderName, baseUrl?: string | null) {
  const rows = await prisma.llmCapability.findMany({
    where: connectionRows(workspaceId, provider, baseUrl),
    orderBy: [{ endpoint: "asc" }, { model: "asc" }],
  });
  return rows.map((row) => ({
    model: row.model,
    endpoint: row.endpoint || null,
    thinking: (row.thinking as ThinkingSupport | null) ?? null,
    tools: row.tools,
    source: row.source,
    detail: row.detail,
    checkedAt: row.checkedAt.toISOString(),
  }));
}

// A saved or removed connection may point somewhere else now, or hold a key
// with other access, so what was found for where it pointed is forgotten.
export async function clearCapabilities(workspaceId: string, provider: ProviderName, baseUrl?: string | null) {
  await prisma.llmCapability.deleteMany({ where: connectionRows(workspaceId, provider, baseUrl) });
}
