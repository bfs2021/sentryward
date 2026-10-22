import { describe, expect, it } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi, testUser } from "@/test/apiRoutes"

const admin = { ...testUser, role: "admin" as const }
const member = { id: "2", name: "Grace Hopper", email: "grace@example.com", role: "member", avatarUpdatedAt: null, createdAt: "" }

function adminApi(routes: Record<string, unknown> = {}) {
  return mockApi({
    "GET /api/auth/me": { user: admin },
    "GET /api/admin/users": { users: [admin, member], total: 2, page: 1, limit: 10 },
    "GET /api/admin/invites": { invites: [] },
    ...routes,
  })
}

describe("Admin users page", () => {
  it("is in the sidebar for admins only", async () => {
    adminApi({ "GET /api/reviews": { reviews: [], total: 0 } })
    renderWithProviders(<App />, { route: "/settings" })

    // Closed away from its pages, so Users shows once the group opens.
    await userEvent.click(await screen.findByRole("button", { name: "User Management" }))

    expect(await screen.findByRole("link", { name: "Users" })).toHaveAttribute("href", "/admin/users")
    // Teams belongs to team workspaces, and the group has no "Admin" label.
    expect(screen.queryByRole("link", { name: "Teams" })).not.toBeInTheDocument()
    expect(screen.queryByText("Admin", { exact: true })).not.toBeInTheDocument()
  })

  it("opens User Management on its pages and shows it in the breadcrumb", async () => {
    adminApi()
    renderWithProviders(<App />, { route: "/admin/users" })

    expect(await screen.findByRole("link", { name: "Users" })).toHaveAttribute("href", "/admin/users")
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" })
    expect(within(breadcrumb).getByText("User Management")).toBeInTheDocument()
    expect(within(breadcrumb).getByText("Users")).toHaveAttribute("aria-current", "page")
  })

  it("sends members back to Home", async () => {
    mockApi({ "GET /api/connections": { connections: [], availableApps: [] } })
    renderWithProviders(<App />, { route: "/admin/users" })

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "User Management" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument()
  })

  it("shows each user's avatar initials", async () => {
    adminApi()
    renderWithProviders(<App />, { route: "/admin/users" })

    const row = (await screen.findByText("grace@example.com")).closest("tr")!
    expect(within(row).getByText("GH")).toBeInTheDocument()
  })

  it("edits a user's name and role, sending only what changed", async () => {
    const fetchSpy = adminApi({
      "PATCH /api/admin/users/2": () =>
        jsonResponse(200, { user: { ...member, name: "Grace B. Hopper", role: "admin" } }),
    })
    renderWithProviders(<App />, { route: "/admin/users" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Grace Hopper" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))
    const dialog = await screen.findByRole("dialog")
    const name = within(dialog).getByLabelText("Name")
    await userEvent.clear(name)
    await userEvent.type(name, "Grace B. Hopper")
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Role" }))
    await userEvent.click(await screen.findByRole("option", { name: "Admin" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }))

    expect(await screen.findByText("Saved Grace B. Hopper")).toBeInTheDocument()
    const patch = fetchSpy.mock.calls.find(([url, init]) => String(url) === "/api/admin/users/2" && init?.method === "PATCH")
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ name: "Grace B. Hopper", role: "admin" })
  })

  it("shows a taken email on the email field", async () => {
    const taken = "An account with this email already exists"
    adminApi({
      "PATCH /api/admin/users/2": () => jsonResponse(409, { message: taken, errors: { email: [taken] } }),
    })
    renderWithProviders(<App />, { route: "/admin/users" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Grace Hopper" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }))
    const dialog = await screen.findByRole("dialog")
    const email = within(dialog).getByLabelText("Email")
    await userEvent.clear(email)
    await userEvent.type(email, "ada@example.com")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }))

    expect(await within(dialog).findByText(taken)).toBeInTheDocument()
  })

  it("removes a user after confirming", async () => {
    const fetchSpy = adminApi({ "DELETE /api/admin/users/2": () => new Response(null, { status: 204 }) })
    renderWithProviders(<App />, { route: "/admin/users" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Grace Hopper" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))
    await userEvent.click(await screen.findByRole("button", { name: "Remove user" }))

    expect(await screen.findByText("Grace Hopper was removed")).toBeInTheDocument()
    expect(fetchSpy.mock.calls.some(([url, init]) => String(url) === "/api/admin/users/2" && init?.method === "DELETE")).toBe(
      true,
    )
  })

  it("offers no Remove for yourself", async () => {
    adminApi()
    renderWithProviders(<App />, { route: "/admin/users" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Ada Lovelace" }))

    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Remove" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Create reset link" })).not.toBeInTheDocument()
  })

  it("creates a password reset link to hand over", async () => {
    const link = "http://localhost:5173/reset-password/tok123"
    const fetchSpy = adminApi({
      "POST /api/admin/users/2/password-reset": () => jsonResponse(201, { link, expiresAt: "2026-10-23T00:00:00Z" }),
    })
    renderWithProviders(<App />, { route: "/admin/users" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Grace Hopper" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Create reset link" }))
    await userEvent.click(await screen.findByRole("button", { name: "Create link" }))

    expect(await screen.findByLabelText("Reset link")).toHaveValue(link)
    expect(
      fetchSpy.mock.calls.some(
        ([url, init]) => String(url) === "/api/admin/users/2/password-reset" && init?.method === "POST",
      ),
    ).toBe(true)
  })

  describe("users table", () => {
    // URLs the page asked the users endpoint for, in order.
    function userRequests(fetchSpy: ReturnType<typeof adminApi>) {
      return fetchSpy.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith("/api/admin/users?"))
    }

    it("pages through users", async () => {
      adminApi()
      renderWithProviders(<App />, { route: "/admin/users" })

      expect(await screen.findByText("Showing 1-2 of 2")).toBeInTheDocument()
      expect(screen.getByText("Page 1 of 1")).toBeInTheDocument()
    })

    it("searches on the server", async () => {
      const fetchSpy = adminApi({
        "GET /api/admin/users?q=grace&page=1&limit=10": { users: [member], total: 1, page: 1, limit: 10 },
      })
      renderWithProviders(<App />, { route: "/admin/users" })

      await userEvent.type(await screen.findByRole("searchbox", { name: "Search users" }), "grace")

      await waitFor(() => expect(screen.queryByRole("cell", { name: "ada@example.com" })).not.toBeInTheDocument())
      expect(userRequests(fetchSpy)).toContain("/api/admin/users?q=grace&page=1&limit=10")
    })

    it("filters by role and shows the filter as a chip", async () => {
      const fetchSpy = adminApi({
        "GET /api/admin/users?role=admin&page=1&limit=10": { users: [admin], total: 1, page: 1, limit: 10 },
      })
      renderWithProviders(<App />, { route: "/admin/users" })

      await userEvent.click(await screen.findByRole("button", { name: "Filters" }))
      await userEvent.click(screen.getByRole("combobox", { name: "Role" }))
      await userEvent.click(await screen.findByRole("option", { name: "Admin" }))

      expect(await screen.findByRole("button", { name: "Remove Role filter" })).toBeInTheDocument()
      await waitFor(() => expect(screen.queryByRole("cell", { name: "grace@example.com" })).not.toBeInTheDocument())
      expect(userRequests(fetchSpy)).toContain("/api/admin/users?role=admin&page=1&limit=10")
    })

    it("sorts by a column header", async () => {
      const fetchSpy = adminApi()
      renderWithProviders(<App />, { route: "/admin/users" })

      await userEvent.click(await screen.findByRole("button", { name: "Name" }))

      await waitFor(() =>
        expect(userRequests(fetchSpy)).toContain("/api/admin/users?sort=name&dir=asc&page=1&limit=10"),
      )
    })

    it("says when nothing matches", async () => {
      adminApi({
        "GET /api/admin/users?q=nobody&page=1&limit=10": { users: [], total: 0, page: 1, limit: 10 },
      })
      renderWithProviders(<App />, { route: "/admin/users" })

      await userEvent.type(await screen.findByRole("searchbox", { name: "Search users" }), "nobody")

      expect(await screen.findByText("No users match your filters.")).toBeInTheDocument()
      expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument()
    })
  })

  describe("tabs", () => {
    it("opens on Users and switches to Pending invites", async () => {
      adminApi()
      renderWithProviders(<App />, { route: "/admin/users" })

      expect(await screen.findByRole("cell", { name: "grace@example.com" })).toBeInTheDocument()
      await userEvent.click(screen.getByRole("tab", { name: "Pending invites" }))

      expect(await screen.findByText(/No pending invites yet/)).toBeInTheDocument()
      expect(screen.queryByRole("cell", { name: "grace@example.com" })).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Invite user" })).toBeInTheDocument()
    })

    it("opens straight onto a tab from ?tab=", async () => {
      adminApi()
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      expect(await screen.findByText(/No pending invites yet/)).toBeInTheDocument()
      expect(screen.getByRole("tab", { name: "Pending invites" })).toHaveAttribute("aria-selected", "true")
    })

    it("keeps the toolbar and table when there are no invites", async () => {
      adminApi()
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      const row = (await screen.findByText(/No pending invites yet/)).closest("tr")!
      expect(within(screen.getByRole("table")).getByRole("columnheader", { name: /For/ })).toBeInTheDocument()
      expect(row).toBeInTheDocument()
      expect(screen.getByRole("searchbox", { name: "Search invites" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument()
      expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument()
    })
  })

  describe("pending invites table", () => {
    // API order: newest first.
    const invites = [
      { id: "i2", email: null, expiresAt: "2099-01-10T00:00:00Z", createdAt: "2026-10-03T00:00:00Z", invitedBy: { name: "Grace Hopper" } },
      { id: "i1", email: "linus@example.com", expiresAt: "2099-01-08T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", invitedBy: { name: "Ada Lovelace" } },
    ]

    function inviteApi(routes: Record<string, unknown> = {}) {
      return adminApi({ "GET /api/admin/invites": { invites }, ...routes })
    }

    // First cell of each body row, i.e. who the invite is for.
    function forColumn() {
      const table = screen.getByRole("table")
      return within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0].textContent)
    }

    it("lists invites with pagination", async () => {
      inviteApi()
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      expect(await screen.findByRole("cell", { name: "linus@example.com" })).toBeInTheDocument()
      expect(screen.getByText("Showing 1-2 of 2")).toBeInTheDocument()
    })

    it("searches by email or inviter", async () => {
      inviteApi()
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      await userEvent.type(await screen.findByRole("searchbox", { name: "Search invites" }), "grace")

      expect(forColumn()).toEqual(["Anyone with the link"])
    })

    it("filters by type and shows the filter as a chip", async () => {
      inviteApi()
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      await userEvent.click(await screen.findByRole("button", { name: "Filters" }))
      await userEvent.click(screen.getByRole("combobox", { name: "Type" }))
      await userEvent.click(await screen.findByRole("option", { name: "Specific email" }))

      expect(await screen.findByRole("button", { name: "Remove Type filter" })).toBeInTheDocument()
      expect(forColumn()).toEqual(["linus@example.com"])
    })

    it("sorts by a column header", async () => {
      inviteApi()
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      await screen.findByRole("cell", { name: "linus@example.com" })
      expect(forColumn()).toEqual(["Anyone with the link", "linus@example.com"])
      await userEvent.click(screen.getByRole("button", { name: "Created" }))

      expect(forColumn()).toEqual(["linus@example.com", "Anyone with the link"])
    })

    it("says when nothing matches", async () => {
      inviteApi()
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      await userEvent.type(await screen.findByRole("searchbox", { name: "Search invites" }), "nobody")

      expect(await screen.findByText("No invites match your filters.")).toBeInTheDocument()
    })

    it("revokes an invite after confirming", async () => {
      const fetchSpy = inviteApi({ "DELETE /api/admin/invites/i1": () => new Response(null, { status: 204 }) })
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      await userEvent.click(await screen.findByRole("button", { name: "Actions for linus@example.com" }))
      await userEvent.click(await screen.findByRole("menuitem", { name: "Revoke" }))
      expect(await screen.findByText(/The link sent to linus@example.com stops working/)).toBeInTheDocument()
      await userEvent.click(screen.getByRole("button", { name: "Revoke invite" }))

      expect(await screen.findByText("Invite revoked")).toBeInTheDocument()
      expect(
        fetchSpy.mock.calls.some(([url, init]) => String(url) === "/api/admin/invites/i1" && init?.method === "DELETE"),
      ).toBe(true)
    })

    const resendCalls = (fetchSpy: ReturnType<typeof inviteApi>) =>
      fetchSpy.mock.calls.filter(
        ([url, init]) => String(url) === "/api/admin/invites/i1/resend" && init?.method === "POST",
      )

    async function openResend() {
      await userEvent.click(await screen.findByRole("button", { name: "Actions for linus@example.com" }))
      await userEvent.click(await screen.findByRole("menuitem", { name: "Resend email" }))
      return screen.findByRole("dialog")
    }

    it("resends an email invite after confirming", async () => {
      const fetchSpy = inviteApi({ "POST /api/admin/invites/i1/resend": () => jsonResponse(200, { invite: invites[1] }) })
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      const dialog = await openResend()
      expect(within(dialog).getByText(/new sign-up link to linus@example.com/)).toBeInTheDocument()
      expect(resendCalls(fetchSpy)).toHaveLength(0)
      await userEvent.click(within(dialog).getByRole("button", { name: "Send email" }))

      expect(await screen.findByText("Invite sent to linus@example.com")).toBeInTheDocument()
      expect(resendCalls(fetchSpy)).toHaveLength(1)
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    })

    it("sends nothing when cancelled", async () => {
      const fetchSpy = inviteApi()
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      const dialog = await openResend()
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
      expect(resendCalls(fetchSpy)).toHaveLength(0)
    })

    it("shows why a resend failed and keeps the dialog open", async () => {
      inviteApi({
        "POST /api/admin/invites/i1/resend": () => jsonResponse(409, { message: "Email is not set up on this server" }),
      })
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      const dialog = await openResend()
      await userEvent.click(within(dialog).getByRole("button", { name: "Send email" }))

      expect(await screen.findByText("Email is not set up on this server")).toBeInTheDocument()
      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })

    it("offers no resend for an open link", async () => {
      inviteApi()
      renderWithProviders(<App />, { route: "/admin/users?tab=invites" })

      await userEvent.click(await screen.findByRole("button", { name: "Actions for open invite link" }))

      expect(await screen.findByRole("menuitem", { name: "Revoke" })).toBeInTheDocument()
      expect(screen.queryByRole("menuitem", { name: "Resend email" })).not.toBeInTheDocument()
    })
  })

  it("creates an invite and shows the link to copy", async () => {
    adminApi({
      "POST /api/admin/invites": () =>
        jsonResponse(201, {
          invite: { id: "i1", email: null, expiresAt: "", createdAt: "", invitedBy: { name: "Ada" } },
          link: "http://localhost:5173/invite/tok123",
          emailed: false,
        }),
    })
    renderWithProviders(<App />, { route: "/admin/users" })

    await userEvent.click(await screen.findByRole("button", { name: "Invite user" }))
    await userEvent.click(await screen.findByRole("button", { name: "Create invite" }))

    expect(await screen.findByLabelText("Invite link")).toHaveValue("http://localhost:5173/invite/tok123")
    expect(screen.getByText(/Share this link/)).toBeInTheDocument()
  })
})
