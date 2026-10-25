import { describe, expect, it } from "vitest";
import { parseRepoFile } from "../src/review/config/repoFile.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { Config, ConfigOverride, Rule } from "../src/review/config/schema.ts";
import { reviewSystemPrompt } from "../src/review/llm/prompt.ts";
import { runReview } from "../src/review/pipeline.ts";
import { inlineBody } from "../src/review/publish/inline.ts";
import { checkPatternRules, ruleTitle } from "../src/review/rules.ts";
import { validateFindings } from "../src/review/validate/validator.ts";
import { APP_PATCH, makeChangeSet } from "./helpers/changeSet.ts";
import { WALKTHROUGH, fakeModel, modelFinding } from "./helpers/model.ts";

const config = (override: ConfigOverride = {}): Config => resolveConfig({ trigger: override }).config;

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "no-b",
    description: "Do not declare b. Use a named constant instead.",
    severity: "major",
    ...overrides,
  };
}

describe("rules in .sentryward.yaml", () => {
  it("parses a rules list", () => {
    const yaml = [
      "rules:",
      "  - id: no-db-in-controllers",
      "    description: Controllers must not import Prisma directly.",
      "    severity: major",
      '    paths: ["server/src/controllers/**"]',
      "    pattern: 'from [\"'']@prisma/client'",
      "    good: |",
      "      const user = await users.find(id)",
    ].join("\n");
    const { override, warnings } = parseRepoFile(".sentryward.yaml", yaml);
    expect(warnings).toEqual([]);
    expect(override?.rules).toEqual([
      {
        id: "no-db-in-controllers",
        description: "Controllers must not import Prisma directly.",
        severity: "major",
        paths: ["server/src/controllers/**"],
        pattern: "from [\"']@prisma/client",
        good: "const user = await users.find(id)\n",
      },
    ]);
    expect(config().rules).toEqual([]);
  });

  it("rejects a bad pattern, a duplicate id, an unknown key and a bad id", () => {
    const yaml = [
      "rules:",
      "  - { id: a, description: x, severity: major, pattern: '(' }",
      "  - { id: a, description: x, severity: minor }",
      "  - { id: b, description: x, severity: minor, regex: x }",
      "  - { id: Bad Id, description: x, severity: minor }",
    ].join("\n");
    const { override, warnings } = parseRepoFile(".sentryward.yaml", yaml);
    expect(override).toBeUndefined();
    expect(warnings).toEqual(
      expect.arrayContaining([
        ".sentryward.yaml was ignored: rules.0.pattern: Not a valid regular expression (backreferences and lookarounds are not supported)",
        ".sentryward.yaml was ignored: rules.1.id: Duplicate rule id a",
        ".sentryward.yaml was ignored: rules.2: unknown setting regex",
        expect.stringMatching(/^\.sentryward\.yaml was ignored: rules\.3\.id: Use lowercase/),
      ]),
    );
  });

  it("rejects patterns RE2 cannot match in linear time", () => {
    for (const pattern of ["(a)\\1", "foo(?=bar)", "(?<!x)y"]) {
      const { override, warnings } = parseRepoFile(".sentryward.yaml", `rules:\n  - { id: a, description: x, severity: major, pattern: '${pattern}' }`);
      expect(override).toBeUndefined();
      expect(warnings).toEqual([
        ".sentryward.yaml was ignored: rules.0.pattern: Not a valid regular expression (backreferences and lookarounds are not supported)",
      ]);
    }
  });

  it("caps the total text of rules the model checks", () => {
    const long = "x".repeat(1000);
    const rules = Array.from({ length: 17 }, (_, index) => rule({ id: `r${index}`, description: long }));
    expect(() => config({ rules })).toThrow(/at most 16000 characters/);
    // Pattern rules never reach the prompt, so they do not count.
    expect(() => config({ rules: rules.map((r) => ({ ...r, pattern: "b" })) })).not.toThrow();
  });
});

describe("checkPatternRules", () => {
  const changeSet = makeChangeSet([
    { path: "src/app.ts", changeType: "modified", patch: APP_PATCH },
    { path: "lib/util.ts", changeType: "modified", patch: APP_PATCH },
  ]);
  const check = (rules: Rule[], override: ConfigOverride = {}, ignored?: Set<string>) =>
    checkPatternRules(changeSet.files, changeSet, config({ ...override, rules }), ignored);

  it("reports added lines that match, in the files the rule covers", () => {
    const { findings, dropped } = check([rule({ pattern: "const b\\b", paths: ["src/**"] })]);
    expect(dropped).toEqual({});
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: "rule",
      ruleId: "no-b",
      file: "src/app.ts",
      startLine: 11,
      endLine: 11,
      severity: "major",
      category: "maintainability",
      title: "Do not declare b",
      confidence: 1,
      evidence: "contract",
      bucket: "actionable",
    });
    expect(findings[0]).not.toHaveProperty("model");
  });

  it("never matches context lines", () => {
    // "const a" and "const d" are context lines of the hunk.
    expect(check([rule({ pattern: "const (a|d)" })]).findings).toEqual([]);
  });

  it("gives the same findings and fingerprints on every run", () => {
    const rules = [rule({ pattern: "const" }), rule({ id: "no-c", pattern: "c =", category: "style", severity: "minor" })];
    const first = check(rules);
    expect(first.findings).toHaveLength(6);
    expect(check(rules)).toEqual(first);
    expect(new Set(first.findings.map((finding) => finding.fingerprint)).size).toBe(6);
  });

  it("applies the floor and dismissals, but not review.categories", () => {
    const kept = check([rule({ pattern: "const b", paths: ["src/**"] })]).findings[0]!;
    const { findings, dropped } = check(
      [rule({ pattern: "const b", paths: ["src/**"] }), rule({ id: "info", severity: "info", pattern: "const c" })],
      { review: { categories: ["security"] } },
      new Set([kept.fingerprint]),
    );
    expect(findings).toEqual([]);
    expect(dropped).toEqual({ previously_ignored: 1, below_floor: 2 });
  });

  it("cannot be made to backtrack by the change's lines", () => {
    // Exponential for a backtracking engine: hours at this length.
    const patch = `@@ -1,0 +1,1 @@\n+${"a".repeat(1999)}!`;
    const evil = makeChangeSet([{ path: "src/evil.ts", changeType: "modified", patch }]);
    const started = Date.now();
    const { findings } = checkPatternRules(evil.files, evil, config({ rules: [rule({ pattern: "^(\\w+)*;" })] }), undefined);
    expect(findings).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("skips very long lines", () => {
    const patch = `@@ -1,0 +1,1 @@\n+${"a".repeat(2001)}`;
    const long = makeChangeSet([{ path: "src/min.ts", changeType: "modified", patch }]);
    expect(checkPatternRules(long.files, long, config({ rules: [rule({ pattern: "a" })] }), undefined).findings).toEqual([]);
  });

  it("titles a rule by its first sentence", () => {
    expect(ruleTitle(rule({ description: "No raw SQL; use the query builder." }))).toBe("No raw SQL");
    expect(ruleTitle(rule({ description: "Use v1.2 APIs only" }))).toBe("Use v1.2 APIs only");
  });
});

describe("model-checked rules", () => {
  const changeSet = makeChangeSet();
  const withRules = (rules: Rule[], override: ConfigOverride = {}) => config({ ...override, rules });

  it("lists rules without a pattern in the system prompt", () => {
    const prompt = reviewSystemPrompt(
      withRules([
        rule({ id: "thin-controllers", paths: ["src/**"], bad: "prisma.user.find()" }),
        rule({ id: "no-b", pattern: "const b" }),
      ]),
    );
    expect(prompt).toContain("- id: thin-controllers (severity major, category maintainability)");
    expect(prompt).toContain("applies to: src/**");
    expect(prompt).toContain("Violating example:\n      prisma.user.find()");
    expect(prompt).not.toContain("id: no-b");
    expect(reviewSystemPrompt(config())).not.toContain("Repository rules");
  });

  it("files a finding that names a rule under the rule", () => {
    const { findings } = validateFindings(
      [modelFinding({ ruleId: "thin", severity: "minor", category: "bug", evidence: "contract" })],
      changeSet,
      changeSet.files,
      withRules([rule({ id: "thin", severity: "critical", category: "style" })], { review: { categories: ["security"] } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ source: "rule", ruleId: "thin", severity: "critical", category: "style" });
  });

  it("ignores a rule id the model was not given or that does not cover the file", () => {
    const rules = [rule({ id: "elsewhere", paths: ["lib/**"] }), rule({ id: "pattern", pattern: "x" })];
    for (const ruleId of ["unknown", "elsewhere", "pattern"]) {
      const { findings } = validateFindings([modelFinding({ ruleId })], changeSet, changeSet.files, withRules(rules));
      expect(findings[0]).toMatchObject({ source: "llm" });
      expect(findings[0]).not.toHaveProperty("ruleId");
    }
  });

  it("demotes an unproven violation of a blocking rule", () => {
    const { findings, demoted } = validateFindings(
      [modelFinding({ ruleId: "thin", severity: "info", evidence: "unverified" })],
      changeSet,
      changeSet.files,
      withRules([rule({ id: "thin", severity: "critical" })]),
    );
    expect(demoted).toBe(1);
    expect(findings[0]).toMatchObject({ source: "rule", severity: "minor", kind: "verification_needed" });
  });
});

describe("runReview with rules", () => {
  const now = () => new Date("2026-10-04T12:00:00Z");
  const model = (findings = [modelFinding({ severity: "minor" })]) =>
    fakeModel({ code_review: { findings }, walkthrough: WALKTHROUGH }).generate;

  it("adds pattern rule findings, which block at block_on like any finding", async () => {
    const result = await runReview(
      {
        changeSet: makeChangeSet(),
        config: config({ review: { blockOn: "major", verify: "off" }, rules: [rule({ pattern: "const c" })] }),
      },
      { generate: model(), now },
    );
    expect(result.findings.map((finding) => finding.source).sort()).toEqual(["llm", "rule"]);
    const ruled = result.findings.find((finding) => finding.source === "rule")!;
    expect(ruled).toMatchObject({ startLine: 12, ruleId: "no-b" });
    expect(result.verdict).toMatchObject({ verdict: "blocked", blocking: [ruled.fingerprint] });
    expect(inlineBody(ruled, "github")).toContain("· rule no-b");
  });

  it("reports a violation the model found under its rule", async () => {
    const result = await runReview(
      {
        changeSet: makeChangeSet(),
        config: config({ review: { verify: "off" }, rules: [rule({ id: "thin" })] }),
      },
      { generate: model([modelFinding({ ruleId: "thin", severity: "minor", evidence: "contract" })]), now },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ source: "rule", ruleId: "thin", severity: "major", model: "anthropic/claude-sonnet-5-5" });
  });

  it("caps rule findings with the rest at max_findings", async () => {
    const result = await runReview(
      {
        changeSet: makeChangeSet(),
        config: config({ review: { maxFindings: 1, verify: "off" }, rules: [rule({ severity: "minor", pattern: "const c" })] }),
      },
      { generate: model([modelFinding({ severity: "critical", evidence: "execution_path" })]), now },
    );
    expect(result.findings.map((finding) => finding.source)).toEqual(["llm"]);
    expect(result.validation.dropped).toEqual({ over_limit: 1 });
  });
});
