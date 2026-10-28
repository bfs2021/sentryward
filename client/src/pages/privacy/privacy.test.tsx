import { describe, expect, it } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi, personalWorkspace, testUser } from "@/test/apiRoutes"

const admin = { ...testUser, role: "admin" as const }
const OPEN = { allowedProviders: [], allowedHosts: [], localOnly: false, retentionDays: null }

const PRIVACY = {
  workspace: OPEN,
  instance: { ...OPEN, allowedProviders: ["anthropic", "ollama"], retentionDays: 90 },
  effective: { localOnly: false, retentionDays: 90 },
}

const ENTRY = {
  id: "a1",
  createdAt: new Date().toISOString(),
  workspaceId: "w-personal",
  workspaceName: "Ada Lovelace",
  repository: "github.com/acme/web",
  changeNumber: 7,
  jobId: "j1",
  purpose: "review",
  provider: "anthropic",
  host: "api.anthropic.com",
  model: "anthropic/claude-sonnet-4-5",
  inputTokens: 1200,
  cachedInputTokens: 0,
  outputTokens: 300,
  reasoningTokens: 0,
  latencyMs: 900,
  outcome: "ok",
  errorKind: null,
}

const AUDIT = { entries: [ENTRY], total: 1, page: 1, limit: 10 }

function bodyOf(spy: ReturnType<typeof mockApi>, url: string, method: string) {
  const call = spy.mock.calls.find(([u, init]) => String(u) === url && init?.method === method)
  return JSON.parse(String(call?.[1]?.body))
}

describe("Privacy page", () => {
  it("shows the instance limits and saves a narrower workspace policy", async () => {
    const spy = mockApi({
      "GET /api/privacy": PRIVACY,
      "GET /api/privacy/audit-log": AUDIT,
      "PUT /api/privacy": () =>
        jsonResponse(200, { ...PRIVACY, workspace: { ...OPEN, allowedProviders: ["ollama"], localOnly: true, retentionDays: 30 } }),
    })
    renderWithProviders(<App />, { route: "/privacy" })

    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeInTheDocument()
    expect(await screen.findByText(/The instance allows: anthropic, ollama/)).toBeInTheDocument()
    expect(screen.getByText(/Empty follows the instance \(90 days\)/)).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText("Ollama"))
    await userEvent.click(screen.getByRole("switch", { name: "Local only" }))
    await userEvent.type(screen.getByLabelText("Review data retention (days)"), "30")
    await userEvent.click(screen.getByRole("button", { name: "Save privacy settings" }))

    expect(await screen.findByText("Privacy settings saved")).toBeInTheDocument()
    expect(bodyOf(spy, "/api/privacy", "PUT")).toEqual({
      allowedProviders: ["ollama"],
      allowedHosts: [],
      localOnly: true,
      retentionDays: 30,
    })
  })

  it("puts server field errors on their fields", async () => {
    mockApi({
      "GET /api/privacy": PRIVACY,
      "GET /api/privacy/audit-log": AUDIT,
      "PUT /api/privacy": () =>
        jsonResponse(400, { message: "Validation failed", errors: { retentionDays: ["Must be at most 90 days (the instance limit)"] } }),
    })
    renderWithProviders(<App />, { route: "/privacy" })

    await userEvent.type(await screen.findByLabelText("Review data retention (days)"), "120")
    await userEvent.click(screen.getByRole("button", { name: "Save privacy settings" }))

    expect(await screen.findByText("Must be at most 90 days (the instance limit)")).toBeInTheDocument()
  })

  it("lists the workspace's model requests in the audit log tab and exports them", async () => {
    const spy = mockApi({
      "GET /api/privacy": PRIVACY,
      "GET /api/privacy/audit-log": AUDIT,
      "GET /api/privacy/audit-log/export": () => new Response("time,workspace\r\n", { status: 200 }),
    })
    renderWithProviders(<App />, { route: "/privacy" })

    // The policy tab opens first; the log loads with its tab.
    expect(await screen.findByText("Workspace policy")).toBeInTheDocument()
    expect(screen.queryByText("anthropic/claude-sonnet-4-5")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "Audit log" }))

    const row = (await screen.findByText("anthropic/claude-sonnet-4-5")).closest("tr")!
    expect(within(row).getByText("api.anthropic.com")).toBeInTheDocument()
    expect(within(row).getByText("github.com/acme/web")).toBeInTheDocument()
    expect(within(row).getByText("1,200 / 300")).toBeInTheDocument()
    // The workspace view has no workspace column.
    expect(screen.queryByRole("columnheader", { name: "Workspace" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Export" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "CSV" }))

    await waitFor(() =>
      expect(spy.mock.calls.some(([url]) => String(url) === "/api/privacy/audit-log/export?format=csv")).toBe(true),
    )
  })

  it("opens the audit log tab from the URL", async () => {
    mockApi({ "GET /api/privacy": PRIVACY, "GET /api/privacy/audit-log": AUDIT })
    renderWithProviders(<App />, { route: "/privacy?tab=audit" })

    expect(await screen.findByText("anthropic/claude-sonnet-4-5")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Audit log" })).toHaveAttribute("aria-selected", "true")
  })

  it("is read-only for members, without the audit log", async () => {
    mockApi({
      "GET /api/auth/me": { user: testUser, workspaces: [{ ...personalWorkspace, role: "member" }] },
      "GET /api/workspaces": { workspaces: [{ ...personalWorkspace, role: "member" }] },
      "GET /api/privacy": PRIVACY,
    })
    // A member asking for the audit tab lands on the policy.
    renderWithProviders(<App />, { route: "/privacy?tab=audit" })

    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeInTheDocument()
    expect(await screen.findByLabelText("Ollama")).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Save privacy settings" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Audit log" })).not.toBeInTheDocument()
  })
})

describe("Instance admin pages", () => {
  function adminApi(routes: Record<string, unknown> = {}) {
    return mockApi({
      "GET /api/auth/me": { user: admin },
      "GET /api/admin/settings": { settings: { ...OPEN, auditRetentionDays: null }, env: { reviewRetentionDays: 60 } },
      "GET /api/admin/audit-log": AUDIT,
      ...routes,
    })
  }

  it("lists the admin pages in the sidebar", async () => {
    adminApi()
    renderWithProviders(<App />, { route: "/admin/settings" })

    expect(await screen.findByRole("link", { name: "Instance settings" })).toHaveAttribute("href", "/admin/settings")
    expect(screen.getByRole("link", { name: "Audit log" })).toHaveAttribute("href", "/admin/audit-log")
  })

  it("saves the instance policy, showing the environment fallback", async () => {
    const spy = adminApi({
      "PUT /api/admin/settings": (init?: RequestInit) =>
        jsonResponse(200, { settings: JSON.parse(String(init?.body)), env: { reviewRetentionDays: 60 } }),
    })
    renderWithProviders(<App />, { route: "/admin/settings" })

    expect(await screen.findByText(/REVIEW_RETENTION_DAYS from the server environment \(60 days\)/)).toBeInTheDocument()
    const hosts = screen.getByLabelText("Allowed hosts")
    await userEvent.type(hosts, "ollama.internal:11434{Enter}")
    await userEvent.type(screen.getByLabelText("Audit log retention (days)"), "365")
    await userEvent.click(screen.getByRole("button", { name: "Save privacy settings" }))

    // An earlier test's toast may still be on screen, so the request is what is checked.
    await waitFor(() => expect(spy.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true))
    expect(bodyOf(spy, "/api/admin/settings", "PUT")).toEqual({
      allowedProviders: [],
      allowedHosts: ["ollama.internal:11434"],
      localOnly: false,
      retentionDays: null,
      auditRetentionDays: 365,
    })
  })

  it("shows the audit log of every workspace", async () => {
    adminApi()
    renderWithProviders(<App />, { route: "/admin/audit-log" })

    const row = (await screen.findByText("anthropic/claude-sonnet-4-5")).closest("tr")!
    expect(screen.getByRole("columnheader", { name: "Workspace" })).toBeInTheDocument()
    expect(within(row).getByText("Ada Lovelace")).toBeInTheDocument()
  })

  it("sends members back to Home", async () => {
    mockApi({ "GET /api/connections": { connections: [], availableApps: [] } })
    renderWithProviders(<App />, { route: "/admin/audit-log" })

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument()
  })
})
