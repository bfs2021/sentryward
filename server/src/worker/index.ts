import { env } from "../config/env.ts";
import { prisma } from "../lib/prisma.ts";
import { notifyJob } from "../services/notifications.ts";
import { execute } from "./execute.ts";
import { claimNext, recoverStale } from "./queue.ts";
import { claimNextReply, recoverStaleReplies } from "./replyQueue.ts";
import { executeReply } from "./executeReply.ts";
import { pruneReviews } from "./retention.ts";

let stopping = false;
const running = new Set<Promise<void>>();

// Retention is about days, so an hourly pass is plenty. The first tick after
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
  if (env.REVIEW_RETENTION_DAYS && Date.now() - lastPruneAt >= RETENTION_INTERVAL_MS) {
    // Set first so a failing prune waits for the next interval instead of
    // retrying every poll.
    lastPruneAt = Date.now();
    const pruned = await pruneReviews(env.REVIEW_RETENTION_DAYS);
    if (pruned.deleted || pruned.trimmed) {
      console.log(`[worker] retention: deleted ${pruned.deleted} job(s), expired ${pruned.trimmed} result(s)`);
    }
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
