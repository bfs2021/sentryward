import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { ConfigOverride } from "../src/review/config/schema.ts";
import type { ContextSource } from "../src/review/context/gather.ts";
import { floorBlastRadius, riskyAreas } from "../src/review/context/risk.ts";
import { runReview } from "../src/review/pipeline.ts";
import { walkthroughMarkdown } from "../src/review/render/markdown.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { WALKTHROUGH, fakeModel } from "./helpers/model.ts";

const config = (override: ConfigOverride = {}) => resolveConfig({ trigger: override }).config;
const now = () => new Date("2026-10-04T12:00:00Z");

const ROUTE_PATCH = [
  "@@ -3,3 +3,3 @@",
  " ",
  '-router.get("/users", requireAuth, list);',
  '+router.get("/users", list);',
  "+// requireAuth moved to the gateway",
].join("\n");

const files = () =>
  makeChangeSet([
    { path: "src/routes/users.ts", changeType: "modified", patch: ROUTE_PATCH },
    {
      path: "src/services/jobs.ts",
      changeType: "modified",
      patch: ["@@ -1,2 +1,3 @@", " export async function finish(id) {", "+  await db.reviewJob.update({ where: { id } });", "+  cache.delete(id);"].join("\n"),
    },
    { path: "prisma/schema.prisma", changeType: "modified", patch: "@@ -1,1 +1,2 @@\n model A {\n+  b Int" },
    { path: "src/util/strings.ts", changeType: "modified", patch: "@@ -1,1 +1,2 @@\n const a = 1;\n+map.delete(key);" },
  ]).files;

describe("riskyAreas", () => {
  it("finds removed auth checks, database writes, schema changes and routes in the diff", () => {
    expect(riskyAreas(files())).toEqual([
      { kind: "auth", path: "src/routes/users.ts", reason: "removes an authorization check", removesCheck: true },
      { kind: "api", path: "src/routes/users.ts", reason: "changes an API route" },
      { kind: "database", path: "src/services/jobs.ts", reason: "changes a database write" },
      { kind: "database", path: "prisma/schema.prisma", reason: "changes the database schema" },
    ]);
  });

  it("adds handlers and auth modules reached only through callers", () => {
    const reach = [
      { path: "bin/cli.ts", chain: ["main"], hops: 1 },
      { path: "src/routes/serve.ts", chain: ["main", "run"], hops: 2 },
      { path: "src/middleware/auth.ts", chain: ["main"], hops: 1 },
    ];
    expect(riskyAreas([], reach)).toEqual([
      { kind: "api", path: "src/routes/serve.ts", reason: "calls run, 2 hops from the change", via: "main -> run" },
      { kind: "auth", path: "src/middleware/auth.ts", reason: "calls main, directly from the change", via: "main" },
    ]);
  });

  it("only ever raises the blast radius", () => {
    expect(floorBlastRadius("small", [])).toBe("small");
    expect(floorBlastRadius("small", [{ kind: "api", path: "a", reason: "r" }])).toBe("small");
    expect(floorBlastRadius("small", [{ kind: "database", path: "a", reason: "r" }])).toBe("medium");
    expect(floorBlastRadius("medium", [{ kind: "auth", path: "a", reason: "r", removesCheck: true }])).toBe("large");
    expect(floorBlastRadius("small", [{ kind: "api", path: "a", reason: "r", via: "main" }])).toBe("large");
    expect(floorBlastRadius("large", [{ kind: "database", path: "a", reason: "r" }])).toBe("large");
  });
});

describe("risky areas in the walkthrough", () => {
  it("tells the walkthrough, raises its blast radius and renders next to it", async () => {
    const { generate, requests } = fakeModel({ code_review: { findings: [] }, walkthrough: WALKTHROUGH });
    const changeSet = makeChangeSet([{ path: "src/routes/users.ts", changeType: "modified", patch: ROUTE_PATCH }]);

    const result = await runReview({ changeSet, config: config({ review: { fileContext: false } }) }, { generate, now });

    const prompt = requests.find((request) => request.schemaName === "walkthrough")!.prompt;
    expect(prompt).toContain("Sensitive areas the diff touches");
    expect(prompt).toContain("- authorization: src/routes/users.ts removes an authorization check");
    expect(result.walkthrough!.blastRadius).toBe("large");
    expect(result.walkthrough!.riskyAreas).toHaveLength(2);

    const markdown = walkthroughMarkdown(result);
    expect(markdown).toContain("💥 Blast radius: large");
    expect(markdown).toContain("<summary>⚠️ Risky areas (2)</summary>");
    expect(markdown).toContain("| authorization | `src/routes/users.ts` | removes an authorization check |");
    expect(walkthroughMarkdown(result, { blastRadius: false })).not.toContain("Risky areas");

    const { riskyAreas: _areas, ...stored } = result.walkthrough!;
    expect(walkthroughMarkdown({ ...result, walkthrough: stored })).not.toContain("Risky areas");
  });

  it("includes routes the change reaches through traced callers", async () => {
    const { generate } = fakeModel({ code_review: { findings: [] }, walkthrough: WALKTHROUGH });
    const app = ["export function main(input: string) {", "  return input;", "}", ""].join("\n");
    const cli = ["export function run(args: string[]) {", "  return main(args[0]);", "}", ""].join("\n");
    const serve = ['router.post("/run", (req, res) => {', "  res.json(run(req.body));", "});", ""].join("\n");
    const sources: Record<string, string> = { "src/app.ts": app, "bin/cli.ts": cli, "src/routes/serve.ts": serve };
    const callers: Record<string, string[]> = { main: ["bin/cli.ts"], run: ["src/routes/serve.ts"] };
    const context: ContextSource = {
      readFile: async (path) => sources[path] ?? null,
      searchCode: async (term) => callers[term] ?? [],
    };
    // The forge names the enclosing function in the hunk header.
    const patch = ["@@ -2,2 +2,2 @@ export function main(input: string) {", "-  return input.trim();", "+  return input;", " }"].join("\n");
    const changeSet = makeChangeSet([{ path: "src/app.ts", changeType: "modified", patch }]);

    const result = await runReview({ changeSet, config: config() }, { generate, now, context });

    expect(result.walkthrough!.riskyAreas).toEqual([
      { kind: "api", path: "src/routes/serve.ts", reason: "calls run, 2 hops from the change", via: "main -> run" },
    ]);
    expect(result.walkthrough!.blastRadius).toBe("large");
  });
});
