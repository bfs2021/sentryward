import { describe, expect, it } from "vitest";
import { parseRepoFile } from "../src/review/config/repoFile.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { Config, ConfigOverride } from "../src/review/config/schema.ts";
import { contextTokenBudget } from "../src/review/context/budget.ts";
import { planChunks } from "../src/review/context/chunk.ts";
import { changedSpan, enclosingScope, fileContextBlocks, fileLines, importBlock } from "../src/review/context/fileContext.ts";
import { fillContext, gatherContext, type ContextSource } from "../src/review/context/gather.ts";
import { estimateTokens } from "../src/review/context/budget.ts";
import {
  callLines,
  callSiteWindow,
  enclosingDeclaration,
  moduleCandidates,
  partSymbols,
  relativeImports,
} from "../src/review/context/symbols.ts";
import { inlineBody } from "../src/review/publish/inline.ts";
import { affectedLines } from "../src/review/render/markdown.ts";
import { GitHubAdapter } from "../src/review/forge/github.ts";
import { GitLabAdapter } from "../src/review/forge/gitlab.ts";
import { runReview } from "../src/review/pipeline.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { fetchStub } from "./helpers/fetchStub.ts";
import { fakeModel, modelFinding } from "./helpers/model.ts";

const config = (override: ConfigOverride = {}): Config =>
  resolveConfig({ trigger: { output: { walkthrough: false }, ...override } }).config;

// src/app.ts at the head: the change rewrites line 8 inside main().
const APP = [
  'import { helper } from "./helper.ts";',
  'import { format as fmt } from "../lib/format.js";',
  "",
  "const LIMIT = 10;",
  "",
  "export function main(input: string) {",
  "  const a = helper(input);",
  "  const b = fmt(a);",
  "  if (b.length > LIMIT) {",
  "    return b.slice(0, LIMIT);",
  "  }",
  "  return b;",
  "}",
  "",
  "export function tail() {",
  "  return 1;",
  "}",
  "",
].join("\n");

const PATCH = [
  "@@ -7,3 +7,3 @@ export function main(input: string) {",
  "   const a = helper(input);",
  "-  const b = a;",
  "+  const b = fmt(a);",
  "   if (b.length > LIMIT) {",
].join("\n");

const FORMAT = ["export function format(value: string): string {", "  return value.trim();", "}", ""].join("\n");
const CLI = ['import { main } from "../src/app.ts";', "", 'const out = main(process.argv[2] ?? "");', "console.log(out);", ""].join("\n");

const changeSet = () => makeChangeSet([{ path: "src/app.ts", changeType: "modified", patch: PATCH }]);

// Two hops out: bin/cli.ts calls main inside runCli(), and a route calls runCli.
const CLI_RUN = [
  'import { main } from "../src/app.ts";',
  "",
  "export function runCli(args: string[]) {",
  '  return main(args[0] ?? "");',
  "}",
  "",
].join("\n");
const SERVE = [
  'import { runCli } from "../../bin/cli.ts";',
  "",
  'router.post("/run", (req, res) => {',
  "  res.json(runCli(req.body.args));",
  "});",
  "",
].join("\n");

function deepSource() {
  const reads: string[] = [];
  const searches: string[] = [];
  const files: Record<string, string> = { "src/app.ts": APP, "lib/format.ts": FORMAT, "bin/cli.ts": CLI_RUN, "src/routes/serve.ts": SERVE };
  const callers: Record<string, string[]> = { main: ["src/app.ts", "bin/cli.ts"], runCli: ["src/routes/serve.ts"] };
  const context: ContextSource = {
    readFile: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
    searchCode: async (term) => {
      searches.push(term);
      return callers[term] ?? [];
    },
  };
  return { context, reads, searches };
}

function source(files: Record<string, string> = { "src/app.ts": APP, "lib/format.ts": FORMAT, "bin/cli.ts": CLI }) {
  const reads: string[] = [];
  const searches: string[] = [];
  const context: ContextSource = {
    readFile: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
    searchCode: async (term) => {
      searches.push(term);
      return term === "main" ? ["src/app.ts", "bin/cli.ts"] : [];
    },
  };
  return { context, reads, searches };
}

const SCOPE = [
  "=== CONTEXT: src/app.ts (enclosing scope) ===",
  "     6 : export function main(input: string) {",
  "       ...",
  "    10 :     return b.slice(0, LIMIT);",
  "    11 :   }",
  "    12 :   return b;",
  "    13 : }",
].join("\n");

describe("file context", () => {
  const file = changeSet().files[0]!;
  const lines = fileLines(APP);

  it("shows the enclosing function and the imports, without the hunk's own lines or diff markers", () => {
    const blocks = fileContextBlocks(file, file.hunks, lines);
    expect(blocks.map((block) => block.text)).toEqual([
      SCOPE,
      [
        "=== CONTEXT: src/app.ts (imports) ===",
        '     1 : import { helper } from "./helper.ts";',
        '     2 : import { format as fmt } from "../lib/format.js";',
      ].join("\n"),
    ]);
    expect(blocks.map((block) => block.text).join("\n")).not.toMatch(/^\s*\d+ [+-] \|/m);
  });

  it("ends the import block at the first top-level statement", () => {
    expect(importBlock(lines)).toEqual({ start: 1, end: 2 });
    expect(importBlock(fileLines('"""Docs."""\nfrom .a import b\nimport os\n\nx = 1\nimport late\n'))).toEqual({ start: 1, end: 3 });
    expect(importBlock(fileLines("const x = 1;\n"))).toBeUndefined();
    expect(importBlock(fileLines('import {\n  helper,\n  other,\n} from "./helper.ts";\n\nconst a = 1;\n'))).toEqual({ start: 1, end: 4 });
    expect(importBlock(fileLines('package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {\n}\n'))).toEqual({ start: 1, end: 5 });
    expect(importBlock(fileLines('import("./side-effect.js");\n'))).toBeUndefined();
  });

  it("falls back to a fixed window when no declaration encloses the hunk", () => {
    const deep = Array.from({ length: 300 }, (_, i) => `  line${i + 1}`);
    expect(enclosingScope(deep, 200, 200)).toEqual({ start: 170, end: 230 });
  });

  // f() spans lines 1-6; g() starts at 8.
  const TWO = fileLines("function f(x) {\n  if (!x) return;\n  const y = x.v;\n  use(y);\n  return y;\n}\n\nfunction g() {\n  return 1;\n}\n");

  it("finds the declaration when the hunk ends on the function's closing brace", () => {
    expect(enclosingScope(TWO, 4, 6)).toEqual({ start: 1, end: 6 });
  });

  it("anchors on changed lines, not forge context reaching into the next function", () => {
    const [changed] = makeChangeSet([
      {
        path: "src/f.ts",
        changeType: "modified",
        patch: ["@@ -3,6 +3,6 @@ function f(x) {", "   const y = x.v;", "-  use(x);", "+  use(y);", "   return y;", " }", " ", " function g() {"].join("\n"),
      },
    ]).files;
    const [scope] = fileContextBlocks(changed!, changed!.hunks, TWO);
    expect(scope!.text.split("\n").slice(1)).toEqual(["     1 : function f(x) {", "     2 :   if (!x) return;"]);
  });

  it("anchors a pure deletion where the lines were removed, not where the hunk starts", () => {
    // previous() is 1-3, target() 5-9; a guard after line 5 was removed.
    const head = fileLines("function previous() {\n  return 0;\n}\n\nfunction target(x) {\n  const y = x.v;\n  use(y);\n  return y;\n}\n");
    const [deleted] = makeChangeSet([
      {
        path: "src/t.ts",
        changeType: "modified",
        patch: ["@@ -3,6 +3,5 @@", " }", " ", " function target(x) {", "-  if (!x) throw new Error();", "   const y = x.v;", "   use(y);"].join("\n"),
      },
    ]).files;
    expect(changedSpan(deleted!.hunks[0]!)).toEqual([5, 6]);
    const [scope] = fileContextBlocks(deleted!, deleted!.hunks, head);
    expect(scope!.text.split("\n").slice(1)).toEqual(["     8 :   return y;", "     9 : }"]);
  });

  it("finds an indented Python scope through to the end of the file", () => {
    const py = fileLines("import os\n\ndef run(x):\n    y = x + 1\n    return y\n");
    expect(enclosingScope(py, 4, 4)).toEqual({ start: 3, end: 5 });
  });
});

describe("symbols", () => {
  it("finds names the hunk defines and calls", () => {
    expect(partSymbols(changeSet().files[0]!.hunks)).toEqual({ defined: ["main"], called: ["fmt"], contracts: new Map() });
  });

  it("marks declarations the diff changes or removes, not ones it only moves", () => {
    const patch = [
      "@@ -1,9 +1,9 @@",
      "-export function main(input: string) {",
      "+export function main(input: string, limit = LIMIT) {",
      "-function gone() {",
      "-export function moved() {",
      "+export function moved() {",
      "+export function added() {",
    ].join("\n");
    const symbols = partSymbols(makeChangeSet([{ path: "src/app.ts", changeType: "modified", patch }]).files[0]!.hunks);
    expect(symbols.contracts).toEqual(new Map([["main", "signature changed"], ["gone", "removed"]]));
    // Changed declarations are searched for first.
    expect(symbols.defined).toEqual(["main", "gone", "moved", "added"]);
  });

  it("marks a signature changed on the continuation lines of its parameter list, not in its body", () => {
    const hunks = (patch: string) => makeChangeSet([{ path: "src/repo.ts", changeType: "modified", patch }]).files[0]!.hunks;
    const signature = [
      "@@ -1,6 +1,6 @@",
      " export async function loadRepo(",
      "   id: string,",
      "-  opts?: Opts,",
      "+  opts: Opts,",
      " ): Promise<Repo> {",
      "   return find(id, opts);",
    ].join("\n");
    expect(partSymbols(hunks(signature)).contracts).toEqual(new Map([["loadRepo", "signature changed"]]));

    const body = ["@@ -1,3 +1,3 @@", " export async function loadRepo(id: string): Promise<Repo> {", "-  return find(id);", "+  return find(id, {});", " }"].join("\n");
    expect(partSymbols(hunks(body)).contracts).toEqual(new Map());

    // One-line declarations open no signature, whatever ends their line.
    const oneLine = ['@@ -1,2 +1,3 @@', ' type Status = "a" | "b"', " function id(x) { return x }", "+const next = id(1)"].join("\n");
    expect(partSymbols(hunks(oneLine)).contracts).toEqual(new Map());
  });

  it("compares a one-line declaration's signature, not its body", () => {
    const hunks = (from: string, to: string) =>
      makeChangeSet([{ path: "src/x.ts", changeType: "modified", patch: `@@ -1,1 +1,1 @@\n-${from}\n+${to}` }]).files[0]!.hunks;
    expect(partSymbols(hunks("const total = (xs) => xs.length", "const total = (xs) => xs.filter(Boolean).length")).contracts).toEqual(new Map());
    expect(partSymbols(hunks("const total = (xs) => xs.length", "const total = (xs, f) => xs.filter(f).length")).contracts).toEqual(
      new Map([["total", "signature changed"]]),
    );
  });

  it("takes a declaration moved to another file for moved, not removed, and keeps its definition", () => {
    const patch = [
      "@@ -1,4 +1,3 @@",
      "+import { slugify } from \"./text.ts\";",
      "-function slugify(s) {",
      "-  return s.toLowerCase();",
      "-}",
      " export const page = (title) => slugify(title);",
      "+export const link = (title) => `/${slugify(title)}`;",
    ].join("\n");
    const hunks = makeChangeSet([{ path: "src/page.ts", changeType: "modified", patch }]).files[0]!.hunks;
    const imported = partSymbols(hunks);
    expect(imported.contracts).toEqual(new Map());
    expect(imported.called).toContain("slugify");

    const removedOnly = ["@@ -1,3 +1,0 @@", "-function slugify(s) {", "-  return s.toLowerCase();", "-}"].join("\n");
    const gone = makeChangeSet([{ path: "src/page.ts", changeType: "modified", patch: removedOnly }]).files[0]!.hunks;
    expect(partSymbols(gone).contracts).toEqual(new Map([["slugify", "removed"]]));
    expect(partSymbols(gone, new Set(["slugify"])).contracts).toEqual(new Map());
  });

  it("finds the named declaration a call sits in, not anonymous callbacks or top-level code", () => {
    const lines = fileLines(CLI_RUN);
    expect(enclosingDeclaration(lines, 4)).toEqual({ name: "runCli", line: 3 });
    expect(enclosingDeclaration(fileLines(SERVE), 4)).toBeUndefined();
    expect(enclosingDeclaration(fileLines(CLI), 3)).toBeUndefined();
  });

  it("binds relative imports and resolves them to candidate paths", () => {
    const bindings = relativeImports(APP);
    expect(bindings.get("fmt")).toEqual({ module: "../lib/format.js", exported: "format" });
    expect(bindings.get("helper")).toEqual({ module: "./helper.ts", exported: "helper" });
    expect(moduleCandidates("src/app.ts", "../lib/format.js")).toEqual(["lib/format.js", "lib/format.ts", "lib/format.tsx"]);
    expect(moduleCandidates("src/app.ts", "./util")).toEqual(["src/util.ts", "src/util.tsx", "src/util/index.ts"]);
    expect(moduleCandidates("src/app.ts", "../../outside")).toEqual([]);

    expect(relativeImports("from .helpers import parse as p, load\n").get("p")).toEqual({ module: ".helpers", exported: "parse" });
    expect(moduleCandidates("pkg/sub/mod.py", "..util")).toEqual(["pkg/util.py", "pkg/util/__init__.py"]);
  });
});

describe("callLines", () => {
  it("matches names literally, metacharacters included", () => {
    const lines = ["const a = $fetch(url);", "", "", "", "", "axb(1);", "", "", "", "", "a.b\\(2);"];
    expect(callLines(lines, "$fetch", 3)).toEqual([1]);
    expect(callSiteWindow(lines, 1)).toEqual({ start: 1, end: 4 });
    // Unescaped, "." would also match the "x" in axb on line 6.
    expect(callLines(lines, "a.b\\", 3)).toEqual([11]);
    expect(callSiteWindow(lines, 11)).toEqual({ start: 6, end: 11 });
  });
});

describe("gatherContext", () => {
  it("adds scope, imports, definitions and callers in that order, reading each file once", async () => {
    const { context, reads, searches } = source();
    const chunks = planChunks(changeSet().files, 10_000, 3).chunks;

    const gathered = await gatherContext({ chunks, changeSet: changeSet(), source: context, budgetFor: () => 10_000, concurrency: 2 });

    const headers = gathered.contexts[0]!.split("\n").filter((line) => line.startsWith("==="));
    expect(headers).toEqual([
      "=== CONTEXT: src/app.ts (enclosing scope) ===",
      "=== CONTEXT: src/app.ts (imports) ===",
      "=== CONTEXT: lib/format.ts (definition of fmt) ===",
      "=== CONTEXT: bin/cli.ts (call sites of main) ===",
    ]);
    expect(gathered.contexts[0]).toContain("     3 : const out = main(process.argv[2] ?? \"\");");
    expect(gathered.warnings).toEqual([]);
    // The changed file itself is never fetched as a caller.
    expect(reads.sort()).toEqual(["bin/cli.ts", "lib/format.js", "lib/format.ts", "src/app.ts"]);
    expect(searches).toEqual(["main"]);
  });

  it("follows callers of callers up to the depth, the further hops last", async () => {
    const chunks = planChunks(changeSet().files, 10_000, 3).chunks;
    const gather = (depth: number, budget = 10_000) => {
      const { context, searches } = deepSource();
      return gatherContext({ chunks, changeSet: changeSet(), source: context, budgetFor: () => budget, concurrency: 2, depth }).then(
        (gathered) => ({ ...gathered, searches }),
      );
    };

    const deep = await gather(2);
    const headers = deep.contexts[0]!.split("\n").filter((line) => line.startsWith("==="));
    expect(headers.slice(-2)).toEqual([
      "=== CONTEXT: bin/cli.ts (call sites of main) ===",
      "=== CONTEXT: src/routes/serve.ts (call sites of runCli (calls main; 2 hops from the change)) ===",
    ]);
    expect(deep.contexts[0]).toContain("     4 :   res.json(runCli(req.body.args));");
    expect(deep.searches).toEqual(["main", "runCli"]);
    expect(deep.reach).toEqual([
      { path: "bin/cli.ts", chain: ["main"], hops: 1 },
      { path: "src/routes/serve.ts", chain: ["main", "runCli"], hops: 2 },
    ]);

    const shallow = await gather(1);
    expect(shallow.searches).toEqual(["main"]);
    expect(shallow.reach).toEqual([{ path: "bin/cli.ts", chain: ["main"], hops: 1 }]);

    // Room for everything one hop out, not for the second hop: it goes first.
    const tight = await gather(2, estimateTokens(shallow.contexts[0]!) + 10);
    expect(tight.contexts[0]).toBe(shallow.contexts[0]);
  });

  it("shares one search cap across hops, direct callers first", async () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo"];
    const patch = ["@@ -0,0 +1,5 @@", ...names.map((name) => `+export function ${name}() {}`)].join("\n");
    const many = makeChangeSet([{ path: "src/names.ts", changeType: "modified", patch }]);
    const searches: string[] = [];
    const context: ContextSource = {
      readFile: async (path) => {
        const name = /callers\/(\w+)\.ts/.exec(path)?.[1];
        return name ? `export function ${name}Caller() {\n  return ${name}();\n}\n` : "";
      },
      searchCode: async (term) => {
        searches.push(term);
        return names.includes(term) ? [`callers/${term}.ts`] : [];
      },
    };
    const chunks = planChunks(many.files, 10_000, 3).chunks;

    await gatherContext({ chunks, changeSet: many, source: context, budgetFor: () => 10_000, concurrency: 2, depth: 3 });

    expect(searches.slice(0, 5)).toEqual(names);
    expect(searches).toHaveLength(8);
  });

  it("shares the direct searches across files, changed declarations first", async () => {
    const removed = ["one", "two", "three", "four", "five", "six"].map((n) => `legacy${n[0]!.toUpperCase()}${n.slice(1)}`);
    const many = makeChangeSet([
      {
        path: "src/legacy.ts",
        changeType: "modified",
        patch: [`@@ -1,${removed.length} +1,1 @@`, ...removed.map((name) => `-export function ${name}() {}`), "+export const KEEP = 1;"].join("\n"),
      },
      {
        path: "src/user.ts",
        changeType: "modified",
        patch: ["@@ -1,1 +1,1 @@", "-export function formatUser(user) {", "+export function formatUser(user, locale) {"].join("\n"),
      },
    ]);
    const searches: string[] = [];
    const context: ContextSource = {
      readFile: async () => null,
      searchCode: async (term) => {
        searches.push(term);
        return [];
      },
    };
    const chunks = planChunks(many.files, 10_000, 3).chunks;

    await gatherContext({ chunks, changeSet: many, source: context, budgetFor: () => 10_000, concurrency: 1 });

    expect(searches).toHaveLength(5);
    expect(searches).toContain("formatUser");
  });

  it("stops searching after a failure and says what the passes still saw", async () => {
    const run = async (failOn: string) => {
      const calls: string[] = [];
      const patch = ["@@ -0,0 +1,3 @@", "+export function alpha() {}", "+export function bravo() {}", "+export function charlie() {}"].join("\n");
      const many = makeChangeSet([{ path: "src/names.ts", changeType: "modified", patch }]);
      const context: ContextSource = {
        readFile: async () => null,
        searchCode: async (term) => {
          calls.push(term);
          if (term === failOn) throw new Error("rate limited");
          return [];
        },
      };
      const chunks = planChunks(many.files, 10_000, 3).chunks;
      const gathered = await gatherContext({ chunks, changeSet: many, source: context, budgetFor: () => 10_000, concurrency: 1 });
      return { calls, warnings: gathered.warnings };
    };

    const first = await run("alpha");
    expect(first.calls).toEqual(["alpha"]);
    expect(first.warnings).toEqual(["Caller search failed, so passes saw no call sites: rate limited"]);

    const later = await run("bravo");
    expect(later.calls).toEqual(["alpha", "bravo"]);
    expect(later.warnings).toEqual(["Some caller searches failed, so passes may be missing call sites: rate limited"]);
  });

  it("does not trace through generic method names", async () => {
    const patch = "@@ -0,0 +1,1 @@\n+export function buildPayload() {}";
    const changed = makeChangeSet([{ path: "src/payload.ts", changeType: "modified", patch }]);
    const job = ["export class Job {", "  async run() {", "    return buildPayload();", "  }", "}", ""].join("\n");
    const searches: string[] = [];
    const context: ContextSource = {
      readFile: async (path) => (path === "src/job.ts" ? job : null),
      searchCode: async (term) => {
        searches.push(term);
        return term === "buildPayload" ? ["src/job.ts"] : ["src/routes/x.ts"];
      },
    };
    const chunks = planChunks(changed.files, 10_000, 3).chunks;

    const gathered = await gatherContext({ chunks, changeSet: changed, source: context, budgetFor: () => 10_000, concurrency: 2, depth: 3 });

    expect(searches).toEqual(["buildPayload"]);
    expect(gathered.reach).toEqual([{ path: "src/job.ts", chain: ["buildPayload"], hops: 1 }]);
  });

  it("traces the same callers in the same order however reads interleave", async () => {
    const names = ["alpha", "bravo", "charlie"];
    const many = makeChangeSet(
      names.map((name) => ({ path: `src/${name}.ts`, changeType: "modified" as const, patch: `@@ -0,0 +1,1 @@\n+export function ${name}() {}` })),
    );
    // Each name has three callers, so the second hop wants nine searches
    // and only five are left.
    const callerFile = (name: string) =>
      ["One", "Two", "Three"].map((suffix) => `export function ${name}${suffix}() {\n  return ${name}();\n}\n`).join("");
    const trace = async (delays: Record<string, number>) => {
      const context: ContextSource = {
        readFile: async (path) => {
          const name = /^callers\/(\w+)\.ts$/.exec(path)?.[1];
          if (name) {
            await new Promise((resolve) => setTimeout(resolve, delays[name]));
            return callerFile(name);
          }
          const deep = /^deep\/(\w+)\.ts$/.exec(path)?.[1];
          return deep ? `export function ${deep}Use() {\n  return ${deep}();\n}\n` : null;
        },
        searchCode: async (term) => (names.includes(term) ? [`callers/${term}.ts`] : [`deep/${term}.ts`]),
      };
      const chunks = planChunks(many.files, 10_000, 3).chunks;
      return (await gatherContext({ chunks, changeSet: many, source: context, budgetFor: () => 10_000, concurrency: 3, depth: 2 })).reach;
    };

    const forward = await trace({ alpha: 1, bravo: 5, charlie: 10 });
    const reversed = await trace({ alpha: 10, bravo: 5, charlie: 1 });

    expect(reversed).toEqual(forward);
    expect(forward.filter((caller) => caller.hops === 2).map((caller) => caller.chain.at(-1))).toEqual([
      "alphaOne",
      "alphaTwo",
      "alphaThree",
      "bravoOne",
      "bravoTwo",
    ]);
  });

  it("fetches nothing for a full pass and keeps forge calls within the concurrency", async () => {
    const patch = "@@ -1,2 +1,2 @@\n a\n-b\n+c";
    const many = makeChangeSet(Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, changeType: "modified" as const, patch })));
    const chunks = planChunks(many.files, 10_000, 5).chunks;
    let reads = 0;
    let active = 0;
    let peak = 0;
    const slow: ContextSource = {
      readFile: async () => {
        reads += 1;
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return "a\nc\n";
      },
      searchCode: async () => [],
    };

    await gatherContext({ chunks, changeSet: many, source: slow, budgetFor: () => 0, concurrency: 2 });
    expect(reads).toBe(0);

    await gatherContext({ chunks, changeSet: many, source: slow, budgetFor: () => 10_000, concurrency: 2 });
    expect(reads).toBe(12);
    expect(peak).toBe(2);
  });

  it("keeps lower-priority blocks that still fit after a larger one is skipped", () => {
    const block = (priority: number, tokens: number) => ({ path: "p", label: "l", priority, text: `b${priority}`, tokens });
    expect(fillContext([block(2, 5), block(0, 50), block(1, 30)], 40)).toBe("b1\n\nb2");
    expect(fillContext([block(0, 50)], 0)).toBe("");
  });

  it("degrades to the diff alone when reads and searches fail", async () => {
    const context: ContextSource = {
      readFile: async () => {
        throw new Error("502 Bad Gateway");
      },
      searchCode: async () => {
        throw new Error("403 rate limited");
      },
    };
    const chunks = planChunks(changeSet().files, 10_000, 3).chunks;

    const gathered = await gatherContext({ chunks, changeSet: changeSet(), source: context, budgetFor: () => 10_000, concurrency: 2 });

    expect(gathered.contexts).toEqual([""]);
    expect(gathered.warnings).toEqual([
      "Review context could not be read for src/app.ts; the diff was reviewed without it",
      "Caller search failed, so passes saw no call sites: 403 rate limited",
    ]);
  });
});

describe("runReview with context", () => {
  const now = () => new Date("2026-10-04T12:00:00Z");
  const reviewPrompt = (requests: { schemaName: string; prompt: string }[]) =>
    requests.find((request) => request.schemaName === "code_review")!.prompt;

  it("puts context after the diff in its own read-only section", async () => {
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });
    const result = await runReview({ changeSet: changeSet(), config: config() }, { generate, now, context: source().context });

    const prompt = reviewPrompt(requests);
    expect(prompt).toContain(`Context (read-only, from the new version of the code):\n${SCOPE}`);
    expect(prompt.indexOf("Diff:")).toBeLessThan(prompt.indexOf("=== CONTEXT:"));
    expect(result.status).toBe("completed");
    expect(result.warnings).toEqual([]);
  });

  it("never changes coverage: context only fills what the diff left", async () => {
    // Enough for the diff, nothing left over for context.
    const tight = config({ llm: { contextBudget: 4_000 } });
    const withContext = fakeModel({ code_review: { findings: [] } });
    const withSource = await runReview({ changeSet: changeSet(), config: tight }, { generate: withContext.generate, now, context: source().context });
    const without = await runReview({ changeSet: changeSet(), config: tight }, { generate: fakeModel({ code_review: { findings: [] } }).generate, now });

    expect(withSource.coverage).toEqual(without.coverage);
    expect(reviewPrompt(withContext.requests)).not.toContain("=== CONTEXT:");
    expect(contextTokenBudget(tight, 3_000, 500)).toBe(0);
  });

  it("completes with a warning when context cannot be read", async () => {
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });
    const failing: ContextSource = {
      readFile: () => Promise.reject(new Error("timeout")),
      searchCode: async () => [],
    };

    const result = await runReview({ changeSet: changeSet(), config: config() }, { generate, now, context: failing });

    expect(result.status).toBe("completed");
    expect(result.warnings).toEqual(["Review context could not be read for src/app.ts; the diff was reviewed without it"]);
    expect(reviewPrompt(requests)).not.toContain("Context (read-only");
  });

  it("reads nothing when review.fileContext is off", async () => {
    const { context, reads, searches } = source();
    const { generate } = fakeModel({ code_review: { findings: [] } });

    await runReview({ changeSet: changeSet(), config: config({ review: { fileContext: false } }) }, { generate, now, context });

    expect(reads).toEqual([]);
    expect(searches).toEqual([]);
  });

  it("drops findings on context-only lines unless review.fullFile is on", async () => {
    const onContext = { code_review: { findings: [modelFinding({ startLine: 12, endLine: 12 })] } };
    const strict = await runReview(
      { changeSet: changeSet(), config: config() },
      { generate: fakeModel(onContext).generate, now, context: source().context },
    );
    expect(strict.findings).toEqual([]);
    expect(strict.validation.dropped).toEqual({ off_diff: 1 });

    const full = await runReview(
      { changeSet: changeSet(), config: config({ review: { fullFile: true } }) },
      { generate: fakeModel(onContext).generate, now, context: source().context },
    );
    expect(full.findings.map((finding) => finding.startLine)).toEqual([12]);
  });
});

describe("broken contracts", () => {
  const now = () => new Date("2026-10-04T12:00:00Z");

  it("shows a changed signature's callers and keeps the files a contract finding names", async () => {
    const patch = [
      "@@ -6,3 +6,3 @@",
      "-export function main(input: string) {",
      "+export function main(input: string, limit: number) {",
      "   const a = helper(input);",
      "   const b = fmt(a);",
    ].join("\n");
    const changed = makeChangeSet([{ path: "src/app.ts", changeType: "modified", patch }]);
    const finding = modelFinding({
      startLine: 6,
      endLine: 6,
      title: "main now requires a limit its callers do not pass",
      evidence: "contract",
      evidenceNote: "bin/cli.ts calls main with one argument.",
      impact: "runCli() in bin/cli.ts and the /run route pass no limit.",
      evidenceFiles: ["bin/cli.ts", "src/routes/serve.ts"],
    });
    const { generate, requests } = fakeModel({ code_review: { findings: [finding] } });

    const result = await runReview(
      { changeSet: changed, config: config({ review: { impactDepth: 2 } }) },
      { generate, now, context: deepSource().context },
    );

    const prompt = requests.find((request) => request.schemaName === "code_review")!.prompt;
    expect(prompt).toContain("=== CONTEXT: bin/cli.ts (call sites of main (signature changed)) ===");
    expect(prompt).toContain("=== CONTEXT: src/routes/serve.ts (call sites of runCli (calls main; 2 hops from the change)) ===");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ evidence: "contract", evidenceFiles: ["bin/cli.ts", "src/routes/serve.ts"] });
    expect(inlineBody(result.findings[0]!, "github")).toContain("**📎 Affected:** `bin/cli.ts`, `src/routes/serve.ts`");
    // Its own file is not affected, and a path is shown as written.
    expect(affectedLines({ ...result.findings[0]!, evidenceFiles: ["src/app.ts", "src/a|b.ts"] })).toEqual([
      "",
      "**📎 Affected:** `src/a|b.ts`",
    ]);
    // Other findings' evidence files were only read, not broken.
    expect(inlineBody({ ...result.findings[0]!, evidence: "execution_path" }, "github")).not.toContain("Affected");
  });
});

describe("code search", () => {
  it("searches GitHub's index for the repository", async () => {
    const stub = fetchStub([
      { url: /\/search\/code\?/, body: { items: [{ path: "bin/cli.ts" }, { path: "bin/cli.ts" }, { path: "src/x.ts" }] } },
    ]);
    const gh = new GitHubAdapter({ host: "github.com", token: async () => "t", fetch: stub.fetch });

    expect(await gh.searchCode("acme/web", "main", "head")).toEqual(["bin/cli.ts", "src/x.ts"]);
    expect(new URL(stub.calls[0]!.url).searchParams.get("q")).toBe("main repo:acme/web");
  });

  it("searches GitLab blobs at the head revision", async () => {
    const stub = fetchStub([{ url: /\/search\?scope=blobs/, body: [{ path: "bin/cli.ts" }] }]);
    const gl = new GitLabAdapter({ host: "gitlab.com", token: async () => "t", fetch: stub.fetch });

    expect(await gl.searchCode("team/app", "main", "abc123")).toEqual(["bin/cli.ts"]);
    const url = new URL(stub.calls[0]!.url);
    expect(url.searchParams.get("search")).toBe("main");
    expect(url.searchParams.get("ref")).toBe("abc123");
  });
});

describe("file_context in .sentryward.yaml", () => {
  it("parses and defaults to on", () => {
    expect(parseRepoFile(".sentryward.yaml", "review:\n  file_context: false\n")).toEqual({
      override: { review: { fileContext: false } },
      warnings: [],
    });
    expect(config().review.fileContext).toBe(true);
  });

  it("reads impact_depth, defaulting to two hops and one in the fast profile", () => {
    expect(parseRepoFile(".sentryward.yaml", "review:\n  impact_depth: 3\n").override).toEqual({ review: { impactDepth: 3 } });
    expect(parseRepoFile(".sentryward.yaml", "review:\n  impact_depth: 4\n").warnings).not.toEqual([]);
    expect(config().review.impactDepth).toBe(2);
    expect(resolveConfig({ trigger: { profile: "fast" } }).config.review.impactDepth).toBe(1);
  });
});
