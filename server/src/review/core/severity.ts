import { z } from "zod";

export const SEVERITIES = ["critical", "major", "minor", "info"] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

const RANK: Record<Severity, number> = { critical: 3, major: 2, minor: 1, info: 0 };

export function severityRank(severity: Severity): number {
  return RANK[severity];
}

export function atLeast(severity: Severity, floor: Severity): boolean {
  return RANK[severity] >= RANK[floor];
}

export const CATEGORIES = [
  "security",
  "bug",
  "performance",
  "logic",
  "reliability",
  "maintainability",
  "testing",
  "style",
  "docs",
] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof categorySchema>;

export const KINDS = [
  "potential_issue",
  "refactor_suggestion",
  "nitpick",
  // Assigned by the validator to a blocker that named no evidence.
  "verification_needed",
  // Something a linked issue asked for that the change does not do.
  "requirement_gap",
] as const;
export const kindSchema = z.enum(KINDS);
export type Kind = z.infer<typeof kindSchema>;

// What makes a finding true. Confidence is how sure the model feels; this is
// what it can point at, and it is what the blocker policy judges.
export const EVIDENCE = ["execution_path", "reproduction", "contract", "static_tool", "unverified"] as const;
export const evidenceSchema = z.enum(EVIDENCE);
export type Evidence = z.infer<typeof evidenceSchema>;

// What the verifier (review.verify) made of a finding: confirmed by a second
// look, left undecided, or never checked (verify off, not a candidate, or the
// call failed). Recorded so readers can tell a finding that survived a second
// check from one nobody re-examined.
export const VERIFICATIONS = ["verified", "uncertain", "not_checked"] as const;
export const verificationSchema = z.enum(VERIFICATIONS);
export type Verification = z.infer<typeof verificationSchema>;

export const EFFORTS = ["quick_win", "moderate", "heavy_lift"] as const;
export const effortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof effortSchema>;
