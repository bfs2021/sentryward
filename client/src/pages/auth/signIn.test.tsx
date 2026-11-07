import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import { App } from "@/App"
import { jsonResponse, mockFetch, renderWithProviders } from "@/test/renderWithProviders"

// Signed out, with the given routes.
function signedOut(routes: Record<string, () => Response>) {
  return mockFetch((url, init) => {
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`
    return routes[key]?.() ?? jsonResponse(401, { message: "Not authenticated" })
  })
}

const registration =
  (overrides: Record<string, unknown> = {}) =>
  () =>
    jsonResponse(200, {
      mode: "open",
      firstUser: false,
      mailConfigured: false,
      passwordLogin: true,
      providers: [
        { id: "github", host: "github.com" },
        { id: "gitlab", host: "gitlab.acme.com" },
      ],
      ...overrides,
    })

describe("sign-in providers", () => {
  it("offers a button for each configured provider on the login page", async () => {
    signedOut({ "GET /api/auth/registration": registration() })
    renderWithProviders(<App />, { route: "/login" })

    expect(await screen.findByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/oauth/github/start?intent=login",
    )
    expect(screen.getByRole("link", { name: "Continue with GitLab" })).toBeInTheDocument()
    // The password form is still there.
    expect(screen.getByLabelText("Password")).toBeInTheDocument()
  })

  it("shows only configured providers, and none when the server lists none", async () => {
    signedOut({ "GET /api/auth/registration": registration({ providers: [{ id: "gitlab", host: "gitlab.com" }] }) })
    renderWithProviders(<App />, { route: "/login" })

    expect(await screen.findByRole("link", { name: "Continue with GitLab" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Continue with GitHub" })).not.toBeInTheDocument()
  })

  it("ignores a provider this client does not know", async () => {
    signedOut({ "GET /api/auth/registration": registration({ providers: [{ id: "bitbucket", host: "bitbucket.org" }] }) })
    renderWithProviders(<App />, { route: "/login" })

    await screen.findByLabelText("Password")
    expect(screen.queryByRole("link", { name: /Continue with/ })).not.toBeInTheDocument()
  })

  it.each([
    ["registration_closed", /Registration is closed/],
    ["invite_required", /An invite is required/],
    ["email_registered", /An account with this email already exists/],
    ["oauth_denied", /Sign-in was cancelled/],
    ["something_new", /didn't work/],
  ])("explains a %s callback error on the login page", async (code, message) => {
    signedOut({ "GET /api/auth/registration": registration() })
    renderWithProviders(<App />, { route: `/login?error=${code}` })

    expect(await screen.findByRole("alert")).toHaveTextContent(message)
  })

  it("hides the password form when password sign-in is disabled", async () => {
    signedOut({ "GET /api/auth/registration": registration({ passwordLogin: false }) })
    renderWithProviders(<App />, { route: "/login" })

    expect(await screen.findByRole("link", { name: "Continue with GitHub" })).toBeInTheDocument()
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Forgot password?" })).not.toBeInTheDocument()
  })

  it("passes an invite through from the register page", async () => {
    signedOut({ "GET /api/auth/registration": registration({ mode: "invite" }) })
    renderWithProviders(<App />, { route: "/register?invite=tok123" })

    expect(await screen.findByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/oauth/github/start?intent=login&invite=tok123",
    )
  })

  it("offers only providers on the register page when password sign-in is disabled", async () => {
    signedOut({ "GET /api/auth/registration": registration({ passwordLogin: false }) })
    renderWithProviders(<App />, { route: "/register" })

    expect(await screen.findByRole("link", { name: "Continue with GitLab" })).toBeInTheDocument()
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument()
  })
})
