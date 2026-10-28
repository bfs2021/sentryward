import { lazy } from "react"
import { describe, expect, it, vi } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router"
import { DashboardLayout } from "./DashboardLayout"
import { mockApi } from "@/test/apiRoutes"
import { renderWithProviders } from "@/test/renderWithProviders"

const Broken = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")))

describe("DashboardLayout", () => {
  it("keeps the sidebar when a page chunk fails, and recovers on navigation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockApi({})
    renderWithProviders(
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/findings" element={<Broken />} />
          <Route path="/reviews" element={<p>Reviews page</p>} />
        </Route>
      </Routes>,
      { route: "/findings" },
    )

    expect(await screen.findByRole("alert")).toHaveTextContent("This page failed to load")
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("link", { name: "Reviews" }))
    expect(await screen.findByText("Reviews page")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("groups the navigation and names the group in the breadcrumb", async () => {
    mockApi({})
    renderWithProviders(
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/usage" element={<p>Usage page</p>} />
        </Route>
      </Routes>,
      { route: "/usage" },
    )

    await screen.findByText("Usage page")
    const labels = [...document.querySelectorAll("[data-sidebar=group-label]")].map((label) => label.textContent)
    // Administration is for instance admins only.
    expect(labels).toEqual(["Activity", "Insights", "Workspace"])
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" })
    expect(within(breadcrumb).getByText("Insights")).toBeInTheDocument()
    expect(within(breadcrumb).getByText("Usage")).toHaveAttribute("aria-current", "page")
  })
})
