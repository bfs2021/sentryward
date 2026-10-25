import { createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.ts";
import type {
  NotificationEvent,
  NotificationTarget,
  ReviewJob,
  ReviewStatus,
} from "../generated/prisma/client.ts";
import { DecryptError, decrypt } from "../lib/crypto.ts";
import { assertSafeUrl } from "../lib/hostSafety.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import type { ResultSummary } from "../review/render/json.ts";

export const SIGNATURE_HEADER = "X-Sentryward-Signature";
export const EVENT_HEADER = "X-Sentryward-Event";
const DELIVERY_TIMEOUT_MS = 10_000;

// Skipped, cancelled and superseded jobs never notify: nothing was reviewed.
const NOTIFIED_STATUSES: ReviewStatus[] = ["completed", "partial", "failed"];
// Most specific first; a job is delivered once per target, as the first of its
// events that target listens for.
const EVENT_ORDER: NotificationEvent[] = ["failed", "blocked", "completed"];

type JobFacts = Pick<ReviewJob, "id" | "number" | "status" | "verdict" | "error" | "summary">;

export interface NotificationPayload {
  event: NotificationEvent | "test";
  review: { id: string; url: string; status: ReviewStatus; verdict: ReviewJob["verdict"]; error: string | null };
  repository: { provider: string; fullPath: string };
  change: { number: number; title: string | null; url: string | null };
  findings: { total: number; bySeverity: ResultSummary["bySeverity"] } | null;
}

// Every event a finished job counts as. A blocked review is also a completed one.
export function eventsFor(job: Pick<ReviewJob, "status" | "verdict">): NotificationEvent[] {
  if (job.status === "failed") return ["failed"];
  if (job.status !== "completed" && job.status !== "partial") return [];
  return job.verdict === "blocked" ? ["blocked", "completed"] : ["completed"];
}

// The event a target hears about, or null when it listens for none of them.
export function eventForTarget(events: NotificationEvent[], target: Pick<NotificationTarget, "events">) {
  return EVENT_ORDER.find((event) => events.includes(event) && target.events.includes(event)) ?? null;
}

export function payloadFor(
  job: JobFacts,
  repository: { provider: string; fullPath: string },
  event: NotificationPayload["event"],
): NotificationPayload {
  const summary = job.summary as ResultSummary | null;
  return {
    event,
    review: {
      id: job.id,
      url: `${env.CLIENT_ORIGIN}/reviews/${job.id}`,
      status: job.status,
      verdict: job.verdict,
      error: job.error,
    },
    repository: { provider: repository.provider, fullPath: repository.fullPath },
    change: { number: job.number, title: summary?.title ?? null, url: summary?.webUrl ?? null },
    findings: summary ? { total: summary.total, bySeverity: summary.bySeverity } : null,
  };
}

const HEADLINES: Record<NotificationPayload["event"], string> = {
  failed: "Review failed",
  blocked: "Review blocked",
  completed: "Review completed",
  test: "Test notification",
};

function describe(payload: NotificationPayload): string {
  const change = `${payload.repository.fullPath}#${payload.change.number}`;
  const title = payload.change.title ? ` "${payload.change.title}"` : "";
  const detail =
    payload.event === "failed"
      ? payload.review.error ?? "no reason recorded"
      : payload.findings
        ? `${payload.findings.total} finding${payload.findings.total === 1 ? "" : "s"}`
        : "";
  return `${HEADLINES[payload.event]}: ${change}${title}${detail ? ` - ${detail}` : ""}`;
}

// "sha256=<hex>" over the exact body sent, as GitHub signs its webhooks.
export function signature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function newWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

// Checked on every delivery, not only when saved, since the name can resolve
// elsewhere later. Redirects are not followed, so one cannot lead past the check.
async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<void> {
  await assertSafeUrl(url);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Sentryward", ...headers },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Responded with ${res.status}`);
  }
}

function targetUrl(target: NotificationTarget): string {
  if (!target.encryptedUrl) throw new Error("No URL stored");
  return decrypt(target.encryptedUrl);
}

// Throws on failure; callers decide whether that is logged or reported.
export async function deliver(target: NotificationTarget, workspaceId: string, payload: NotificationPayload) {
  switch (target.kind) {
    case "webhook": {
      if (!target.encryptedSecret) throw new Error("No signing secret stored");
      const body = JSON.stringify(payload);
      await post(targetUrl(target), body, {
        [EVENT_HEADER]: payload.event,
        [SIGNATURE_HEADER]: signature(decrypt(target.encryptedSecret), body),
      });
      return;
    }
    case "slack": {
      const text = `${describe(payload)} <${payload.review.url}|View review>`;
      await post(targetUrl(target), JSON.stringify({ text }));
      return;
    }
    case "email": {
      if (!mailer.configured()) throw new Error("Mail is not configured");
      // Members removed since the target was saved are left out.
      const members = await prisma.membership.findMany({
        where: { workspaceId, userId: { in: target.recipientIds } },
        select: { user: { select: { email: true } } },
      });
      const subject = describe(payload);
      const text = `${subject}\n\n${payload.review.url}\n`;
      // One message each, so recipients do not see each other's addresses.
      const results = await Promise.allSettled(members.map(({ user }) => mailer.send({ to: user.email, subject, text })));
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed) throw new Error(`${failed} of ${members.length} emails could not be sent`);
      return;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best effort and at most once per job: called when a job reaches its final
// status, whoever finished it. Nothing here throws, so a failed delivery can
// never change the job's outcome; failures are logged.
export async function notifyJob(jobId: string): Promise<void> {
  try {
    const { count } = await prisma.reviewJob.updateMany({
      where: { id: jobId, notifiedAt: null, status: { in: NOTIFIED_STATUSES } },
      data: { notifiedAt: new Date() },
    });
    if (count === 0) return;
    const job = await prisma.reviewJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { repository: { include: { connection: { select: { workspaceId: true } } } } },
    });
    const events = eventsFor(job);
    const workspaceId = job.repository.connection.workspaceId;
    // Paused targets are left out here only; a test delivery still reaches them.
    const targets = await prisma.notificationTarget.findMany({
      where: { workspaceId, active: true, events: { hasSome: events } },
    });
    await Promise.all(
      targets.map(async (target) => {
        const event = eventForTarget(events, target)!;
        try {
          await deliver(target, workspaceId, payloadFor(job, job.repository, event));
        } catch (err) {
          console.error(`[notify] target ${target.id} job ${jobId}: ${message(err)}`);
        }
      }),
    );
  } catch (err) {
    console.error(`[notify] could not notify for job ${jobId}`, err);
  }
}

// A sample delivery from the dashboard; the outcome is the answer either way.
export async function testTarget(target: NotificationTarget): Promise<{ ok: true } | { ok: false; error: string }> {
  const sample: NotificationPayload = {
    event: "test",
    review: {
      id: "00000000-0000-0000-0000-000000000000",
      url: `${env.CLIENT_ORIGIN}/reviews`,
      status: "completed",
      verdict: "pass",
      error: null,
    },
    repository: { provider: "github", fullPath: "example/repository" },
    change: { number: 1, title: "Test notification from Sentryward", url: null },
    findings: { total: 0, bySeverity: {} },
  };
  try {
    await deliver(target, target.workspaceId, sample);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof DecryptError ? "The stored URL can't be decrypted; add the target again" : message(err) };
  }
}

// Only the host of a URL ever leaves the server: the full Slack URL is the
// credential, and a webhook URL may carry one in its query.
export function publicTarget(target: NotificationTarget) {
  let host: string | null = null;
  let undecryptable = false;
  if (target.encryptedUrl) {
    try {
      host = new URL(decrypt(target.encryptedUrl)).host;
    } catch (error) {
      if (!(error instanceof DecryptError)) throw error;
      undecryptable = true;
    }
  }
  return {
    id: target.id,
    kind: target.kind,
    name: target.name,
    events: EVENT_ORDER.filter((event) => target.events.includes(event)),
    host,
    undecryptable,
    recipientIds: target.recipientIds,
    active: target.active,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}
