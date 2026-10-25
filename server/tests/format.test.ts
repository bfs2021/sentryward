import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatInstruction, parseLenient } from "../src/review/llm/format.ts";
import {
  repairReviewOutput,
  repairWalkthroughOutput,
  reviewOutputSchema,
  walkthroughOutputSchema,
} from "../src/review/llm/schemas.ts";
import { modelFinding } from "./helpers/model.ts";

const list = z.object({ items: z.array(z.object({ n: z.number() })) });

describe("parseLenient", () => {
  it("reads plain JSON", () => {
    expect(parseLenient('{"items":[{"n":1}]}', list)).toEqual({ items: [{ n: 1 }] });
  });

  it("strips a code fence and surrounding prose", () => {
    const text = 'Sure, here you go:\n```json\n{"items": [{"n": 1}]}\n```\nAnything else?';
    expect(parseLenient(text, list)).toEqual({ items: [{ n: 1 }] });
  });

  it("keeps the complete elements of a reply cut off mid-element", () => {
    const text = '{"items": [{"n": 1}, {"n": 2}, {"n": 3, "note": "brace } in a str';
    expect(parseLenient(text, list)).toEqual({ items: [{ n: 1 }, { n: 2 }] });
  });

  it("rejects a reply with no JSON object", () => {
    expect(() => parseLenient("Looks good to me.", list)).toThrow("reply contained no JSON object");
  });

  it("rejects JSON that does not match the schema", () => {
    expect(() => parseLenient('{"items": "none"}', list)).toThrow(/reply did not match schema/);
  });
});

describe("formatInstruction", () => {
  it("embeds the JSON Schema with field descriptions", () => {
    const text = formatInstruction(reviewOutputSchema, "code_review");
    expect(text).toContain("(code_review)");
    expect(text).toContain("Path exactly as given in the FILE header");
  });
});

describe("repairReviewOutput", () => {
  const parse = (raw: unknown) => parseLenient(JSON.stringify(raw), reviewOutputSchema, repairReviewOutput);

  it("accepts snake_case keys, loose enums and numeric strings", () => {
    const { findings } = parse({
      findings: [
        {
          file: "src/app.ts",
          start_line: "11",
          severity: "Major",
          category: "bug",
          kind: "Potential Issue",
          effort: "quick-win",
          title: "t",
          body: "b",
          confidence: "0.8",
          evidence: "execution path",
          evidence_note: "n",
        },
      ],
    });
    expect(findings).toEqual([
      expect.objectContaining({
        startLine: 11,
        endLine: 11,
        severity: "major",
        kind: "potential_issue",
        effort: "quick_win",
        confidence: 0.8,
        evidence: "execution_path",
        evidenceNote: "n",
        evidenceFiles: [],
        suggestion: null,
      }),
    ]);
  });

  it("defaults a missing impact and fix rationale to empty strings", () => {
    const { impact: _, fixRationale: __, ...rest } = modelFinding();
    const { findings } = parse({ findings: [rest, { ...modelFinding(), fix_rationale: "Bounds the sum." }] });
    expect(findings.map((f) => [f.impact, f.fixRationale])).toEqual([
      ["", ""],
      ["", "Bounds the sum."],
    ]);
  });

  it("defaults an unknown evidence to unverified", () => {
    const { findings } = parse({ findings: [{ ...modelFinding(), evidence: "gut feeling" }] });
    expect(findings[0]!.evidence).toBe("unverified");
  });

  it("drops a finding it cannot repair and keeps the rest", () => {
    const { findings } = parse({
      findings: [modelFinding({ title: "kept" }), { ...modelFinding(), severity: "catastrophic" }, "junk"],
    });
    expect(findings.map((finding) => finding.title)).toEqual(["kept"]);
  });
});

describe("repairWalkthroughOutput", () => {
  it("fills missing lists and normalises effort and blast radius", () => {
    const output = parseLenient(
      JSON.stringify({ overview: "o", estimated_effort: "2", blast_radius: "huge", fileSummaries: [{ path: 1 }] }),
      walkthroughOutputSchema,
      repairWalkthroughOutput,
    );
    expect(output).toEqual({ overview: "o", fileSummaries: [], labels: [], estimatedEffort: 2, blastRadius: "medium" });
  });
});
