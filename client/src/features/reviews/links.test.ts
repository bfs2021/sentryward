import { describe, expect, it } from "vitest"
import { listItem } from "@/test/fixtures"
import { changeTitle } from "./links"

describe("changeTitle", () => {
  it("prefers the stored title, which skipped runs have without a summary", () => {
    expect(changeTitle({ ...listItem, title: "Fix login redirect", summary: null })).toBe("Fix login redirect")
  })

  it("falls back to the summary's title on rows stored before the column", () => {
    expect(changeTitle({ ...listItem, title: null })).toBe("Add b and c")
  })

  it("names the change by number before there is a title", () => {
    expect(changeTitle({ ...listItem, title: null, summary: null })).toBe("Pull request #42")
  })
})
