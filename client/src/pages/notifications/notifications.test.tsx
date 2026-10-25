import { describe, expect, it } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi, personalWorkspace, testUser, testWorkspaces } from "@/test/apiRoutes"

const webhook = {
  id: "n1",
  kind: "webhook",
  name: "CI alerts",
  events: ["failed", "blocked"],
  host: "ci.example.com",
  undecryptable: false,
  recipientIds: [],
  active: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}

const emailTarget = {
  ...webhook,
  id: "n2",
  kind: "email",
  name: "Leads",
  events: ["completed"],
  host: null,
  recipientIds: [testUser.id, "gone"],
}

const members = {
  members: [{ id: testUser.id, name: testUser.name, email: testUser.email, role: "owner", joinedAt: "" }],
}
const MEMBERS_ROUTE = `GET /api/workspaces/${personalWorkspace.id}/members`

const slackTarget = {
  ...webhook,
  id: "n3",
  kind: "slack",
  name: "Team channel",
  events: ["blocked"],
  host: "hooks.slack.com",
}

async function chooseFilter(label: string, option: string) {
  await userEvent.click(screen.getByRole("button", { name: "Filters" }))
  await userEvent.click(await screen.findByRole("combobox", { name: label }))
  await userEvent.click(screen.getByRole("option", { name: option }))
  await userEvent.keyboard("{Escape}")
}

function rowNames() {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]!.textContent)
}

function calls(fetchSpy: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchSpy.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? "GET") === method)
}

describe("Notifications", () => {
  it("lists targets with their destination and events", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook, emailTarget], mailConfigured: true },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const ci = (await screen.findByRole("cell", { name: "CI alerts" })).closest("tr")!
    expect(within(ci).getByText("ci.example.com")).toBeInTheDocument()
    expect(within(ci).getByText("Failed")).toBeInTheDocument()
    expect(within(ci).getByText("Blocked")).toBeInTheDocument()
    const leads = screen.getByRole("cell", { name: "Leads" }).closest("tr")!
    // A recipient who left the workspace is not emailed, so is not listed.
    expect(await within(leads).findByText(testUser.name)).toBeInTheDocument()
    expect(within(leads).getByText("Completed")).toBeInTheDocument()
  })

  it("adds a webhook and shows its signing secret once", async () => {
    let created = false
    const fetchSpy = mockApi({
      // The refetch after adding returns the new target, which swaps the empty state for the table.
      "GET /api/notifications": () => jsonResponse(200, { targets: created ? [webhook] : [], mailConfigured: false }),
      "POST /api/notifications": () => {
        created = true
        return jsonResponse(201, { target: webhook, secret: "abc123" })
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    expect(await screen.findByText("No notification targets")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Add target" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI alerts")
    await userEvent.type(within(dialog).getByLabelText("URL"), "https://ci.example.com/hook")
    await userEvent.click(within(dialog).getByRole("button", { name: "Add target" }))

    expect(await within(dialog).findByLabelText("Signing secret")).toHaveValue("abc123")
    // The secret stays on screen once the table replaces the empty state (the
    // modal hides the page behind it from role queries).
    expect(await screen.findByRole("cell", { name: "CI alerts", hidden: true })).toBeInTheDocument()
    expect(within(dialog).getByLabelText("Signing secret")).toHaveValue("abc123")
    const [, init] = calls(fetchSpy, "POST", "/api/notifications")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "webhook",
      name: "CI alerts",
      events: ["blocked", "failed"],
      url: "https://ci.example.com/hook",
    })
  })

  it("needs a URL and at least one event", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [], mailConfigured: false },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Add target" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI")
    await userEvent.click(within(dialog).getByLabelText("Blocked"))
    await userEvent.click(within(dialog).getByLabelText("Failed"))
    await userEvent.click(within(dialog).getByRole("button", { name: "Add target" }))

    expect(await within(dialog).findByText("Enter an http or https URL")).toBeInTheDocument()
    expect(within(dialog).getByText("Choose at least one event")).toBeInTheDocument()
    expect(calls(fetchSpy, "POST", "/api/notifications")).toHaveLength(0)
  })

  it("sends a test and reports a failed delivery", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false },
      "POST /api/notifications/n1/test": { result: { ok: false, error: "Responded with 404" } },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Send test" }))

    expect(await screen.findByText("Test to CI alerts failed: Responded with 404")).toBeInTheDocument()
  })

  it("searches targets by name, host and recipient", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook, emailTarget, slackTarget], mailConfigured: true },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const search = await screen.findByRole("searchbox", { name: "Search notification targets" })
    await userEvent.type(search, "slack.com")
    expect(rowNames()).toEqual(["Team channel"])

    await userEvent.clear(search)
    await userEvent.type(search, testUser.name)
    expect(rowNames()).toEqual(["Leads"])

    await userEvent.clear(search)
    await userEvent.type(search, "nothing like this")
    expect(screen.getByText("No notification targets match your filters.")).toBeInTheDocument()
  })

  it("filters by type and event, with a chip to remove the filter", async () => {
    mockApi({
      "GET /api/notifications": { targets: [webhook, emailTarget, slackTarget], mailConfigured: true },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await screen.findByRole("cell", { name: "CI alerts" })
    await chooseFilter("Type", "Slack")
    expect(rowNames()).toEqual(["Team channel"])

    await userEvent.click(screen.getByRole("button", { name: "Remove Type filter" }))
    expect(rowNames()).toHaveLength(3)

    await chooseFilter("Event", "Blocked")
    expect(rowNames()).toEqual(["CI alerts", "Team channel"])
  })

  it("pages through many targets", async () => {
    const targets = Array.from({ length: 12 }, (_, i) => ({
      ...webhook,
      id: `p${i}`,
      name: `Target ${String(i + 1).padStart(2, "0")}`,
    }))
    mockApi({
      "GET /api/notifications": { targets, mailConfigured: false },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    expect(await screen.findByText("Showing 1-10 of 12")).toBeInTheDocument()
    expect(rowNames()).toHaveLength(10)
    await userEvent.click(screen.getByRole("button", { name: "Next page" }))
    expect(await screen.findByText("Showing 11-12 of 12")).toBeInTheDocument()
    expect(rowNames()).toEqual(["Target 11", "Target 12"])
  })

  it("pauses a target from the list without opening the edit dialog", async () => {
    let active = true
    const fetchSpy = mockApi({
      "GET /api/notifications": () => jsonResponse(200, { targets: [{ ...webhook, active }], mailConfigured: false }),
      "PATCH /api/notifications/n1": (init?: RequestInit) => {
        active = JSON.parse(String(init?.body)).active
        return jsonResponse(200, { target: { ...webhook, active } })
      },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const toggle = await screen.findByRole("switch", { name: "Active: CI alerts" })
    expect(toggle).toBeChecked()
    expect(screen.queryByText("Inactive")).not.toBeInTheDocument()
    await userEvent.click(toggle)

    expect(await screen.findByText("Paused CI alerts")).toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    const [[, init]] = calls(fetchSpy, "PATCH", "/api/notifications/n1")
    expect(JSON.parse(String(init?.body))).toEqual({ active: false })
    const row = (await screen.findByText("Inactive")).closest("tr")!
    expect(within(row).getByRole("switch", { name: "Active: CI alerts" })).not.toBeChecked()
  })

  it("shows members whether a target is active but does not let them change it", async () => {
    const asMember = testWorkspaces.map((workspace) => ({ ...workspace, role: "member" }))
    mockApi({
      "GET /api/auth/me": { user: testUser, workspaces: asMember },
      "GET /api/workspaces": { workspaces: asMember },
      "GET /api/notifications": { targets: [{ ...webhook, active: false }], mailConfigured: false },
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    const toggle = await screen.findByRole("switch", { name: "Active: CI alerts" })
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeDisabled()
    expect(screen.getByText("Inactive")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Actions for CI alerts" })).not.toBeInTheDocument()
  })

  it("asks before removing a target", async () => {
    const fetchSpy = mockApi({
      "GET /api/notifications": { targets: [webhook], mailConfigured: false },
      "DELETE /api/notifications/n1": () => new Response(null, { status: 204 }),
      [MEMBERS_ROUTE]: members,
    })
    renderWithProviders(<App />, { route: "/notifications" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for CI alerts" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))
    const dialog = await screen.findByRole("dialog")
    expect(calls(fetchSpy, "DELETE", "/api/notifications/n1")).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove target" }))

    expect(await screen.findByText("Removed CI alerts")).toBeInTheDocument()
    expect(calls(fetchSpy, "DELETE", "/api/notifications/n1")).toHaveLength(1)
  })
})
