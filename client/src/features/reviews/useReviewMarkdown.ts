import { useState } from "react"
import { copyToClipboard } from "@/lib/clipboard"
import { downloadFile } from "@/lib/download"
import { fetchReviewMarkdown } from "./api"

// The one place the review markdown is fetched for copying or downloading, so both
// actions share their toasts and track pending state the same way.
export function useReviewMarkdown(reviewId: string) {
  const [copying, setCopying] = useState(false)
  const [downloading, setDownloading] = useState(false)

  // The helpers turn failures into toasts, so this only has to reset the flag.
  async function track(setPending: (pending: boolean) => void, action: () => Promise<void>) {
    setPending(true)
    try {
      await action()
    } finally {
      setPending(false)
    }
  }

  return {
    copying,
    downloading,
    copy: () => track(setCopying, () => copyToClipboard(fetchReviewMarkdown(reviewId), "Markdown")),
    download: () =>
      track(setDownloading, () =>
        downloadFile(
          fetchReviewMarkdown(reviewId),
          `sentryward-review-${reviewId}.md`,
          "Markdown",
          "text/markdown;charset=utf-8",
        ),
      ),
  }
}
