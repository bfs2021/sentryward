import picomatch from "picomatch";
import RE2 from "re2";
import type { Config, Rule } from "./config/schema.ts";
import { bucketFor } from "./core/buckets.ts";
import { fingerprint } from "./core/fingerprint.ts";
import type { ChangedFile, ChangeSet, Finding } from "./core/models.ts";
import { atLeast, type Category } from "./core/severity.ts";
import type { DropReason, ValidationResult } from "./validate/validator.ts";

// Team rules from `.sentryward.yaml`. A rule with a pattern is checked here,
// without a model; the rest are listed in the review prompt and come back as
// model findings naming the rule (validator.ts). Either way the finding has
// source "rule", the rule's id, severity and category.

export const DEFAULT_RULE_CATEGORY: Category = "maintainability";

// Longer lines (minified code, embedded data) are not matched: a violation
// there is noise nobody will act on. Cost is bounded by RE2 (config/schema.ts).
const MAX_MATCHED_LINE_CHARS = 2000;

const matchers = new WeakMap<Rule, (path: string) => boolean>();

export function ruleApplies(rule: Rule, path: string): boolean {
  if (!rule.paths?.length) return true;
  let matcher = matchers.get(rule);
  if (!matcher) {
    matcher = picomatch(rule.paths, { dot: true });
    matchers.set(rule, matcher);
  }
  return matcher(path);
}

// The rules the model is asked to check: those a pattern cannot decide.
export function modelRules(config: Config): Rule[] {
  return config.rules.filter((rule) => rule.pattern === undefined);
}

// The rule a model finding names, if it is one the model was given and it
// covers the finding's file. Anything else is an ordinary finding.
export function modelRuleFor(config: Config, ruleId: string | null | undefined, path: string): Rule | undefined {
  const id = ruleId?.trim();
  if (!id) return undefined;
  return modelRules(config).find((rule) => rule.id === id && ruleApplies(rule, path));
}

// Up to the first sentence, so a title stays one line however long the rule.
export function ruleTitle(rule: Rule): string {
  const text = rule.description.replace(/\s+/g, " ").trim();
  const end = text.search(/[.;:](\s|$)/);
  return (end > 0 ? text.slice(0, end) : text).slice(0, 200);
}

function ruleBody(rule: Rule): string {
  const good = rule.good?.trimEnd();
  return good ? `${rule.description.trim()}\n\nInstead:\n\n\`\`\`\n${good}\n\`\`\`` : rule.description.trim();
}

// Added lines with their new-file numbers, read from the hunk text the same
// way the diff is rendered for the model (context/diffText.ts).
function addedLines(file: ChangedFile): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const hunk of file.hunks) {
    let newLine = hunk.newStart;
    for (const raw of hunk.content.split("\n").slice(1)) {
      const marker = raw[0];
      if (marker === "+") {
        out.push({ line: newLine, text: raw.slice(1) });
        newLine += 1;
      } else if (marker !== "-" && marker !== "\\") {
        newLine += 1;
      }
    }
  }
  return out;
}

// Pattern rules over the added lines of the reviewed files. Pure and
// order-stable, so the same diff and rules give the same findings and
// fingerprints on every run. Held to the floor and dismissals like any other
// finding, but not to review.categories (see ruleSchema); the cap is applied
// by the caller across every source.
export function checkPatternRules(
  reviewed: ChangedFile[],
  changeSet: ChangeSet,
  config: Config,
  ignoredFingerprints?: ReadonlySet<string>,
): ValidationResult {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const kept = new Map<string, Finding>();

  for (const rule of config.rules) {
    if (rule.pattern === undefined) continue;
    // RE2, as validated by the config schema, so a change author's line cannot
    // make a pattern backtrack. No flags: a global or sticky regex would carry
    // lastIndex between lines.
    const pattern = new RE2(rule.pattern);
    const category = rule.category ?? DEFAULT_RULE_CATEGORY;
    const title = ruleTitle(rule);
    for (const file of reviewed) {
      if (!ruleApplies(rule, file.path)) continue;
      for (const { line, text } of addedLines(file)) {
        if (text.length > MAX_MATCHED_LINE_CHARS || !pattern.test(text)) continue;
        if (!atLeast(rule.severity, config.review.severityFloor)) {
          drop("below_floor");
          continue;
        }
        const kind = "potential_issue";
        const finding: Finding = {
          file: file.path,
          startLine: line,
          endLine: line,
          severity: rule.severity,
          category,
          kind,
          effort: "quick_win",
          title,
          body: ruleBody(rule),
          confidence: 1,
          evidence: "contract",
          evidenceNote: `Matches the pattern of rule ${rule.id}`,
          evidenceFiles: [],
          verification: "not_checked",
          source: "rule",
          ruleId: rule.id,
          // The matched line is part of the identity, as an analyzer's message
          // is for tool findings: two different violations in a file stay two
          // findings, and the same line text twice is reported once.
          fingerprint: fingerprint({ file: file.path, category, kind, title: `${title} ${text.trim()}`, ruleId: rule.id }),
          bucket: bucketFor({ file: file.path, startLine: line, kind }, changeSet),
        };
        if (ignoredFingerprints?.has(finding.fingerprint)) {
          drop("previously_ignored");
          continue;
        }
        if (kept.has(finding.fingerprint)) {
          drop("duplicate");
          continue;
        }
        kept.set(finding.fingerprint, finding);
      }
    }
  }

  return { findings: [...kept.values()], dropped, demoted: 0 };
}
