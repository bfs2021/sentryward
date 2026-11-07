import { jsonResponse, mockFetch } from "./renderWithProviders"

export const testUser = {
  id: "1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  role: "member" as "admin" | "member",
  avatarUpdatedAt: null as string | null,
  createdAt: "",
  hasPassword: true,
}

export const personalWorkspace = { id: "w-personal", name: "Ada Lovelace", personal: true, role: "owner" as const }
export const teamWorkspace = { id: "w-team", name: "Acme", personal: false, role: "admin" as const }
export const testWorkspaces = [personalWorkspace, teamWorkspace]

type Handler = (init?: RequestInit) => Response
export type RouteTable = Record<string, Handler | unknown>

// Answers `METHOD /api/path` (query string included when the key has one) from
// a table, with the signed-in user (and their workspaces) for /auth/me and
// /workspaces unless overridden. Unmatched
// requests return 404 so a missing stub shows up as a visible failure.
export function mockApi(routes: RouteTable) {
  return mockFetch((url, init) => {
    const method = (init?.method ?? "GET").toUpperCase()
    const path = url.replace(/^https?:\/\/[^/]+/, "")
    const keys = [`${method} ${path}`, `${method} ${path.split("?")[0]}`]
    const key = keys.find((k) => k in routes)
    if (key) {
      const route = routes[key]
      return typeof route === "function" ? (route as Handler)(init) : jsonResponse(200, route)
    }
    if (path === "/api/auth/me") return jsonResponse(200, { user: testUser, workspaces: testWorkspaces })
    if (method === "GET" && path === "/api/workspaces") return jsonResponse(200, { workspaces: testWorkspaces })
    return jsonResponse(404, { message: `No stub for ${method} ${path}` })
  })
}
