import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, workspaceHeaders } from "@/lib/api"
import type { LlmProvider } from "@/features/llm-connections/api"

// One layer of privacy policy. Empty lists allow everything; null retention
// keeps data forever (or, for a workspace, follows the instance).
export interface PolicyLayer {
  allowedProviders: LlmProvider[]
  allowedHosts: string[]
  localOnly: boolean
  retentionDays: number | null
}

export interface InstanceSettings extends PolicyLayer {
  auditRetentionDays: number | null
}

export interface InstanceSettingsResponse {
  settings: InstanceSettings
  // REVIEW_RETENTION_DAYS, used while retentionDays is unset.
  env: { reviewRetentionDays: number | null }
}

export interface WorkspacePrivacy {
  workspace: PolicyLayer
  // Read-only here: what the instance admins set, with the env fallback applied.
  instance: PolicyLayer
  effective: { localOnly: boolean; retentionDays: number | null }
}

export type AuditPurpose = "review" | "walkthrough" | "verify" | "probe" | "reply" | "test"

export interface AuditEntry {
  id: string
  createdAt: string
  workspaceId: string | null
  workspaceName: string
  repository: string | null
  changeNumber: number | null
  jobId: string | null
  purpose: AuditPurpose
  provider: LlmProvider
  host: string
  model: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  latencyMs: number
  outcome: "ok" | "failed"
  errorKind: string | null
}

export interface AuditQuery {
  provider?: LlmProvider
  purpose?: AuditPurpose
  outcome?: "ok" | "failed"
  q?: string
  page?: number
  limit?: number
}

export interface AuditPage {
  entries: AuditEntry[]
  total: number
  page: number
  limit: number
}

// The workspace's own log, or every workspace's for instance admins.
export type AuditScope = "workspace" | "instance"

export const PROVIDER_OPTIONS: { value: LlmProvider; label: string }[] = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google" },
  { value: "ollama", label: "Ollama" },
]

const PRIVACY_KEY = ["privacy"]
const INSTANCE_KEY = ["admin", "settings"]
const AUDIT_PATH: Record<AuditScope, string> = { workspace: "/privacy/audit-log", instance: "/admin/audit-log" }

// Only set params go into the URL, in a fixed order so query keys and stubs
// stay predictable.
function auditSearch(params: AuditQuery & { format?: "csv" | "json" }) {
  const search = new URLSearchParams()
  for (const key of ["provider", "purpose", "outcome", "q", "page", "limit", "format"] as const) {
    if (params[key]) search.set(key, String(params[key]))
  }
  return search.toString()
}

export function usePrivacy() {
  return useQuery({ queryKey: PRIVACY_KEY, queryFn: () => api<WorkspacePrivacy>("/privacy") })
}

export function useSavePrivacy() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (layer: PolicyLayer) => api<WorkspacePrivacy>("/privacy", { method: "PUT", body: JSON.stringify(layer) }),
    onSuccess: (data) => queryClient.setQueryData(PRIVACY_KEY, data),
  })
}

export function useInstanceSettings() {
  return useQuery({ queryKey: INSTANCE_KEY, queryFn: () => api<InstanceSettingsResponse>("/admin/settings") })
}

export function useSaveInstanceSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (settings: InstanceSettings) =>
      api<InstanceSettingsResponse>("/admin/settings", { method: "PUT", body: JSON.stringify(settings) }),
    onSuccess: (data) => {
      queryClient.setQueryData(INSTANCE_KEY, data)
      // The workspace page shows the instance layer too.
      queryClient.invalidateQueries({ queryKey: PRIVACY_KEY })
    },
  })
}

export function useAuditLog(scope: AuditScope, params: AuditQuery) {
  const query = auditSearch(params)
  return useQuery({
    queryKey: ["audit", scope, params],
    queryFn: () => api<AuditPage>(`${AUDIT_PATH[scope]}${query ? `?${query}` : ""}`),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  })
}

// Raw text rather than api(): the export is a file, not JSON to parse.
export async function fetchAuditExport(scope: AuditScope, params: AuditQuery, format: "csv" | "json"): Promise<string> {
  const { page: _page, limit: _limit, ...filters } = params
  const res = await fetch(`/api${AUDIT_PATH[scope]}/export?${auditSearch({ ...filters, format })}`, {
    credentials: "include",
    headers: workspaceHeaders(),
  })
  if (!res.ok) throw new Error("Could not export the audit log")
  return res.text()
}
