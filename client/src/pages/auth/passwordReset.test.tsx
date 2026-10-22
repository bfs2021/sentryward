import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, mockFetch, renderWithProviders } from "@/test/renderWithProviders"

const user = { id: "2", name: "Grace Hopper", email: "grace@example.com", role: "member", avatarUpdatedAt: null, createdAt: "" }

// Signed out, with the given routes.
function signedOut(routes: Record<string, () => Response>) {
  return mockFetch((url, init) => {
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`
    return routes[key]?.() ?? jsonResponse(401, { message: "Not authenticated" })
  })
}

const registration = (mailConfigured: boolean) => () =>
  jsonResponse(200, { mode: "open", firstUser: false, mailConfigured })

describe("forgot password", () => {
  it("is linked from the login page", async () => {
    signedOut({ "GET /api/auth/registration": registration(true) })
    renderWithProviders(<App />, { route: "/login" })

    expect(await screen.findByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot-password")
  })

  it("sends a reset link request and gives the same answer whatever the email", async () => {
    const fetchSpy = signedOut({
      "GET /api/auth/registration": registration(true),
      "POST /api/auth/password-reset": () => jsonResponse(202, {}),
    })
    renderWithProviders(<App />, { route: "/forgot-password" })

    await userEvent.type(await screen.findByLabelText("Email"), "grace@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }))

    expect(await screen.findByText(/If an account exists for grace@example.com/)).toBeInTheDocument()
    const sent = fetchSpy.mock.calls.find(([url]) => String(url) === "/api/auth/password-reset")
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ email: "grace@example.com" })
  })

  it("explains that an admin must help when the server can't send email", async () => {
    signedOut({ "GET /api/auth/registration": registration(false) })
    renderWithProviders(<App />, { route: "/forgot-password" })

    expect(await screen.findByText(/Ask a Sentryward admin to create a password reset link/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Send reset link" })).not.toBeInTheDocument()
  })
})

describe("reset password", () => {
  it("sets a new password and signs in", async () => {
    const fetchSpy = signedOut({
      "GET /api/auth/password-reset/tok123": () => jsonResponse(200, { email: user.email }),
      "POST /api/auth/password-reset/tok123": () => jsonResponse(200, { user, workspaces: [] }),
    })
    renderWithProviders(<App />, { route: "/reset-password/tok123" })

    expect(await screen.findByText(/Choose a new password for grace@example.com/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText("New password"), "brand-new-pass")
    await userEvent.type(screen.getByLabelText("Confirm new password"), "brand-new-pass")
    await userEvent.click(screen.getByRole("button", { name: "Set password" }))

    await screen.findByRole("heading", { name: "Overview" })
    const reset = fetchSpy.mock.calls.find(
      ([url, init]) => String(url) === "/api/auth/password-reset/tok123" && init?.method === "POST",
    )
    expect(JSON.parse(String(reset?.[1]?.body))).toEqual({
      password: "brand-new-pass",
      confirmPassword: "brand-new-pass",
    })
  })

  it("checks that the passwords match before sending", async () => {
    const fetchSpy = signedOut({
      "GET /api/auth/password-reset/tok123": () => jsonResponse(200, { email: user.email }),
    })
    renderWithProviders(<App />, { route: "/reset-password/tok123" })

    await userEvent.type(await screen.findByLabelText("New password"), "brand-new-pass")
    await userEvent.type(screen.getByLabelText("Confirm new password"), "other-pass")
    await userEvent.click(screen.getByRole("button", { name: "Set password" }))

    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument()
    expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false)
  })

  it("says when the link is invalid, used or expired", async () => {
    signedOut({
      "GET /api/auth/password-reset/old": () =>
        jsonResponse(404, { message: "This reset link is invalid or has expired" }),
    })
    renderWithProviders(<App />, { route: "/reset-password/old" })

    expect(await screen.findByText("Link not valid")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/forgot-password")
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument()
  })
})
