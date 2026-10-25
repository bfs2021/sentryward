import { describe, expect, it } from "vitest";
import type { ReviewResult } from "../src/review/core/models.ts";
import { summarize, toJson } from "../src/review/render/json.ts";
import { inlineBody } from "../src/review/publish/inline.ts";
import { allFindingsPrompt, findingPrompt } from "../src/review/render/agentPrompt.ts";
import { BRAND_FOOTER, SUMMARY_MARKER, sanitize, toMarkdown, walkthroughMarkdown } from "../src/review/render/markdown.ts";
import { progressMarkdown } from "../src/review/render/progress.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { sampleResult } from "./helpers/result.ts";

describe("summarize and toJson", () => {
  it("counts by severity and bucket in a stable order", async () => {
    const result = await sampleResult();
    expect(summarize(result)).toEqual({
      title: "Add b and c",
      webUrl: "https://github.com/acme/web/pull/42",
      total: 4,
      bySeverity: { critical: 1, major: 1, minor: 2 },
      byBucket: { actionable: 2, outside_diff: 1, nitpick: 1 },
      hasBlocking: true,
      usageTotals: { calls: 2, inputTokens: 200, outputTokens: 40, costUsd: 0.0008 },
      usageByModel: {
        "anthropic/claude-sonnet-5-5": {
          calls: 2,
          inputTokens: 200,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 40,
          reasoningTokens: 0,
          cost: { input: 0.0004, cached: 0, cacheWrite: 0, output: 0.0004, reasoning: 0, total: 0.0008 },
        },
      },
    });
  });

  it("adds the summary and token totals to the stored result", async () => {
    const result = await sampleResult();
    const json = toJson(result);
    expect(json.findings).toEqual(result.findings);
    expect(json.usageTotals).toEqual({ calls: 2, inputTokens: 200, outputTokens: 40, costUsd: 0.0008 });
  });
});

// A rerun's view of the sample: one finding new, one back after a fix, the
// rest still open, one earlier finding fixed and one whose code moved to
// another file.
function withLifecycle(result: ReviewResult): ReviewResult {
  const [fresh, back, ...rest] = result.findings;
  return {
    ...result,
    lifecycle: {
      new: [fresh!.fingerprint],
      stillOpen: rest.map((f) => f.fingerprint),
      reopened: [back!.fingerprint],
      gone: [
        { fingerprint: "1111111111111111", title: "Off-by-one in <loop>", file: "src/app.ts", startLine: 8, endLine: 9, severity: "major", outcome: "fixed" },
        { fingerprint: "2222222222222222", title: "Unused helper", file: "src/old.ts", startLine: 3, severity: "info", outcome: "invalidated", reason: "moved" },
      ],
    },
  };
}

describe("toMarkdown", () => {
  it("renders the whole document", async () => {
    await expect(toMarkdown(withLifecycle(await sampleResult()))).toMatchFileSnapshot("__snapshots__/review.md");
  });

  describe("what changed since the last review", () => {
    it("counts and lists each group, gone findings with why", async () => {
      const markdown = toMarkdown(withLifecycle(await sampleResult()));
      expect(markdown).toContain("> 🔄 Since the last review: 1 new, 2 still open, 1 reopened, 1 fixed, 1 invalidated.");
      expect(markdown).toContain("<summary>↩️ Reopened (1)</summary>");
      expect(markdown).toContain("<summary>✅ Fixed (1)</summary>");
      expect(markdown).toContain("- 🟠 **major** `src/app.ts:8-9`: Off-by-one in &lt;loop&gt;");
      expect(markdown).toContain("- ⚪ **info** `src/old.ts:3`: Unused helper (moved to another file)");
    });

    it("leaves out empty groups, and the section on a first review", async () => {
      const result = await sampleResult();
      expect(toMarkdown(result)).not.toContain("Since the last review");
      const allStillOpen = { ...result, lifecycle: { new: [], stillOpen: result.findings.map((f) => f.fingerprint), reopened: [], gone: [] } };
      const markdown = toMarkdown(allStillOpen);
      expect(markdown).toContain("> 🔄 Since the last review: 4 still open.");
      expect(markdown).not.toContain("<summary>🆕");
    });

    it("leaves the section out when every group is empty", async () => {
      const result = await sampleResult();
      const nothing = { ...result, findings: [], lifecycle: { new: [], stillOpen: [], reopened: [], gone: [] } };
      expect(toMarkdown(nothing)).not.toContain("Since the last review");
    });

    it("is left out with lifecycle: false", async () => {
      expect(toMarkdown(withLifecycle(await sampleResult()), { lifecycle: false })).not.toContain("Since the last review");
    });

    it("caps each list and says how many more there are", async () => {
      const result = await sampleResult();
      const gone = Array.from({ length: 25 }, (_, i) => ({
        fingerprint: `${i}`.padStart(16, "0"),
        title: `Fixed ${i}`,
        file: "src/app.ts",
        startLine: i + 1,
        severity: "minor" as const,
        outcome: "fixed" as const,
      }));
      const markdown = toMarkdown({ ...result, lifecycle: { new: [], stillOpen: [], reopened: [], gone } });
      expect(markdown).toContain("<summary>✅ Fixed (25)</summary>");
      expect(markdown).toContain("`src/app.ts:20`: Fixed 19");
      expect(markdown).not.toContain("Fixed 20\n");
      expect(markdown).toContain("- …and 5 more");
    });
  });

  it("depends only on the result", async () => {
    const result = await sampleResult();
    expect(toMarkdown(result)).toBe(toMarkdown(structuredClone(result)));
  });

  it("ends with the summary marker exactly once", async () => {
    const markdown = toMarkdown(await sampleResult());
    expect(markdown.endsWith(`${SUMMARY_MARKER}\n`)).toBe(true);
    expect(markdown.split(SUMMARY_MARKER)).toHaveLength(2);
  });

  it("indexes actionable findings and details the rest", async () => {
    const markdown = toMarkdown(await sampleResult());
    expect(markdown).toContain("<summary>🛠️ Actionable comments (2)</summary>");
    expect(markdown).toContain("<summary>🧹 Nitpick comments (1)</summary>");
    expect(markdown).toContain("<summary>📍 Outside diff range comments (1)</summary>");
    expect(markdown).toContain("#### `src/app.ts:40`: Caller ignores &lt;result&gt;");
    expect(markdown).toContain("- `package-lock.json`: ignored by configuration");
  });

  describe("an incremental review", () => {
    const incremental = async (files: string[], reviewedFiles: string[], carried = 0) => {
      const result = await sampleResult();
      return toMarkdown({
        ...result,
        change: { ...result.change, headSha: "bbbbbbb2222" },
        incremental: { fromSha: "aaaaaaa1111", toSha: "bbbbbbb2222", files, carried },
        coverage: { ...result.coverage, reviewedFiles },
      });
    };

    it("names the commit range and the files reviewed again", async () => {
      const markdown = await incremental(["src/a.ts", "src/b.ts"], ["src/a.ts", "src/b.ts"], 1);
      expect(markdown).toContain(
        "> 🔁 Incremental review of `aaaaaaa..bbbbbbb`: 2 files changed since the last review were reviewed; 1 finding carried over from the earlier review.",
      );
      expect(markdown).toContain("<sub>Reviewed `aaaaaaa..bbbbbbb` with");
    });

    it("counts only the files a pass finished", async () => {
      const markdown = await incremental(["src/a.ts", "src/b.ts"], ["src/a.ts"]);
      expect(markdown).toContain(": 1 of 2 files changed since the last review was reviewed.");
    });

    it("says so when no file of the change was touched", async () => {
      const markdown = await incremental([], [], 3);
      expect(markdown).toContain(": no file of this change was touched since the last review; 3 findings carried over");
    });
  });

  const withVerdict = (result: ReviewResult, patch: Partial<ReviewResult>) => ({ ...result, ...patch });

  it("states pass and incomplete verdicts plainly", async () => {
    const base = await sampleResult();
    const clean = withVerdict(base, {
      findings: [],
      verdict: { verdict: "pass", blockOn: "critical", blocking: [] },
    });
    expect(toMarkdown(clean)).toContain("✅ **Pass**: no findings at or above critical.");
    expect(toMarkdown(clean)).toContain("\nNo findings.\n");

    const partial = withVerdict(clean, { status: "partial", verdict: { verdict: "error", blockOn: "critical", blocking: [] } });
    expect(toMarkdown(partial)).toContain(
      "⚠️ **Review incomplete**: part of the change was not reviewed, so the absence of findings is not a pass.",
    );
  });

  it("never uses an em dash", async () => {
    expect(toMarkdown(await sampleResult())).not.toContain("—");
  });
});

describe("toMarkdown with a walkthrough", () => {
  it("opens with the walkthrough under one heading, then the review", async () => {
    const result = await sampleResult();
    const merged = toMarkdown(result, { walkthrough: true });
    expect(merged.match(/^#{2,3} /gm)).toEqual(["## "]);
    expect(merged).toMatch(/^## Summary\n\nAdds b and c\./);
    expect(merged.indexOf("Review effort:")).toBeLessThan(merged.indexOf("**Blocked**"));
    expect(merged.trimEnd().endsWith(SUMMARY_MARKER)).toBe(true);
    expect(toMarkdown(result, { walkthrough: false })).toMatch(/^## Summary\n\n⛔ \*\*Blocked\*\*/);
  });
  it("opens with the high-level summary in the overview's place when it is placed there", async () => {
    const result = await sampleResult();
    const withSummary = { ...result, walkthrough: { ...result.walkthrough!, highLevelSummary: "- Adds b" } };
    const placed = toMarkdown(withSummary, { highLevelSummary: true });
    expect(placed).toMatch(/^## High-level summary\n\n- Adds b\n/);
    expect(placed).not.toContain("Adds b and c.");
    expect(placed).toContain("Review effort:");
    // Placed in the description, or missing from the stored review: the overview stays.
    expect(toMarkdown(withSummary)).toMatch(/^## Summary\n\nAdds b and c\./);
    expect(toMarkdown(result, { highLevelSummary: true })).toMatch(/^## Summary\n\nAdds b and c\./);
  });
});

describe("review stats line", () => {
  it("is on by default and can be left out, keeping the footer and marker", async () => {
    const result = await sampleResult();
    expect(toMarkdown(result)).toContain("<sub>Reviewed `head` with");
    const without = toMarkdown(result, { stats: false });
    expect(without).not.toContain("<sub>Reviewed `");
    expect(without.trimEnd().endsWith(`${BRAND_FOOTER}\n\n${SUMMARY_MARKER}`)).toBe(true);
  });
});

describe("walkthrough meta line", () => {
  it("shows the labels and blast radius by default and leaves each out on its own", async () => {
    const result = await sampleResult();
    expect(toMarkdown(result)).toContain("🏷️ Labels: `feature` · ⏱️ Review effort: 1/5 · 💥 Blast radius: small");
    expect(toMarkdown(result, { labels: false })).toContain("\n⏱️ Review effort: 1/5 · 💥 Blast radius: small\n");
    expect(toMarkdown(result, { blastRadius: false })).toContain("\n🏷️ Labels: `feature` · ⏱️ Review effort: 1/5\n");
    expect(walkthroughMarkdown(result, { labels: false, blastRadius: false })).toContain("\n⏱️ Review effort: 1/5\n");
  });

  it("is left out with every segment off, keeping the rest of the walkthrough", async () => {
    const result = await sampleResult();
    const without = toMarkdown(result, { labels: false, blastRadius: false, effort: false });
    expect(without).not.toMatch(/Labels:|Review effort:|Blast radius:/);
    expect(without).not.toMatch(/\n\n\n/);
    expect(without).toMatch(/^## Summary\n\nAdds b and c\./);
  });
});

describe("finding counts line", () => {
  it("is on by default and can be left out, keeping the verdict and sections", async () => {
    const result = await sampleResult();
    expect(toMarkdown(result)).toMatch(/\d+ findings? \(.*\): \d+ actionable, \d+ in the sections below\./);
    const without = toMarkdown(result, { counts: false });
    expect(without).not.toMatch(/actionable, \d+ in the sections below\./);
    expect(without).not.toContain("No findings.");
    expect(without).not.toMatch(/\n\n\n/);
    expect(without).toContain("<sub>Reviewed `head` with");
    expect(without.trimEnd().endsWith(`${BRAND_FOOTER}\n\n${SUMMARY_MARKER}`)).toBe(true);
  });
});

describe("agent prompts", () => {
  const ALL = "Prompt for AI agents (4 findings)";

  it("adds one prompt for every finding to the summary by default", async () => {
    const result = await sampleResult();
    const markdown = toMarkdown(result);
    expect(markdown).toContain(`<summary>🤖 ${ALL}</summary>`);
    for (const finding of result.findings) expect(markdown).toContain(`[${finding.severity}] ${finding.file}:`);
    expect(toMarkdown(result, { agentPrompt: false })).not.toContain(ALL);
  });

  it("leaves the summary prompt out when there are no findings", async () => {
    const clean: ReviewResult = { ...(await sampleResult()), findings: [] };
    expect(toMarkdown(clean)).not.toContain(ALL);
  });

  it("puts a prompt for its own finding in each inline comment, unless turned off", async () => {
    const [finding] = (await sampleResult()).findings;
    const body = inlineBody(finding!, "github");
    expect(body).toContain("<summary>🤖 Prompt for AI agents</summary>");
    expect(body).toContain(findingPrompt(finding!));
    expect(body.indexOf("Prompt for AI agents")).toBeLessThan(body.indexOf(BRAND_FOOTER));
    expect(inlineBody(finding!, "github", { agentPrompt: false })).not.toContain("Prompt for AI agents");
  });

  it("collapses the evidence between the suggestion and the agent prompt", async () => {
    const [finding] = (await sampleResult()).findings;
    const body = inlineBody({ ...finding!, evidenceNote: "Called with user input.", suggestion: "const fixed = true;\n" }, "github");
    expect(body).not.toContain("<sub>Evidence");
    const evidence = body.indexOf("<summary>🔎 Evidence</summary>");
    expect(evidence).toBeGreaterThan(body.indexOf("```suggestion"));
    expect(evidence).toBeLessThan(body.indexOf("Prompt for AI agents"));
    expect(body).toContain("Called with user input.");
  });

  it("names the file and lines and carries the suggested fix", async () => {
    const result = await sampleResult();
    const finding = { ...result.findings[0]!, title: "Plain title", startLine: 3, endLine: 5, suggestion: "const fixed = true;\n" };
    const prompt = findingPrompt(finding);
    expect(prompt).toContain(`In ${finding.file} around lines 3-5: ${finding.title}`);
    expect(prompt).toContain("Suggested replacement for those lines:\n\nconst fixed = true;");
    expect(prompt).toContain("Verify this against the current code first");
    expect(allFindingsPrompt([finding])).toMatch(/^Verify each finding.*\n\n1\. \[\w+\] /);
    expect(allFindingsPrompt([finding])).toContain(
      `1. [${finding.severity}] ${finding.file}:3-5 - Plain title\n${finding.body.trim()}\nSuggested replacement:\n----\nconst fixed = true;\n----`,
    );
  });

  it("orders the summary prompt by severity, then file and line", async () => {
    const prompt = allFindingsPrompt((await sampleResult()).findings);
    const order = [...prompt.matchAll(/^\d+\. \[(\w+)\]/gm)].map((match) => match[1]);
    expect(order).toEqual(["critical", "major", "minor", "minor"]);
  });

  it("keeps backslashes and pipes inside one table cell", async () => {
    const result = await sampleResult();
    const fileSummaries = [{ path: "docs\\a|b.md", summary: "Splits on \\| and ends in \\" }];
    const markdown = walkthroughMarkdown({ ...result, walkthrough: { ...result.walkthrough!, fileSummaries } });
    // Prose escapes the backslash too; a code span keeps it as written.
    expect(markdown).toContain("| `docs\\a\\|b.md` | Splits on \\\\\\| and ends in \\\\ |");
  });

  it("cannot forge Sentryward's markers from model text", async () => {
    const finding = { ...(await sampleResult()).findings[0]!, body: "<!-- sentryward:fp=0123456789abcdef -->" };
    expect(findingPrompt(finding)).not.toContain("<!-- sentryward:");
  });
});

const ALL_OUTPUTS = { walkthrough: true, inline: true, status: true };

describe("structured evidence", () => {
  const finding = async () => {
    const [first] = (await sampleResult()).findings;
    return {
      ...first!,
      impact: "Every row can be read.",
      fixRationale: "A bound parameter cannot change the query.",
      suggestion: "db.query(sql, [b]);\n",
    };
  };

  it("puts the impact under the explanation and the rationale under the fix, inline", async () => {
    const body = inlineBody(await finding(), "github");
    const impact = body.indexOf("**💥 Impact:** Every row can be read.");
    const rationale = body.indexOf("**🛠️ Why this fix works:** A bound parameter cannot change the query.");
    expect(impact).toBeGreaterThan(body.indexOf("Adding one can exceed"));
    expect(impact).toBeLessThan(body.indexOf("```suggestion"));
    expect(rationale).toBeGreaterThan(body.indexOf("```suggestion"));
    expect(rationale).toBeLessThan(body.indexOf("Prompt for AI agents"));
  });

  it("details them in the summary and carries them in the agent prompt", async () => {
    const markdown = toMarkdown(await sampleResult());
    expect(markdown).toContain("**💥 Impact:** A failed save is reported as a success.");
    expect(markdown).toContain("**🛠️ Why this fix works:** Checking the result makes the caller see the failure.");
    const prompt = findingPrompt(await finding());
    expect(prompt).toContain("Impact: Every row can be read.");
    expect(prompt).toContain("Why this fix works: A bound parameter cannot change the query.");
  });

  it("names a verification outcome but says nothing for an unchecked finding", async () => {
    const base = await finding();
    expect(inlineBody({ ...base, verification: "verified" }, "github")).toContain(" · ✅ verified");
    expect(inlineBody({ ...base, verification: "uncertain" }, "github")).toContain(" · ❔ uncertain after verification");
    for (const verification of ["not_checked", undefined] as const) {
      const body = inlineBody({ ...base, verification }, "github");
      expect(body).not.toContain("verified");
      expect(body).not.toContain("verification");
    }
  });

  it("never shows confidence in a forge comment", async () => {
    const result = await sampleResult();
    expect(toMarkdown(result)).not.toMatch(/confidence/i);
    for (const f of result.findings) expect(inlineBody(f, "github")).not.toMatch(/confidence/i);
  });
});

describe("progressMarkdown", () => {
  it("is a status line with no heading, linking the short SHA to the commit", () => {
    const body = progressMarkdown({ ...makeChangeSet(), forgeRef: { ...makeChangeSet().forgeRef, headSha: "abcdef1234567" } }, ALL_OUTPUTS);
    expect(body).not.toMatch(/^#/m);
    expect(body.startsWith("⏳ **Reviewing [`abcdef1`](https://github.com/acme/web/pull/42/commits/abcdef1234567)**\n")).toBe(true);
    expect(body).toContain(
      "a walkthrough and summary here, findings as inline comments on the diff and the `sentryward/review` commit status.",
    );
  });

  it("links GitLab commits inside the merge request", () => {
    const changeSet = makeChangeSet();
    changeSet.forgeRef = { ...changeSet.forgeRef, provider: "gitlab", webUrl: "https://gitlab.com/acme/web/-/merge_requests/42" };
    expect(progressMarkdown(changeSet, ALL_OUTPUTS)).toContain(
      "[`head`](https://gitlab.com/acme/web/-/merge_requests/42/diffs?commit_id=head)",
    );
  });

  it("falls back to a plain SHA and only promises what will be published", () => {
    const changeSet = makeChangeSet();
    changeSet.forgeRef = { ...changeSet.forgeRef, webUrl: undefined };
    const body = progressMarkdown(changeSet, { walkthrough: false, inline: false, status: false });
    expect(body).toContain("⏳ **Reviewing `head`**");
    expect(body).toContain("when it finishes: a summary here.</sub>");
    expect(body).not.toMatch(/walkthrough|inline|commit status/);
  });

  it("keeps the footer and then the summary marker so the review replaces it", () => {
    const body = progressMarkdown(makeChangeSet(), ALL_OUTPUTS);
    expect(body.indexOf(BRAND_FOOTER)).toBeLessThan(body.indexOf(SUMMARY_MARKER));
    expect(body.trimEnd().endsWith(SUMMARY_MARKER)).toBe(true);
  });
});

describe("branding", () => {
  it("names Sentryward only in the footer of every posted body", async () => {
    const result = await sampleResult();
    const bodies = [
      toMarkdown(result),
      walkthroughMarkdown(result),
      progressMarkdown(makeChangeSet(), ALL_OUTPUTS),
      ...result.findings.map((f) => inlineBody(f, "github")),
    ];
    for (const body of bodies) {
      expect(body).toContain(BRAND_FOOTER);
      expect(body).not.toMatch(/^#+ .*Sentryward/m);
    }
  });

  it("keeps the hidden markers after the footer", async () => {
    const result = await sampleResult();
    const summary = toMarkdown(result);
    expect(summary.indexOf(BRAND_FOOTER)).toBeLessThan(summary.indexOf(SUMMARY_MARKER));
    const inline = inlineBody(result.findings[0]!, "gitlab");
    expect(inline.trimEnd().endsWith("-->")).toBe(true);
  });
});

describe("sanitize", () => {
  it("defuses mentions but leaves emails and code alone", () => {
    expect(sanitize("ping @alice and @org/team")).toBe("ping @​alice and @​org/team");
    expect(sanitize("mail a@b.com")).toBe("mail a@b.com");
    expect(sanitize("use `@Injectable`")).toBe("use `@Injectable`");
  });

  it("stops model text from forging Sentryward's markers", () => {
    expect(sanitize("<!-- sentryward:summary -->")).not.toContain("<!-- sentryward:summary");
  });
});
