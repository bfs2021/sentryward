import { SEVERITIES, type Severity } from "@/features/reviews/types"
import type { FindingCategory, FindingKind, FindingLifecycle, FindingState, IgnoreReason } from "./types"

export const STATE_LABEL: Record<FindingState, string> = { open: "Open", resolved: "Resolved", ignored: "Ignored" }

export const LIFECYCLE_LABEL: Record<FindingLifecycle, string> = {
  new: "New",
  still_open: "Still open",
  reopened: "Reopened",
  fixed: "Fixed",
  invalidated: "Invalidated",
}

export const CATEGORY_LABEL: Record<FindingCategory, string> = {
  security: "Security",
  bug: "Bug",
  performance: "Performance",
  logic: "Logic",
  reliability: "Reliability",
  maintainability: "Maintainability",
  testing: "Testing",
  style: "Style",
  docs: "Docs",
}

export const KIND_LABEL: Record<FindingKind, string> = {
  potential_issue: "Potential issue",
  refactor_suggestion: "Refactor suggestion",
  nitpick: "Nitpick",
  verification_needed: "Verification needed",
  requirement_gap: "Requirement gap",
}

const options = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }))

export const STATE_OPTIONS = options(STATE_LABEL)
export const LIFECYCLE_OPTIONS = options(LIFECYCLE_LABEL)
export const CATEGORY_OPTIONS = options(CATEGORY_LABEL)
export const KIND_OPTIONS = options(KIND_LABEL)
export const SEVERITY_OPTIONS = SEVERITIES.map((value: Severity) => ({
  value,
  label: value[0]!.toUpperCase() + value.slice(1),
}))

// In the order the ignore dialog offers them.
export const IGNORE_REASONS: { value: IgnoreReason; label: string; description: string }[] = [
  { value: "false_positive", label: "False positive", description: "The finding is wrong; the code is fine as written." },
  { value: "intentional", label: "Intentional", description: "The behaviour is deliberate and accepted." },
  { value: "fix_later", label: "Fix later", description: "Valid, but it will be addressed in a follow-up." },
  { value: "not_specified", label: "Not specified", description: "No particular reason given." },
]

export const IGNORE_REASON_LABEL = Object.fromEntries(IGNORE_REASONS.map((r) => [r.value, r.label])) as Record<
  IgnoreReason,
  string
>
