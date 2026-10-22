import { describe, expect, it } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"

const ciToken = {
  id: "t1",
  name: "CI",
  expiresAt: null,
  lastUsedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
}

function calls(fetchSpy: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchSpy.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? "GET") === method)
}

describe("API tokens", () => {
  it("lists tokens with their expiry and last use", async () => {
    mockApi({
      "GET /api/settings/tokens": {
        tokens: [ciToken, { ...ciToken, id: "t2", name: "Old script", expiresAt: "2026-01-01T00:00:00.000Z" }],
      },
    })
    renderWithProviders(<App />, { route: "/settings?tab=tokens" })

    const ci = (await screen.findByRole("cell", { name: "CI" })).closest("tr")!
    expect(within(ci).getAllByText("Never")).toHaveLength(2)
    const old = screen.getByRole("cell", { name: "Old script" }).closest("tr")!
    expect(within(old).getByText("Expired")).toBeInTheDocument()
  })

  it("creates a token and shows its value once", async () => {
    const fetchSpy = mockApi({
      "GET /api/settings/tokens": { tokens: [] },
      "POST /api/settings/tokens": () => jsonResponse(201, { token: ciToken, value: "swt_secret" }),
    })
    renderWithProviders(<App />, { route: "/settings?tab=tokens" })

    expect(await screen.findByText("No API tokens")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Create token" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "CI")
    await userEvent.click(within(dialog).getByRole("button", { name: "Create token" }))

    expect(await within(dialog).findByLabelText("API token")).toHaveValue("swt_secret")
    const [, init] = calls(fetchSpy, "POST", "/api/settings/tokens")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({ name: "CI", expiresInDays: 30 })

    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }))
    await userEvent.click(screen.getByRole("button", { name: "Create token" }))
    expect(await screen.findByLabelText("Name")).toHaveValue("")
    expect(screen.queryByLabelText("API token")).not.toBeInTheDocument()
  })

  it("asks before revoking a token", async () => {
    const fetchSpy = mockApi({
      "GET /api/settings/tokens": { tokens: [ciToken] },
      "DELETE /api/settings/tokens/t1": () => new Response(null, { status: 204 }),
    })
    renderWithProviders(<App />, { route: "/settings?tab=tokens" })

    await userEvent.click(await screen.findByRole("button", { name: "Revoke CI" }))
    const dialog = await screen.findByRole("dialog")
    expect(calls(fetchSpy, "DELETE", "/api/settings/tokens/t1")).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke token" }))

    expect(await screen.findByText("Revoked CI")).toBeInTheDocument()
    expect(calls(fetchSpy, "DELETE", "/api/settings/tokens/t1")).toHaveLength(1)
  })
})
