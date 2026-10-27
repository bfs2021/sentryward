import { describe, expect, it } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"
import type { BenchmarkReport, FindingFigures } from "@/features/benchmarks/types"

const SONNET = "anthropic/claude-sonnet-5-5"
const HAIKU = "anthropic/claude-haiku-5-5"
const PROXY = "openai/my-proxy"

const figures = (found: number, confirmed: number, falsePositives: number): FindingFigures => {
  const decided = confirmed + falsePositives
  return {
    found,
    confirmed,
    falsePositives,
    decided,
    confirmedRate: decided ? Math.round((confirmed / decided) * 100) : null,
    falsePositiveRate: decided ? Math.round((falsePositives / decided) * 100) : null,
  }
}

const tokens = { calls: 4, inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000 }

function report(overrides: Partial<BenchmarkReport> = {}): BenchmarkReport {
  return {
    period: "30d",
    minSample: 5,
    totals: {
      ...tokens,
      reviews: 3,
      cost: { usd: 1.5, partial: true, perReview: 0.5 },
      medianDurationMs: 95_000,
      findings: figures(20, 12, 2),
      duplicates: { count: 3, rate: 13 },
    },
    byModel: [
      { ...tokens, model: SONNET, reviews: 2, cost: { usd: 1.5, partial: false, perReview: 0.75 }, meanLatencyMs: 4_000, findings: figures(14, 9, 1) },
      { ...tokens, model: PROXY, reviews: 1, cost: { usd: null, partial: false, perReview: null }, meanLatencyMs: null, findings: figures(6, 3, 1) },
    ],
    byRepository: [
      {
        ...tokens,
        repositoryId: "r1",
        fullPath: "acme/web",
        reviews: 3,
        cost: { usd: 1.5, partial: true, perReview: 0.5 },
        medianDurationMs: 95_000,
        findings: figures(20, 12, 2),
        duplicates: { count: 3, rate: 13 },
      },
    ],
    byLanguage: [
      {
        key: "typescript",
        findings: figures(12, 8, 1),
        models: [
          { model: SONNET, ...figures(8, 6, 0) },
          { model: HAIKU, ...figures(3, 2, 1) },
          { model: PROXY, ...figures(9, 1, 1) },
          { model: null, ...figures(1, 0, 0) },
        ],
        best: SONNET,
      },
    ],
    byCategory: [{ key: "security", findings: figures(5, 1, 0), models: [{ model: SONNET, ...figures(5, 1, 0) }], best: SONNET }],
    ...overrides,
  }
}

const REPOS = { repos: [{ id: "r1", fullPath: "acme/web" }] }

describe("Benchmarks page", () => {
  it("is reachable from the sidebar and compares models", async () => {
    mockApi({ "GET /api/reviews": { reviews: [], total: 0 }, "GET /api/repos": REPOS, "GET /api/benchmarks?period=30d": report() })
    renderWithProviders(<App />, { route: "/home" })

    await userEvent.click(await screen.findByRole("link", { name: "Benchmarks" }))

    const totals = await screen.findByRole("region", { name: "Benchmark totals" })
    expect(within(totals).getByText("≥ $1.50")).toBeInTheDocument()
    expect(within(totals).getByText("1m 35s")).toBeInTheDocument()
    expect(within(totals).getByText("86%")).toBeInTheDocument()
    expect(within(totals).getByText("13%")).toBeInTheDocument()

    const models = screen.getByRole("table", { name: "Benchmarks by model" })
    const sonnet = within(models).getByText(SONNET).closest("tr")!
    expect(within(sonnet).getByText("$1.50")).toBeInTheDocument()
    expect(within(sonnet).getByText("4s")).toBeInTheDocument()
    expect(within(sonnet).getByText("90%")).toBeInTheDocument()
    // No price for the proxy: unknown, linking to where prices are set.
    const proxy = within(models).getByText(PROXY).closest("tr")!
    expect(within(proxy).getAllByRole("link", { name: "Unknown" })[0]).toHaveAttribute("href", "/llm-connections?tab=prices")
  })

  it("marks the best model per language and dims those with few findings, then switches to categories", async () => {
    mockApi({ "GET /api/repos": REPOS, "GET /api/benchmarks?period=30d": report() })
    renderWithProviders(<App />, { route: "/benchmarks" })

    const table = await screen.findByRole("table", { name: "Findings by language and model" })
    expect(within(within(table).getByText(SONNET).closest("tr")!).getByText("Best")).toBeInTheDocument()
    expect(within(within(table).getByText(HAIKU).closest("tr")!).getByText("few findings")).toBeInTheDocument()
    // Many found but few decided is still too few to judge.
    expect(within(within(table).getByText(PROXY).closest("tr")!).getByText("few findings")).toBeInTheDocument()
    expect(within(table).getByText("Tools and rules")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("tab", { name: "By category" }))
    const categories = await screen.findByRole("table", { name: "Findings by category and model" })
    expect(within(categories).getByText("Security")).toBeInTheDocument()
  })

  it("refetches for another period and repository, keeping both in the URL", async () => {
    const fetchSpy = mockApi({
      "GET /api/repos": REPOS,
      "GET /api/benchmarks?period=30d": report(),
      "GET /api/benchmarks?period=7d": report({ period: "7d" }),
      "GET /api/benchmarks?period=7d&repoId=r1": report({ period: "7d" }),
    })
    renderWithProviders(<App />, { route: "/benchmarks" })
    await screen.findByRole("region", { name: "Benchmark totals" })

    await userEvent.click(screen.getByRole("tab", { name: "7D" }))
    await userEvent.click(screen.getByRole("combobox", { name: "Repository" }))
    await userEvent.click(await screen.findByRole("option", { name: "acme/web" }))

    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith("/api/benchmarks?period=7d&repoId=r1"))).toBe(true),
    )
  })

  it("shows empty tables for a period without reviews", async () => {
    const none = figures(0, 0, 0)
    mockApi({
      "GET /api/repos": REPOS,
      "GET /api/benchmarks?period=30d": report({
        totals: { ...tokens, reviews: 0, cost: { usd: 0, partial: false, perReview: null }, medianDurationMs: null, findings: none, duplicates: { count: 0, rate: null } },
        byModel: [],
        byRepository: [],
        byLanguage: [],
        byCategory: [],
      }),
    })
    renderWithProviders(<App />, { route: "/benchmarks" })

    expect(await screen.findByText("No model calls in this period.")).toBeInTheDocument()
    expect(screen.getByText("No reviews in this period.")).toBeInTheDocument()
    expect(screen.getByText("No findings in this period.")).toBeInTheDocument()
  })
})
