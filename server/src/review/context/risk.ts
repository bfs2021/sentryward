import type { ChangedFile, RiskyArea, Walkthrough } from "../core/models.ts";
import type { ReachedCaller } from "./gather.ts";

// Changes to authorization, database writes and API routes break the most
// for the fewest lines, so they are flagged in the walkthrough and raise its
// blast radius. Found by pattern, not parsing: a miss only leaves the blast
// radius to the model, and a false hit only names an area to look at.

const AUTH_LINE =
  /\b(?:require(?:Auth|Admin|Role|Login|Owner|Permission)\w*|authenticat\w*|[Aa]uthori[sz]\w*|is(?:Admin|Authenticated|Authorized|Owner)\b|(?:has|check)(?:Permission|Role|Access)\w*|verify(?:Token|Jwt|Session)\w*|jwt\.verify|login_required|permission_required|PreAuthorize|Secured\b)/;
const AUTH_PATH = /(?:^|\/)(?:auth|authz|permissions?|policies|guards?)(?:[/.]|$)|(?:^|\/)middleware\/[^/]*auth/i;
// Bulk and destructive calls count on any receiver; the common ones (create,
// update, delete, save) only on a model reached through a client, so a
// Map.delete or a form's save is not taken for a database write.
const DB_LINE =
  /\.(?:upsert|createMany|updateMany|deleteMany|bulkCreate|destroy|insertMany|\$executeRaw\w*|\$queryRaw\w*)\s*\(|\b\w+\.\w+\.(?:create|update|delete|insert|save|remove)\s*\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE\s+TABLE)\b/;
const DB_PATH = /(?:^|\/)(?:schema\.prisma|migrations?\/.*|[^/]+\.sql)$/;
// A known router, or any receiver given a path: users.get("/users/:id", ...).
const API_LINE =
  /\b(?:router|app|server|api|routes?)\.(?:get|post|put|patch|delete|all|route)\s*\(|\.(?:get|post|put|patch|delete|all)\s*\(\s*["'`]\/|@(?:app|router|bp|blueprint|api)\.(?:route|get|post|put|patch|delete)\b|@(?:Get|Post|Put|Patch|Delete|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping)\b/;
const API_PATH = /(?:^|[/.])(?:routes?|controllers?|handlers?|endpoints?)(?:[/.])/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#|--)/;

export const MAX_RISKY_AREAS = 10;

export const RISK_KIND_TEXT: Record<RiskyArea["kind"], string> = {
  auth: "authorization",
  database: "database writes",
  api: "API routes",
};

function changedLines(file: ChangedFile): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.content.split("\n").slice(1)) {
      const text = line.slice(1);
      if (COMMENT.test(text)) continue;
      if (line[0] === "+") added.push(text);
      else if (line[0] === "-") removed.push(text);
    }
  }
  return { added, removed };
}

function fileAreas(file: ChangedFile): RiskyArea[] {
  if (file.isBinary) return [];
  const { added, removed } = changedLines(file);
  const areas: RiskyArea[] = [];
  const addedAuth = added.filter((line) => AUTH_LINE.test(line)).length;
  const removedAuth = removed.filter((line) => AUTH_LINE.test(line)).length;
  if (removedAuth > addedAuth) {
    areas.push({ kind: "auth", path: file.path, reason: "removes an authorization check", removesCheck: true });
  } else if (addedAuth || removedAuth || (AUTH_PATH.test(file.path) && (added.length || removed.length))) {
    areas.push({ kind: "auth", path: file.path, reason: "changes authorization code" });
  }
  if (DB_PATH.test(file.path)) {
    areas.push({ kind: "database", path: file.path, reason: "changes the database schema" });
  } else if ([...added, ...removed].some((line) => DB_LINE.test(line))) {
    areas.push({ kind: "database", path: file.path, reason: "changes a database write" });
  }
  if ([...added, ...removed].some((line) => API_LINE.test(line))) {
    areas.push({ kind: "api", path: file.path, reason: "changes an API route" });
  } else if (API_PATH.test(file.path)) {
    areas.push({ kind: "api", path: file.path, reason: "changes a request handler" });
  }
  return areas;
}

// What the traced callers reach: a handler or an auth module that calls the
// changed code, however many hops away.
function reachedAreas(reach: ReachedCaller[]): RiskyArea[] {
  return reach.flatMap((caller): RiskyArea[] => {
    const via = caller.chain.join(" -> ");
    const reason = `calls ${caller.chain.at(-1)}, ${caller.hops === 1 ? "directly" : `${caller.hops} hops`} from the change`;
    if (API_PATH.test(caller.path)) return [{ kind: "api", path: caller.path, reason, via }];
    if (AUTH_PATH.test(caller.path)) return [{ kind: "auth", path: caller.path, reason, via }];
    return [];
  });
}

// One entry per kind and file, the diff's own first, as reach only adds
// files the change does not touch.
export function riskyAreas(files: ChangedFile[], reach: ReachedCaller[] = []): RiskyArea[] {
  const seen = new Set<string>();
  return [...files.flatMap(fileAreas), ...reachedAreas(reach)]
    .filter((area) => {
      const key = `${area.kind}\0${area.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_RISKY_AREAS);
}

const RADIUS_ORDER = ["small", "medium", "large"] as const;
type BlastRadius = NonNullable<Walkthrough["blastRadius"]>;

// Never lowers the model's estimate. Touching auth or the database is at
// least medium; removing an auth check, or reaching auth or a route through
// callers, is large.
export function floorBlastRadius(radius: BlastRadius | undefined, areas: RiskyArea[]): BlastRadius | undefined {
  if (!areas.length) return radius;
  const floor: BlastRadius = areas.some((area) => area.removesCheck || area.via)
    ? "large"
    : areas.some((area) => area.kind !== "api")
      ? "medium"
      : "small";
  if (!radius) return floor;
  return RADIUS_ORDER.indexOf(floor) > RADIUS_ORDER.indexOf(radius) ? floor : radius;
}

export function riskFacts(areas: RiskyArea[]): string {
  return areas.map((area) => `- ${RISK_KIND_TEXT[area.kind]}: ${area.path} ${area.reason}`).join("\n");
}
