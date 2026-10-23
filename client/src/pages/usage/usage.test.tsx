import { describe, expect, it, vi } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"
import { bucketLabel } from "@/features/usage/format"
import type { UsageReport } from "@/features/usage/types"

const SONNET = "anthropic/claude-sonnet-5-5"
const PROXY = "openai/my-proxy"

function report(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    period: "7d",
    unit: "day",
    totals: {
      reviews: 4,
      calls: 9,
      inputTokens: 1_250_000,
      cachedInputTokens: 400_000,
      outputTokens: 120_000,
      cost: { usd: 3.28 },
    },
    series: [
      { start: "2026-10-22T00:00:00.000Z", calls: 4, tokens: 600_000, usd: 1.2 },
      { start: "2026-10-23T00:00:00.000Z", calls: 5, tokens: 770_000, usd: 2.08 },
    ],
    byModel: [
      {
        model: SONNET,
        provider: "anthropic",
        calls: 9,
        inputTokens: 1_250_000,
        cachedInputTokens: 400_000,
        outputTokens: 120_000,
        lastUsed: "2026-10-23T10:00:00.000Z",
        cost: { input: 1.7, cached: 0.08, output: 1.2, total: 2.98 },
      },
    ],
    byProvider: [{ provider: "anthropic", calls: 9, tokens: 1_370_000, usd: 3.28 }],
    byRepository: [
      {
        repositoryId: "r1",
        fullPath: "acme/web",
        reviews: 4,
        calls: 9,
        inputTokens: 1_250_000,
        cachedInputTokens: 400_000,
        outputTokens: 120_000,
        lastUsed: "2026-10-23T10:00:00.000Z",
        usd: 3.28,
      },
    ],
    recent: [
      {
        id: "rev-1",
        number: 42,
        title: "Add b and c",
        fullPath: "acme/web",
        createdAt: "2026-10-23T10:00:00.000Z",
        models: [SONNET],
        inputTokens: 300_000,
        outputTokens: 20_000,
        usd: 0.62,
      },
    ],
    ...overrides,
  }
}

describe("Usage page", () => {
  it("is reachable from the sidebar and shows the totals", async () => {
    mockApi({ "GET /api/reviews": { reviews: [], total: 0 }, "GET /api/usage?period=7d": report() })
    renderWithProviders(<App />, { route: "/home" })

    await userEvent.click(await screen.findByRole("link", { name: "Usage" }))

    const totals = await screen.findByRole("region", { name: "Usage totals" })
    expect(within(totals).getByText("1,250,000")).toBeInTheDocument()
    expect(within(totals).getByText("400,000")).toBeInTheDocument()
    expect(within(totals).getByText("~$3.28 est.")).toBeInTheDocument()
    expect(within(totals).getByText("Estimated, not actual billing")).toBeInTheDocument()
  })

  it("refetches for another period and keeps it in the URL", async () => {
    const fetchSpy = mockApi({
      "GET /api/usage?period=7d": report(),
      "GET /api/usage?period=30d": report({ period: "30d", totals: { ...report().totals, reviews: 17 } }),
    })
    renderWithProviders(<App />, { route: "/usage" })
    await screen.findByRole("region", { name: "Usage totals" })

    await userEvent.click(screen.getByRole("tab", { name: "30D" }))

    expect(await within(screen.getByRole("region", { name: "Usage totals" })).findByText("17")).toBeInTheDocument()
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === "/api/usage?period=30d")).toBe(true)
  })

  it("switches the table between costs and tokens, and models and repositories", async () => {
    mockApi({ "GET /api/usage?period=7d": report() })
    renderWithProviders(<App />, { route: "/usage" })

    const byModel = await screen.findByRole("table", { name: "Usage by model" })
    expect(within(byModel).getByText(SONNET)).toBeInTheDocument()
    expect(within(byModel).getByRole("columnheader", { name: /Cached cost/ })).toBeInTheDocument()
    expect(within(byModel).getByText("$2.98")).toBeInTheDocument()

    await userEvent.click(within(screen.getByRole("tablist", { name: "Table values" })).getByRole("tab", { name: "Tokens" }))
    const tokens = screen.getByRole("table", { name: "Usage by model" })
    // Uncached input is shown apart from the cache reads.
    expect(within(tokens).getByText("850,000")).toBeInTheDocument()
    expect(within(tokens).getByText("1,370,000")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("combobox", { name: "Group usage by" }))
    await userEvent.click(await screen.findByRole("option", { name: "Usage by Repository" }))
    const byRepo = await screen.findByRole("table", { name: "Usage by repository" })
    expect(within(byRepo).getByText("acme/web")).toBeInTheDocument()
  })

  it("shows a model without a price at $0", async () => {
    mockApi({
      "GET /api/usage?period=7d": report({
        byModel: [
          { ...report().byModel[0]!, model: PROXY, provider: "openai", cost: { input: 0, cached: 0, output: 0, total: 0 } },
        ],
      }),
    })
    renderWithProviders(<App />, { route: "/usage" })

    const row = (await screen.findByRole("table", { name: "Usage by model" })).querySelector("tbody tr")!
    expect(within(row as HTMLElement).getByText(PROXY)).toBeInTheDocument()
    expect(within(row as HTMLElement).getAllByText("$0.00")).toHaveLength(4)
  })

  it("links recent reviews to their pages", async () => {
    mockApi({ "GET /api/usage?period=7d": report() })
    renderWithProviders(<App />, { route: "/usage" })

    const recent = await screen.findByRole("list", { name: "Recent reviews" })
    expect(within(recent).getByRole("link", { name: "Add b and c" })).toHaveAttribute("href", "/reviews/rev-1")
    expect(within(recent).getByText("~$0.62 est.")).toBeInTheDocument()
  })

  it("shows empty states without usage", async () => {
    const empty = report({
      totals: { reviews: 0, calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: { usd: 0 } },
      series: [{ start: "2026-10-23T00:00:00.000Z", calls: 0, tokens: 0, usd: 0 }],
      byModel: [],
      byProvider: [],
      byRepository: [],
      recent: [],
    })
    mockApi({ "GET /api/usage?period=7d": empty })
    renderWithProviders(<App />, { route: "/usage" })

    expect(await screen.findByText("No data for this period")).toBeInTheDocument()
    expect(screen.getByText("No provider usage yet")).toBeInTheDocument()
    expect(screen.getByText("No model usage yet")).toBeInTheDocument()
    expect(screen.getByText("No reviews with model usage in this period.")).toBeInTheDocument()
    expect(screen.getByText("No usage recorded in this period.")).toBeInTheDocument()
  })

  it("draws the charts when there is data", async () => {
    mockApi({ "GET /api/usage?period=7d": report() })
    const { container } = renderWithProviders(<App />, { route: "/usage" })

    await screen.findByRole("region", { name: "Usage totals" })
    await waitFor(() => expect(container.querySelectorAll('[data-slot="chart"]')).toHaveLength(3))
  })
})

describe("bucketLabel", () => {
  it("labels hours in UTC, as the buckets are, whatever the viewer's time zone", () => {
    vi.stubEnv("TZ", "America/New_York")
    try {
      expect(bucketLabel("2026-01-15T14:00:00.000Z", "hour")).toMatch(/^(14:00|02:00\sPM)$/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
