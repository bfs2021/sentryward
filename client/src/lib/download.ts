// Saves text as a file through a temporary object URL, since the content is
// fetched with the session's headers and can't be a plain link.
export function downloadText(text: string, filename: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  // Attached for the click: older Firefox and some webviews ignore a click on a detached anchor.
  a.style.display = "none"
  document.body.append(a)
  a.click()
  a.remove()
  // Revoked after the click has been handled: Safari starts reading the blob asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
