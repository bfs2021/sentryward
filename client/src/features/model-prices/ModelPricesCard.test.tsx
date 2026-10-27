import { describe, expect, it } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi, testUser, testWorkspaces } from "@/test/apiRoutes"
import type { ModelPrices } from "./api"

const noKeys = { keys: [] }

const PRICES: ModelPrices = {
  prices: [{ id: "p1", model: "openai/my-proxy", price: { input: 1.5, output: 6 }, updatedAt: "2026-10-20T00:00:00.000Z" }],
  models: [
    { model: "openai/my-proxy", builtIn: null, price: { input: 1.5, output: 6 } },
    { model: "anthropic/claude-sonnet-5-5", builtIn: { input: 2, output: 10 }, price: { input: 2, output: 10 } },
    { model: "openai/custom-model", builtIn: null, price: null },
  ],
}

const pricesTable = () => screen.findByRole("table", { name: "Model prices" })

describe("Model prices", () => {
  it("lists the workspace's prices and the recent models nothing prices", async () => {
    mockApi({ "GET /api/settings/api-keys": noKeys, "GET /api/settings/model-prices": PRICES })
    renderWithProviders(<App />, { route: "/llm-connections" })

    const table = await pricesTable()
    expect(within(table).getByText("openai/my-proxy")).toBeInTheDocument()
    expect(within(table).getByText("$1.50")).toBeInTheDocument()
    // Priced by the workspace or built in: not listed as missing.
    expect(screen.getByText("1 model used recently has no price")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "openai/custom-model" })).toBeInTheDocument()
  })

  it("saves a price for a model with none, prefilled from the list", async () => {
    const saved: unknown[] = []
    mockApi({
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": PRICES,
      "PUT /api/settings/model-prices": (init?: RequestInit) => {
        saved.push(JSON.parse(String(init?.body)))
        return jsonResponse(200, PRICES)
      },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await userEvent.click(await screen.findByRole("button", { name: "openai/custom-model" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByLabelText("Model")).toHaveValue("openai/custom-model")
    await userEvent.type(within(dialog).getByLabelText("Input"), "0.5")
    await userEvent.type(within(dialog).getByLabelText("Output"), "2")
    await userEvent.type(within(dialog).getByLabelText("Cache read"), "0.05")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save price" }))

    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]).toEqual({ model: "openai/custom-model", input: 0.5, output: 2, cached: 0.05, cacheWrite: null, reasoning: null })
  })

  it("goes by the price the server says reviews get, not an exact id match", async () => {
    // A price saved as "cx/gpt-5.6-sol" prices the router model, so it is not missing.
    const routed: ModelPrices = {
      prices: [{ id: "p2", model: "cx/gpt-5.6-sol", price: { input: 1, output: 4 }, updatedAt: "2026-10-20T00:00:00.000Z" }],
      models: [{ model: "openai/cx/gpt-5.6-sol(medium)", builtIn: null, price: { input: 1, output: 4 } }],
    }
    mockApi({ "GET /api/settings/api-keys": noKeys, "GET /api/settings/model-prices": routed })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await pricesTable()
    expect(screen.queryByText(/has no price|have no price/)).not.toBeInTheDocument()
  })

  it("keeps the model fixed when editing a saved price", async () => {
    mockApi({ "GET /api/settings/api-keys": noKeys, "GET /api/settings/model-prices": PRICES })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await userEvent.click(await screen.findByRole("button", { name: "Edit the price for openai/my-proxy" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByLabelText("Model")).toHaveAttribute("readonly")
    expect(within(dialog).getByLabelText("Input")).toHaveValue("1.5")
  })

  it("checks prices before sending them", async () => {
    mockApi({ "GET /api/settings/api-keys": noKeys, "GET /api/settings/model-prices": PRICES })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await userEvent.click(await screen.findByRole("button", { name: "Add price" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Model"), "x/y")
    await userEvent.type(within(dialog).getByLabelText("Input"), "-1")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save price" }))

    expect(await within(dialog).findByText("Enter a price of 0 or more")).toBeInTheDocument()
    expect(within(dialog).getByText("Enter a price")).toBeInTheDocument()
  })

  it("removes a price", async () => {
    let removed = false
    mockApi({
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": () => jsonResponse(200, removed ? { ...PRICES, prices: [] } : PRICES),
      "DELETE /api/settings/model-prices/p1": () => {
        removed = true
        return new Response(null, { status: 204 })
      },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await userEvent.click(await screen.findByRole("button", { name: "Remove the price for openai/my-proxy" }))

    expect(await screen.findByText("No prices of your own. Reviews use the built-in prices.")).toBeInTheDocument()
  })

  it("shows members the prices without letting them change any", async () => {
    const asMember = testWorkspaces.map((workspace) => ({ ...workspace, role: "member" }))
    mockApi({
      "GET /api/auth/me": { user: testUser, workspaces: asMember },
      "GET /api/workspaces": { workspaces: asMember },
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": PRICES,
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    expect(within(await pricesTable()).getByText("openai/my-proxy")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add price" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Remove the price/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "openai/custom-model" })).not.toBeInTheDocument()
  })
})
