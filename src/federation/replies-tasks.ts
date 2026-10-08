import type { Context, Federation } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import db from "../db";
import {
  remoteReplyScrapeJobs as jobs,
  remoteReplyScrapeOrigins as origins,
} from "../schema";
import { uuid, type Uuid } from "../uuid";
import { REMOTE_REPLIES_SCRAPE_DEPTH, settleContextReplies } from "./replies";
import type { ProcessRemoteReplyScrapeJobsOptions } from "./replies-worker";

const logger = getLogger(["hollo", "federation", "replies-worker"]);
const RESERVATION_MS = 60_000;
const WINDOW_SIZE = 50;
const RECOVERY_BATCH = 100;
const STALE_SECONDS = 15 * 60;

export function registerRemoteReplyScrapes(
  federation: Federation<void>,
  readyDepth: () => Promise<number>,
  options: ProcessRemoteReplyScrapeJobsOptions = {},
) {
  let signal = options.signal;
  let active = 0;
  const clock = options.clock ?? (() => options.now ?? new Date());
  const enabled = () => (options.maxDepth ?? REMOTE_REPLIES_SCRAPE_DEPTH) > 0;
  const task = federation.defineTask("hollo.remote-reply-scrape.v1", {
    schema: z.object({ jobId: uuid }),
    retryPolicy: () => null,
    onError: (_ctx, error, { jobId }) => {
      logger.error(
        "Scrape task {jobId} failed; durable recovery will retry: {error}",
        { jobId, error },
      );
    },
    handler: async (ctx, { jobId }) => {
      if (!enabled() || signal?.aborted) return;
      const job = await db.query.remoteReplyScrapeJobs.findFirst({
        where: { id: { eq: jobId } },
      });
      if (!job || job.status !== "pending") return;
      const origin = await db.query.remoteReplyScrapeOrigins.findFirst({
        where: { originHost: { eq: job.originHost } },
      });
      const now = options.now ?? clock();
      if (
        origin &&
        !origin.processingJobId &&
        Math.max(job.nextAttemptAt.getTime(), origin.nextRequestAt.getTime()) >
          now.getTime()
      ) {
        // A consumed early message must always replace itself.  The old
        // reservation cannot be used to assume that another message exists.
        await enqueue(ctx, jobId, true);
        return;
      }
      if (active >= 2 || !origin || origin.processingJobId) {
        await drop(jobId);
        return;
      }
      active++;
      let claimed = false;
      try {
        const worker = await import("./replies-worker");
        const attempt = await worker.claimRemoteReplyScrapeJob(jobId, now);
        if (!attempt) {
          await drop(jobId);
          return;
        }
        claimed = true;
        await worker.processRemoteReplyScrapeJob(attempt, ctx, {
          ...options,
          signal,
        });
      } finally {
        active--;
        if (claimed && !signal?.aborted) {
          // Backoff, failure and interruption release capacity just like
          // success.  Rearm a pending retry, then advance a free origin.
          await enqueue(ctx, jobId);
          await dispatch(ctx, 1, job.originHost);
          await dispatch(ctx, 1);
        }
      }
    },
  });

  async function drop(jobId: Uuid) {
    await db
      .update(jobs)
      .set({ nextDispatchAt: clock() })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, "pending")));
  }

  async function capacity(now: Date) {
    if ((await readyDepth()) >= 200) return 0;
    const [row] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          sql`${jobs.nextDispatchAt} > ${now.toISOString()}::timestamptz`,
          lte(jobs.nextDispatchAt, new Date(now.getTime() + RESERVATION_MS)),
        ),
      );
    return Math.max(0, WINDOW_SIZE - row.count);
  }

  async function enqueue(
    ctx: Context<void>,
    jobId: Uuid,
    rearm = false,
  ): Promise<void> {
    if (!enabled() || signal?.aborted) return;
    try {
      const now = clock();
      // Query shared queue pressure before opening a transaction.  Asking
      // the main pool for another connection while holding the last one
      // can deadlock concurrent job creation against its own dispatcher.
      const room = await capacity(now);
      const reservation = await db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.id, jobId),
              eq(jobs.status, "pending"),
              rearm ? undefined : lte(jobs.nextDispatchAt, now),
            ),
          )
          .for("update", { skipLocked: true });
        if (!job) return;
        const [origin] = await tx
          .select()
          .from(origins)
          .where(eq(origins.originHost, job.originHost))
          .for("update", { skipLocked: true });
        if (!origin || origin.processingJobId) return;
        const otherWakeup = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.originHost, job.originHost),
              eq(jobs.status, "pending"),
              sql`${jobs.id} <> ${jobId}`,
              sql`${jobs.nextDispatchAt} > ${now.toISOString()}::timestamptz`,
            ),
          )
          .limit(1);
        if (otherWakeup.length) return;
        const delay = Math.max(
          0,
          job.nextAttemptAt.getTime() - now.getTime(),
          origin.nextRequestAt.getTime() - now.getTime(),
        );
        if (delay === 0 && room === 0) return;
        await tx
          .update(jobs)
          .set({
            nextDispatchAt: new Date(now.getTime() + delay + RESERVATION_MS),
          })
          .where(eq(jobs.id, jobId));
        return { delay };
      });
      if (reservation)
        await ctx.enqueueTask(
          task,
          { jobId },
          { delay: { milliseconds: reservation.delay } },
        );
    } catch (error) {
      logger.error(
        "Scrape {jobId} dispatch failed; recovery will retry: {error}",
        { jobId, error },
      );
    }
  }

  async function dispatch(
    ctx: Context<void>,
    limit: number,
    originHost?: string,
  ) {
    if (!enabled() || signal?.aborted) return;
    const now = clock();
    const room = await capacity(now);
    if (!room) return;
    // The correlated selection avoids DISTINCT with FOR UPDATE, and busy
    // origins are filtered before LIMIT so they cannot starve healthy hosts.
    const candidates = await db
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(origins, eq(origins.originHost, jobs.originHost))
      .where(
        and(
          eq(jobs.status, "pending"),
          lte(jobs.nextDispatchAt, now),
          isNull(origins.processingJobId),
          originHost ? eq(jobs.originHost, originHost) : undefined,
          sql`NOT EXISTS (SELECT 1 FROM ${jobs} reserved WHERE reserved.origin_host = ${jobs.originHost}
          AND reserved.status = 'pending' AND reserved.next_dispatch_at > ${now.toISOString()}::timestamptz)`,
          sql`${jobs.id} = (SELECT candidate.id FROM ${jobs} candidate
          WHERE candidate.origin_host = ${jobs.originHost} AND candidate.status = 'pending'
          AND candidate.next_dispatch_at <= ${now.toISOString()}::timestamptz
          ORDER BY candidate.next_dispatch_at, candidate.id LIMIT 1)`,
        ),
      )
      .orderBy(jobs.nextDispatchAt, jobs.id)
      .limit(Math.min(limit, room));
    for (const job of candidates) await enqueue(ctx, job.id);
  }

  async function reclaim() {
    const now = options.now ?? clock();
    const stale = new Date(
      now.getTime() - (options.staleProcessingSeconds ?? STALE_SECONDS) * 1000,
    );
    // Lock blockers before waiting replies, matching enqueue and completion.
    await db.transaction(async (tx) => {
      const blockers = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.kind, "context"),
            sql`${jobs.status} in ('completed', 'failed')`,
            sql`exists (select 1 from ${jobs} gate where gate.blocked_by_job_id = ${jobs.id} and gate.status = 'waiting')`,
          ),
        )
        .limit(RECOVERY_BATCH)
        .for("update", { skipLocked: true });
      for (const blocker of blockers)
        await settleContextReplies(tx, blocker, now);
      await tx
        .update(jobs)
        .set({
          status: "pending",
          blockedByJobId: null,
          nextDispatchAt: now,
          updated: now,
        })
        .where(and(eq(jobs.status, "waiting"), isNull(jobs.blockedByJobId)));
    });
    await db.transaction(async (tx) => {
      const batch = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, "processing"), lte(jobs.updated, stale)))
        .orderBy(jobs.updated, jobs.id)
        .limit(RECOVERY_BATCH)
        .for("update", { skipLocked: true });
      for (const job of batch) {
        const [origin] = await tx
          .select()
          .from(origins)
          .where(eq(origins.originHost, job.originHost))
          .for("update", { skipLocked: true });
        if (!origin) continue;
        await tx
          .update(jobs)
          .set({
            status: "pending",
            startedAt: null,
            nextDispatchAt: now,
            errorMessage: "Reclaimed stale processing job",
            updated: now,
          })
          .where(eq(jobs.id, job.id));
        if (origin.processingJobId === job.id)
          await tx
            .update(origins)
            .set({
              processingJobId: null,
              processingStartedAt: null,
              updated: now,
            })
            .where(eq(origins.originHost, job.originHost));
      }
      const orphaned = await tx
        .select()
        .from(origins)
        .where(
          and(
            lte(origins.processingStartedAt, stale),
            sql`NOT EXISTS (
          SELECT 1 FROM ${jobs} owner WHERE owner.id = ${origins.processingJobId} AND owner.status = 'processing'
        )`,
          ),
        )
        .limit(RECOVERY_BATCH)
        .for("update", { skipLocked: true });
      for (const origin of orphaned)
        await tx
          .update(origins)
          .set({
            processingJobId: null,
            processingStartedAt: null,
            updated: now,
          })
          .where(eq(origins.originHost, origin.originHost));
    });
  }

  async function recover(ctx: Context<void>) {
    if (!enabled() || signal?.aborted) return;
    await reclaim();
    await dispatch(ctx, RECOVERY_BATCH);
  }

  return {
    task,
    enqueue,
    recover,
    reclaim,
    setSignal(value: AbortSignal) {
      signal = value;
    },
  };
}
