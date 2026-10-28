import { env } from "../config/env.ts";
import { prisma } from "../lib/prisma.ts";
import { notifyJob } from "../services/notifications.ts";
import { execute } from "./execute.ts";
import { claimNext, recoverStale } from "./queue.ts";
import { claimNextReply, recoverStaleReplies } from "./replyQueue.ts";
import { executeReply } from "./executeReply.ts";
import { runRetention } from "./retention.ts";

let stopping = false;
const running = new Set<Promise<void>>();

// Retention is about days, so an hourly pass is plenty. The first poll after
// start runs it.
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

// Claims are awaited one at a time; the work itself runs in the background up
// to WORKER_CONCURRENCY jobs. Replies to inline threads share the slots and
// are claimed after reviews, which they are much smaller than.
async function tick(): Promise<void> {
  const stale = await recoverStale(env.WORKER_LOCK_TIMEOUT_MS, env.WORKER_MAX_ATTEMPTS);
  const recovered = stale.count + (await recoverStaleReplies(env.WORKER_LOCK_TIMEOUT_MS, env.WORKER_MAX_ATTEMPTS));
  if (recovered > 0) {
    console.log(`[worker] recovered ${recovered} stale job(s)`);
  }
  // Jobs failed here never return to an execute() that would notify for them.
  for (const id of stale.failedIds) {
    await notifyJob(id);
  }
  while (!stopping && running.size < env.WORKER_CONCURRENCY) {
    const job = await claimNext(env.WORKER_USER_CONCURRENCY);
    if (!job) {
      break;
    }
    const task: Promise<void> = execute(job).finally(() => running.delete(task));
    running.add(task);
  }
  while (!stopping && running.size < env.WORKER_CONCURRENCY) {
    const reply = await claimNextReply();
    if (!reply) {
      return;
    }
    const task: Promise<void> = executeReply(reply).finally(() => running.delete(task));
    running.add(task);
  }
}

// Runs after the claims so a long first pass or a failing prune never holds
// up reviews.
// The periods are read from the instance and workspace privacy settings on
// each pass, so a change applies within the hour.
async function prune(): Promise<void> {
  if (Date.now() - lastPruneAt < RETENTION_INTERVAL_MS) return;
  // Set first so a failing prune waits for the next interval instead of
  // retrying every poll.
  lastPruneAt = Date.now();
  const r = await runRetention();
  if (r.deleted || r.trimmed || r.changes || r.auditRows) {
    console.log(
      `[worker] retention: deleted ${r.deleted} job(s), expired ${r.trimmed} result(s), ` +
        `purged ${r.changes} change(s) (${r.findings} finding(s), ${r.replies} reply(ies)), ` +
        `${r.auditRows} audit row(s)`,
    );
  }
}

async function loop(): Promise<void> {
  console.log(
    `[worker] polling every ${env.WORKER_POLL_INTERVAL_MS}ms, concurrency ${env.WORKER_CONCURRENCY}`,
  );
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error("[worker] poll failed", err);
    }
    try {
      await prune();
    } catch (err) {
      console.error("[worker] retention failed", err);
    }
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
  }
  await Promise.allSettled(running);
  await prisma.$disconnect();
  console.log("[worker] stopped");
}

function shutdown() {
  if (!stopping) {
    console.log("[worker] shutting down after in-flight jobs");
    stopping = true;
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

void loop();
