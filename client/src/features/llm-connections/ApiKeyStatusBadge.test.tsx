import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ApiKeyStatusBadge } from "./ApiKeyStatusBadge"

describe("ApiKeyStatusBadge", () => {
  it("shows progress while the connection is being checked", () => {
    render(<ApiKeyStatusBadge status={undefined} />)

    expect(screen.getByText("Checking...")).toBeInTheDocument()
  })

  it.each([
    ["active", "Active", "text-emerald-700"],
    ["revoked", "Inactive", "text-destructive"],
    ["unreachable", "Unknown", "text-amber-700"],
    ["blocked", "Blocked by policy", "text-destructive"],
  ] as const)("renders the %s state with its color", (status, label, colorClass) => {
    render(<ApiKeyStatusBadge status={status} />)

    expect(screen.getByText(label)).toHaveClass(colorClass)
  })
})
