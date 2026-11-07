import { useLayoutEffect, useRef, type ReactNode } from "react"
import Markdown, { type Components } from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import { MermaidDiagram } from "@/components/MermaidDiagram"
import { cn } from "@/lib/utils"
import type { ForgeProvider } from "./api"
import { CHANGE_ATTRIBUTE, markBlocks, snapshot, type Snapshot } from "./previewChanges"

// GitHub and GitLab render comment markdown with their own sanitising: raw
// HTML such as <details> and <sub> survives, HTML comments (Sentryward's hidden
// markers) do not show. The default schema is GitHub's.
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Keep the info string of ```suggestion:-0+0 so it can be recognised.
    code: [["className", /^language-./]],
  },
}

// Forge-like typography, scoped to the rendered markdown (the project has no
// typography plugin).
const PROSE = cn(
  "text-sm leading-relaxed break-words",
  "[&>*+*]:mt-3 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-base [&_h2]:font-semibold",
  "[&_h3]:text-sm [&_h3]:font-semibold [&_h4]:text-sm [&_h4]:font-semibold",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li+li]:mt-1",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.85em]",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs",
  "[&_table]:w-full [&_table]:text-xs [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:px-2 [&_td]:py-1",
  "[&_details]:rounded-md [&_details]:border [&_details]:px-3 [&_details]:py-2.5 [&_summary]:cursor-pointer [&_summary]:font-medium [&_summary]:select-none",
  // Collapsed blocks (agent prompts, evidence) get the same rhythm inside as
  // the comment has outside, and long prompt lines wrap instead of scrolling.
  "[&_details>*+*]:mt-3 [&_details[open]>summary]:border-b [&_details[open]>summary]:pb-2",
  "[&_details_pre]:max-h-96 [&_details_pre]:overflow-y-auto [&_details_pre]:leading-relaxed [&_details_pre]:whitespace-pre-wrap",
  "[&_sub]:text-xs [&_sub]:text-muted-foreground [&_sub]:align-baseline",
  "[&_sub_img]:inline [&_sub_img]:align-text-bottom",
)

function SuggestedChange(props: { original: string[]; suggestion: string; provider: ForgeProvider }) {
  return (
    <div className="overflow-hidden rounded-md border text-xs" role="group" aria-label="Suggested change">
      <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1.5">
        <span className="font-medium">Suggested change</span>
        <span className="rounded border bg-background px-1.5 py-0.5 text-muted-foreground">
          {props.provider === "github" ? "Commit suggestion" : "Apply suggestion"}
        </span>
      </div>
      {/* A div, not a pre, so the prose styles for code blocks leave it alone. */}
      <div className="overflow-x-auto font-mono whitespace-pre">
        {props.original.map((line, i) => (
          <div key={`-${i}`} className="bg-destructive/10 px-3">
            {`- ${line}`}
          </div>
        ))}
        {props.suggestion.split("\n").map((line, i) => (
          <div key={`+${i}`} className="bg-green-600/10 px-3">
            {`+ ${line}`}
          </div>
        ))}
      </div>
    </div>
  )
}

// Comment markdown as the forge shows it. `original` is the code a suggestion
// replaces, for the "Suggested change" box both forges draw.
//
// For the Display tab preview, after a setting changed: while `upcoming`
// holds the markdown about to replace this one, the blocks it no longer has
// are marked as leaving; once it is shown, a new `flash` number marks the
// blocks the previous render did not have.
export function ForgeMarkdown(props: {
  children: string
  provider: ForgeProvider
  original?: string[]
  className?: string
  flash?: number
  upcoming?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const twinRef = useRef<HTMLDivElement>(null)
  // The blocks as last shown settled, compared against when a flash arrives.
  const before = useRef<Snapshot[] | null>(null)
  const handled = useRef<number | undefined>(undefined)
  const marked = useRef<Element[]>([])
  const { flash, children: markdown } = props
  // An unchanged comment has nothing leaving, so it needs no hidden copy.
  const upcoming = props.upcoming === markdown ? undefined : props.upcoming

  // A layout effect, so a highlight is in the first frame its content shows.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    for (const element of marked.current) element.removeAttribute(CHANGE_ATTRIBUTE)
    marked.current = []
    if (upcoming !== undefined) {
      // `before` stays the content on show, which the flash compares against next.
      if (twinRef.current) marked.current = markBlocks(root, snapshot(twinRef.current), "removed")
      return
    }
    const previous = before.current
    before.current = snapshot(root)
    // Freshly mounted: the whole comment is new, which its note shows.
    if (flash === undefined || flash === handled.current || !previous) return
    handled.current = flash
    marked.current = markBlocks(root, previous, "added")
  }, [markdown, flash, upcoming])

  // `measure` draws the hidden copy of the upcoming markdown, only read for
  // its blocks: a diagram there is its key alone, so Mermaid does not run twice.
  const components = (measure: boolean): Components => ({
    pre({ node, children }): ReactNode {
      const code = node?.children[0]
      const className = code?.type === "element" ? code.properties.className : undefined
      const language = Array.isArray(className) ? String(className[0]) : ""
      const text =
        code?.type === "element" ? code.children.map((child) => (child.type === "text" ? child.value : "")).join("") : ""
      // Both forges draw ```mermaid blocks, e.g. the walkthrough's sequence diagram.
      // Keyed by its source, so the diagram finishing drawing is no change.
      if (language === "language-mermaid") {
        const source = text.replace(/\n$/, "")
        return <div data-diff-key={`mermaid:${source}`}>{!measure && <MermaidDiagram source={source} />}</div>
      }
      if (language.startsWith("language-suggestion")) {
        return (
          <SuggestedChange
            original={props.original ?? []}
            suggestion={text.replace(/\n$/, "")}
            provider={props.provider}
          />
        )
      }
      return <pre>{children}</pre>
    },
  })
  const render = (source: string, measure: boolean) => (
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]} components={components(measure)}>
      {source}
    </Markdown>
  )
  return (
    <>
      <div ref={rootRef} className={cn(PROSE, props.className)}>
        {render(markdown, false)}
      </div>
      {upcoming !== undefined && (
        <div ref={twinRef} hidden aria-hidden>
          {render(upcoming, true)}
        </div>
      )}
    </>
  )
}
