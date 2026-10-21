import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { downloadText } from "./download"

describe("downloadText", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // jsdom has no object URLs and would try to navigate on an anchor click.
    URL.createObjectURL = vi.fn(() => "blob:file")
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("clicks an anchor that is in the document and leaves none behind", () => {
    const connected: boolean[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      connected.push(this.isConnected)
    })

    downloadText("# Review", "review.md", "text/markdown")

    expect(click).toHaveBeenCalledOnce()
    expect(connected).toEqual([true])
    expect(document.querySelectorAll("a")).toHaveLength(0)
  })

  it("revokes the object URL only after the click has been handled", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    downloadText("# Review", "review.md")

    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file")
  })
})
