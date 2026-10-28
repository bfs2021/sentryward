import { posix } from "node:path";
import type { Hunk } from "../core/models.ts";
import { escapeRegExp } from "../core/regex.ts";
import type { LineRange } from "./fileContext.ts";

// Names the diff defines and calls, found by pattern rather than by parsing,
// and the relative imports that say where a called name is defined. Missing a
// name only costs context; a wrong one costs a few tokens of unrelated code.

const IDENT = "[A-Za-z_$][\\w$]*";
const DECLARATIONS = [
  new RegExp(`\\b(?:function\\*?|def|fn|class|interface|struct|enum|trait|type)\\s+(${IDENT})`),
  new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?(${IDENT})`),
  new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\(|${IDENT}\\s*=>)`),
  new RegExp(
    `^\\s*(?:(?:public|private|protected|static|async|override|readonly|export|default)\\s+)*(${IDENT})\\s*\\([^)]*\\)\\s*(?::[^{=]*)?\\{\\s*$`,
  ),
];
const CALL = new RegExp(`(?<![\\w$.])(${IDENT})\\s*\\(`, "g");
const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "await", "new", "super", "import",
  "require", "else", "do", "try", "with", "yield", "delete", "void", "in", "of", "instanceof", "constructor",
  "this", "self", "print", "len", "str", "int", "elif", "except", "lambda", "not", "and", "or", "assert",
  "sizeof", "defer", "go", "func", "def", "fn", "match", "when", "async", "export", "default",
]);
// Shorter names match too much of any codebase to be worth a search.
const MIN_NAME_LENGTH = 3;

function wanted(name: string | undefined): name is string {
  return !!name && name.length >= MIN_NAME_LENGTH && !KEYWORDS.has(name);
}

// Method and callback names every codebase has many of. A changed name is
// still searched whatever it is called, but tracing through one of these
// would follow calls on any receiver (app.run, worker.run) into code that
// never reaches the change.
const GENERIC_NAMES = new Set([
  "run", "get", "set", "handle", "handler", "execute", "exec", "call", "apply", "init", "main", "start", "stop",
  "process", "render", "update", "create", "delete", "remove", "next", "callback", "cb", "fn", "default", "load",
  "save", "send", "build", "parse", "format", "test", "setup", "invoke", "dispatch", "fetch", "list", "find",
]);
const MIN_TRACED_LENGTH = 4;

// Whether a caller's enclosing declaration is worth following to the next hop.
export function traceable(name: string): boolean {
  return wanted(name) && name.length >= MIN_TRACED_LENGTH && !GENERIC_NAMES.has(name);
}

export function declaredNames(line: string): string[] {
  return DECLARATIONS.map((pattern) => pattern.exec(line)?.[1]).filter(wanted);
}

export type ContractChange = "signature changed" | "removed";

export interface PartSymbols {
  // Declared on a changed line or enclosing a hunk: changing them can break
  // callers. Names whose declaration changed come first.
  defined: string[];
  // Called on an added line and not declared in the hunks themselves.
  called: string[];
  // Names whose declaration (its own line, or the rest of a signature split
  // over several lines) changed or went away: their callers are the
  // likeliest to break.
  contracts: Map<string, ContractChange>;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const MAX_SIGNATURE_LINES = 15;

const parenDepth = (text: string) => (text.match(/\(/g)?.length ?? 0) - (text.match(/\)/g)?.length ?? 0);

// A declaration line's signature without its body: up to the parameter
// list's closing paren and any return type, so a one-line arrow or function
// whose body alone changed keeps its contract. A line without a parameter
// list (a type, a class) is all signature.
export function signatureText(text: string): string {
  const open = text.indexOf("(");
  if (open === -1) return text;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) {
      const rest = text.slice(i + 1);
      const end = rest.search(/\{|=>|\s=\s/);
      return text.slice(0, i + 1) + (end === -1 ? rest : rest.slice(0, end));
    }
  }
  return text;
}

// Names declared on added lines: a name removed from one file and declared
// in another was moved, not removed.
export function addedDeclarations(hunks: Hunk[]): Set<string> {
  const names = new Set<string>();
  for (const hunk of hunks) {
    for (const line of hunk.content.split("\n").slice(1)) {
      if (line[0] === "+") for (const name of declaredNames(line.slice(1))) names.add(name);
    }
  }
  return names;
}

const IMPORT_LINE = /^\s*(?:import\b.*\bfrom\b|from\s+\S+\s+import\b|(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\()/;

export function partSymbols(hunks: Hunk[], movedIn: ReadonlySet<string> = new Set()): PartSymbols {
  const defined = new Set<string>();
  const called = new Set<string>();
  const added = new Map<string, Set<string>>();
  const removed = new Map<string, Set<string>>();
  const declare = (into: Map<string, Set<string>>, name: string, text: string) => {
    let texts = into.get(name);
    if (!texts) into.set(name, (texts = new Set()));
    texts.add(squash(signatureText(text)));
  };
  const reshaped = new Set<string>();
  const imported = new Set<string>();
  for (const hunk of hunks) {
    for (const name of declaredNames(hunk.header)) defined.add(name);
    // The declaration whose parameter list is still open on the lines
    // after it; it closes with the paren, on the line that carries the
    // return type.
    let signature: { name: string; depth: number; lines: number } | undefined;
    for (const line of hunk.content.split("\n").slice(1)) {
      const text = line.slice(1);
      const names = declaredNames(text);
      if (names.length) {
        const depth = parenDepth(text);
        signature = depth > 0 ? { name: names[0]!, depth, lines: 0 } : undefined;
      } else if (signature) {
        if (line[0] === "+" || line[0] === "-") reshaped.add(signature.name);
        signature.depth += parenDepth(text);
        if (signature.depth <= 0 || ++signature.lines >= MAX_SIGNATURE_LINES) signature = undefined;
      }
      if (line[0] === "+" && IMPORT_LINE.test(text)) {
        for (const match of text.matchAll(new RegExp(IDENT, "g"))) imported.add(match[0]);
      }
      if (line[0] === "-") {
        for (const name of declaredNames(text)) declare(removed, name, text);
        continue;
      }
      if (line[0] !== "+") continue;
      for (const name of declaredNames(text)) {
        defined.add(name);
        declare(added, name, text);
      }
      for (const match of text.matchAll(CALL)) if (wanted(match[1])) called.add(match[1]);
    }
  }
  // A declaration removed and added back unchanged was only moved, and so
  // was one now imported or declared in another file of the change: its
  // callers still resolve, and a call to it still wants its definition.
  const contracts = new Map<string, ContractChange>();
  for (const [name, texts] of removed) {
    const now = added.get(name);
    if (now) {
      if ([...texts].some((text) => !now.has(text))) contracts.set(name, "signature changed");
    } else if (!imported.has(name) && !movedIn.has(name)) {
      contracts.set(name, "removed");
    }
  }
  for (const name of reshaped) if (!contracts.has(name)) contracts.set(name, "signature changed");
  for (const name of contracts.keys()) defined.add(name);
  for (const name of defined) called.delete(name);
  return {
    defined: [...contracts.keys(), ...[...defined].filter((name) => !contracts.has(name))],
    called: [...called],
    contracts,
  };
}

export interface ImportBinding {
  module: string;
  // The name the module exports it under; "default" for a default import.
  exported: string;
}

function specifiers(list: string, separator: RegExp): [local: string, exported: string][] {
  return list
    .split(",")
    .map((spec) => spec.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .map((spec) => {
      const [exported, local] = spec.split(separator).map((part) => part.trim());
      return [local || exported!, exported!];
    });
}

// Local names bound by relative imports, the only ones that resolve to a file
// without knowing the build setup.
export function relativeImports(content: string): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const bind = (local: string, exported: string, module: string) => {
    if (new RegExp(`^${IDENT}$`).test(local) && !bindings.has(local)) bindings.set(local, { module, exported });
  };
  for (const match of content.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const clause = match[1]!;
    const module = match[2]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const [local, exported] of specifiers(braces[1]!, /\s+as\s+/)) bind(local, exported, module);
    const defaultName = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+\S+/, "").split(",")[0]!.trim();
    if (defaultName) bind(defaultName, "default", module);
  }
  for (const match of content.matchAll(
    /(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  )) {
    for (const [local, exported] of specifiers(match[1]!, /\s*:\s*/)) bind(local, exported, match[2]!);
  }
  for (const match of content.matchAll(/^from\s+(\.+[\w.]*)\s+import\s+\(?([^)\n#]+)/gm)) {
    for (const [local, exported] of specifiers(match[2]!, /\s+as\s+/)) bind(local, exported, match[1]!);
  }
  return bindings;
}

const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

// Paths a relative module may live at, most likely first. Empty when the
// module points outside the repository.
export function moduleCandidates(fromPath: string, module: string): string[] {
  const dir = posix.dirname(fromPath);
  let candidates: string[];
  if (/^\.\.?\//.test(module)) {
    const base = posix.join(dir, module);
    const extension = posix.extname(base);
    if (SCRIPT_EXTENSIONS.has(extension)) {
      // TypeScript imports name the emitted .js file.
      const stem = base.slice(0, -extension.length);
      candidates = extension === ".js" ? [base, `${stem}.ts`, `${stem}.tsx`] : [base];
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(fromPath)) {
      candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
    } else {
      candidates = [`${base}.js`, `${base}.jsx`, `${base}.ts`, `${base}/index.js`];
    }
  } else {
    // Python: one dot is the current package, each further dot its parent.
    const dots = /^\.+/.exec(module)![0].length;
    const rest = module.slice(dots).split(".").filter(Boolean).join("/");
    const base = posix.join(dir, ...Array<string>(dots - 1).fill(".."), rest);
    candidates = rest ? [`${base}.py`, `${base}/__init__.py`] : [`${base}/__init__.py`];
  }
  return candidates.map((path) => posix.normalize(path)).filter((path) => !path.startsWith(".."));
}

// The line declaring `name` (or the default export), if any.
export function declarationLine(lines: string[], exported: string): number | undefined {
  const index =
    exported === "default"
      ? lines.findIndex((line) => /^\s*export\s+default\b/.test(line))
      : lines.findIndex((line) => declaredNames(line).includes(exported));
  return index === -1 ? undefined : index + 1;
}

const CALL_SITE_BEFORE = 5;
const CALL_SITE_AFTER = 3;

// Lines that call `name`, as a function or a method, skipping its declaration.
export function callLines(lines: string[], name: string, limit: number): number[] {
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*\\(`);
  const found: number[] = [];
  for (let n = 1; n <= lines.length && found.length < limit; n++) {
    const line = lines[n - 1]!;
    if (pattern.test(line) && !declaredNames(line).includes(name)) found.push(n);
  }
  return found;
}

export function callSiteWindow(lines: string[], line: number): LineRange {
  return { start: Math.max(1, line - CALL_SITE_BEFORE), end: Math.min(lines.length, line + CALL_SITE_AFTER) };
}

const MAX_ENCLOSING_SCAN = 150;

// The named declaration a line sits in: the next hop when tracing callers.
// Found by indentation, like enclosingScope; top-level code and anonymous
// callbacks with no named declaration above them have none.
export function enclosingDeclaration(lines: string[], line: number): { name: string; line: number } | undefined {
  const indent = (text: string) => text.length - text.trimStart().length;
  const own = lines[line - 1];
  let level = own?.trim() ? indent(own) : Infinity;
  for (let n = line - 1; n >= Math.max(1, line - MAX_ENCLOSING_SCAN) && level > 0; n--) {
    const text = lines[n - 1]!;
    if (!text.trim() || indent(text) >= level) continue;
    level = indent(text);
    const name = declaredNames(text)[0];
    if (name) return { name, line: n };
  }
  return undefined;
}
