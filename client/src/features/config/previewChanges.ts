import type { PreviewPublication } from "./api"

// What changed in the Display tab preview after a setting changed, so only
// that part is highlighted (ReviewPreview, ForgeMarkdown). The preview comes
// from the server, so nothing here knows which setting does what: the old and
// new previews are compared once the new one arrives.

// The attribute a highlighted element carries; index.css styles it. "added"
// is new or changed content, "removed" marks where content was taken out.
export const CHANGE_ATTRIBUTE = "data-preview-change"
export type Change = "added" | "removed"

// How long what a change takes out stays highlighted before it goes, and how
// long what it adds stays highlighted after it appears.
export const LEAVE_MS = 1000
export const HIGHLIGHT_MS = 1600

// --- The parts of the page around the comments -----------------------------

// Parts of the page to mark in one phase: "removed" ones on the old preview
// before it is replaced, "added" ones on the new preview after.
export interface PageMarks {
  labels: Set<string>
  status: boolean
  notes: { summary: boolean; walkthrough: boolean; inline: boolean }
  nothingSummary: boolean
  nothingInline: boolean
}

function summaryNothing(preview: PreviewPublication) {
  return !preview.summaryComment && !preview.walkthroughComment && !preview.status && preview.pr.labels.length === 0
}

// What is in `from` and not in `to`. Called with (old, new) it is what
// leaves; with (new, old) what arrives. A changed status counts both ways, so
// the old one is marked going and the new one coming.
function marksBetween(from: PreviewPublication, to: PreviewPublication): PageMarks {
  const kept = new Set(to.pr.labels)
  return {
    labels: new Set(from.pr.labels.filter((label) => !kept.has(label))),
    status: Boolean(from.status) && JSON.stringify(from.status) !== JSON.stringify(to.status),
    notes: {
      summary: Boolean(from.summaryComment) && !to.summaryComment,
      walkthrough: Boolean(from.walkthroughComment) && !to.walkthroughComment,
      inline: Boolean(from.inline[0]) && !to.inline[0],
    },
    nothingSummary: summaryNothing(from) && !summaryNothing(to),
    nothingInline: !from.inline[0] && Boolean(to.inline[0]),
  }
}

export function pageChanges(prev: PreviewPublication, next: PreviewPublication) {
  return { leaving: marksBetween(prev, next), entering: marksBetween(next, prev) }
}

// --- Blocks inside one comment's rendered markdown --------------------------

// What a rendered block looked like, kept between renders. Containers keep
// their children too, so a change inside "Actionable comments" can mark the
// one item that changed instead of the whole block.
export interface Snapshot {
  tag: string
  head: string
  sig: string
  children: Snapshot[]
}

const CONTAINERS = new Set(["DETAILS", "UL", "OL", "TABLE", "THEAD", "TBODY", "BLOCKQUOTE", "DIV", "SECTION"])
const MAX_DEPTH = 4

// The text of an element, with parts that draw asynchronously (a Mermaid
// diagram) standing in as their source, so a diagram that has since finished
// drawing does not read as a change.
function signature(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? ""
  if (!(node instanceof Element)) return ""
  const key = node.getAttribute("data-diff-key")
  if (key !== null) return `[${key}]`
  let text = ""
  for (const child of Array.from(node.childNodes)) text += signature(child)
  return text
}

// Pairs a changed container with its earlier self: a <details> by its
// <summary>, other containers by tag alone.
function head(element: Element) {
  if (element.tagName !== "DETAILS") return ""
  const summary = Array.from(element.children).find((child) => child.tagName === "SUMMARY")
  return summary ? signature(summary) : ""
}

function snapshotOf(element: Element, depth: number): Snapshot {
  const descend = depth < MAX_DEPTH && CONTAINERS.has(element.tagName)
  return {
    tag: element.tagName,
    head: head(element),
    sig: signature(element),
    children: descend ? Array.from(element.children).map((child) => snapshotOf(child, depth + 1)) : [],
  }
}

export function snapshot(root: Element): Snapshot[] {
  return Array.from(root.children).map((child) => snapshotOf(child, 0))
}

// Marks `root`'s children that `other` lacks with `mark`, and returns the
// marked elements. Against the old blocks that is what a change added;
// against the new ones, what it takes out. A container whose counterpart is
// found is compared child by child, so only the item that differs is marked.
export function markBlocks(root: Element, other: Snapshot[], mark: Change, depth = 0): Element[] {
  const unmatched = [...other]
  const leftover: Element[] = []
  for (const child of Array.from(root.children)) {
    const sig = signature(child)
    const same = unmatched.findIndex((old) => old.tag === child.tagName && old.sig === sig)
    if (same >= 0) unmatched.splice(same, 1)
    else leftover.push(child)
  }
  const marked: Element[] = []
  for (const child of leftover) {
    const counterpart =
      depth < MAX_DEPTH && CONTAINERS.has(child.tagName)
        ? unmatched.findIndex((old) => old.tag === child.tagName && old.head === head(child))
        : -1
    if (counterpart >= 0) {
      // Only the other side differs (e.g. it has an item this one lacks):
      // nothing here to mark, that side marks its own item.
      const [old] = unmatched.splice(counterpart, 1)
      marked.push(...markBlocks(child, old!.children, mark, depth + 1))
      continue
    }
    child.setAttribute(CHANGE_ATTRIBUTE, mark)
    marked.push(child)
  }
  return marked
}
