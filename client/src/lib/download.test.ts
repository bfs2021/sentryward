import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { downloadFile, downloadText } from "./download"

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

describe("downloadFile", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:file")
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("waits for fetched text and saves it", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    await downloadFile(Promise.resolve("# Review"), "review.md", "Markdown", "text/markdown")

    expect(click).toHaveBeenCalledOnce()
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("review.md")
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    expect(await blob.text()).toBe("# Review")
  })

  it("toasts and saves nothing when the text cannot be fetched", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    const showError = vi.spyOn(toast, "error").mockReturnValue("download-error")

    await downloadFile(Promise.reject(new Error("boom")), "review.md", "Markdown")

    expect(showError).toHaveBeenCalledWith("Could not download the markdown")
    expect(click).not.toHaveBeenCalled()
  })
})
