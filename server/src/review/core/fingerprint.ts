import { createHash } from "node:crypto";
import type { Category, Kind } from "./severity.ts";

export interface FingerprintInput {
  file: string;
  category: Category;
  kind: Kind;
  title: string;
  ruleId?: string;
}

// Lowercased, punctuation collapsed, so small rewordings by the model still
// match. Also how a finding that moved to another file is recognised.
export function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Stable identity across runs, so the same finding is never posted twice.
// Line numbers are left out on purpose: an unrelated edit above a finding moves
// it without making it a new one. The title is normalised so small rewordings
// by the model still match.
export function fingerprint(finding: FingerprintInput): string {
  const key = [finding.file, finding.category, finding.kind, finding.ruleId ?? "", normaliseTitle(finding.title)].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
