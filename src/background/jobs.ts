import {
  createExponentialBackoffPolicy,
  type Context,
  type Federation,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import db from "../db";
import * as schema from "../schema";
import { uuid, type Uuid } from "../uuid";
import { JobCancelledError, TerminalJobItemError } from "./errors";
import { itemLeases, type Lease } from "./lease";

export type JobKind = "import" | "cleanup";
const logger = getLogger(["hollo", "tasks"]);
const activeStatuses = ["pending", "processing"] as const;
const WINDOW_SIZE = 50;
const RECOVERY_BATCH = 100;
const QUEUE_HIGH_WATER = 200;
const itemSchema = z.object({ jobId: uuid, itemId: uuid });
const jobSchema = z.object({ jobId: uuid });
const retryPolicy = createExponentialBackoffPolicy({
  initialDelay: { seconds: 5 },
  factor: 1,
  jitter: false,
  maxAttempts: 5,
});

function tables(kind: JobKind) {
  return kind === "import"
    ? { jobs: schema.importJobs, items: schema.importJobItems }
    : { jobs: schema.cleanupJobs, items: schema.cleanupJobItems };
}

export function registerBackgroundJobs(
  federation: Federation<void>,
  queueDepth: () => Promise<number>,
) {
  let signal: AbortSignal | undefined;
  const define = (kind: JobKind) => {
    const item = federation.defineTask(`hollo.${kind}-item.v1`, {
      schema: itemSchema,
      handler: (ctx, data) => execute(kind, ctx, data),
      retryPolicy,
      onError: (_ctx, error, data) => {
        logger.error("{kind} item {itemId} attempt failed: {error}", {
          kind,
          itemId: data.itemId,
          error,
        });
      },
    });
    const dispatch = federation.defineTask(`hollo.${kind}-dispatch.v1`, {
      schema: jobSchema,
      handler: (ctx, data) => dispatchItems(kind, ctx, data.jobId),
      retryPolicy,
    });
    return { item, dispatch };
  };
  const tasks = { import: define("import"), cleanup: define("cleanup") };

  async function enqueueJob(ctx: Context<void>, kind: JobKind, jobId: Uuid) {
    try {
      await ctx.enqueueTask(tasks[kind].dispatch, { jobId });
    } catch (error) {
      logger.error(
        "Job {jobId} committed but dispatch failed; recovery will retry: {error}",
        { jobId, error },
      );
    }
  }

  async function finish(
    lease: Lease,
    kind: JobKind,
    itemId: Uuid,
    jobId: Uuid,
    status: "completed" | "failed" | "cancelled",
    errorMessage: string | null,
    attempts: number,
  ) {
    const { items, jobs } = tables(kind);
    lease.assertOwned();
    await lease.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .for("no key update");
    await lease.db
      .update(items)
      .set({
        status,
        attempts,
        errorMessage,
        processedAt: sql`clock_timestamp()`,
      })
      .where(eq(items.id, itemId));
    if (status !== "cancelled") {
      await lease.db
        .update(jobs)
        .set({
          processedItems: sql`${jobs.processedItems} + 1`,
          successfulItems: sql`${jobs.successfulItems} + ${status === "completed" ? 1 : 0}`,
          failedItems: sql`${jobs.failedItems} + ${status === "failed" ? 1 : 0}`,
        })
        .where(eq(jobs.id, jobId));
    }
  }

  async function execute(
    kind: JobKind,
    ctx: Context<void>,
    data: z.infer<typeof itemSchema>,
  ) {
    if (signal?.aborted) return;
    let retryError: unknown;
    let retry = false;
    let terminal = false;
    let delay = 0;
    const { items, jobs } = tables(kind);
    try {
      await itemLeases.run(async (lease) => {
        const [item] = await lease.db
          .select()
          .from(items)
          .where(
            and(
              eq(items.id, data.itemId),
              eq(items.jobId, data.jobId),
              inArray(items.status, activeStatuses),
            ),
          )
          .for("no key update", { skipLocked: true });
        if (!item) return;
        const [job] = await lease.db
          .select()
          .from(jobs)
          .where(eq(jobs.id, data.jobId));
        if (!job) return;
        const prepared =
          kind === "import" &&
          (
            await lease.db
              .select({ id: schema.importJobEffects.itemId })
              .from(schema.importJobEffects)
              .where(eq(schema.importJobEffects.itemId, item.id))
          ).length > 0;
        if (
          !activeStatuses.includes(job.status as "pending" | "processing") &&
          !(kind === "import" && job.status === "cancelled" && prepared)
        )
          return;
        const [clock] = await lease.db
          .select({
            remaining:
              sql<number>`greatest(0, extract(epoch from (${items.nextAttemptAt} - clock_timestamp())) * 1000)`.mapWith(
                Number,
              ),
          })
          .from(items)
          .where(eq(items.id, item.id));
        if (clock.remaining > 0) {
          delay = Math.ceil(clock.remaining);
          return;
        }
        await lease.db
          .update(items)
          .set({ status: "processing" })
          .where(eq(items.id, item.id));
        const check = () => {
          lease.assertOwned();
          signal?.throwIfAborted();
        };
        const checkActive = async () => {
          check();
          const [current] = await db
            .select({ status: jobs.status })
            .from(jobs)
            .where(eq(jobs.id, job.id));
          check();
          if (
            !current ||
            !activeStatuses.includes(current.status as "pending" | "processing")
          )
            throw new JobCancelledError("Job cancelled or deleted");
        };
        try {
          if (prepared) check();
          else await checkActive();
          if (kind === "import") {
            const { executeImportItem } = await import("../import/worker");
            await executeImportItem(
              job as schema.ImportJob,
              item,
              checkActive,
              lease,
              async () => check(),
            );
          } else {
            const { executeCleanupItem } = await import("../cleanup/worker");
            await executeCleanupItem(item, checkActive, () =>
              enqueueJob(ctx, kind, job.id),
            );
          }
          check();
          await finish(
            lease,
            kind,
            item.id,
            job.id,
            "completed",
            null,
            item.attempts,
          );
          terminal = true;
        } catch (error) {
          check();
          const message =
            error instanceof Error ? error.message : String(error);
          if (error instanceof JobCancelledError) {
            await finish(
              lease,
              kind,
              item.id,
              job.id,
              "cancelled",
              message,
              item.attempts,
            );
            return;
          }
          const attempts = item.attempts + 1;
          if (error instanceof TerminalJobItemError || attempts >= 5) {
            await finish(
              lease,
              kind,
              item.id,
              job.id,
              "failed",
              message,
              attempts,
            );
            logger.error("{kind} item {itemId} failed permanently: {error}", {
              kind,
              itemId: item.id,
              error,
            });
            terminal = true;
          } else {
            await lease.db
              .update(items)
              .set({
                status: "pending",
                attempts,
                errorMessage: message,
                nextAttemptAt: sql`clock_timestamp() + interval '5 seconds'`,
              })
              .where(eq(items.id, item.id));
            retry = true;
            retryError = error;
          }
        }
      });
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
    if (terminal) await enqueueJob(ctx, kind, data.jobId);
    if (delay > 0)
      await ctx.enqueueTask(tasks[kind].item, data, {
        delay: { milliseconds: delay },
      });
    if (retry) throw retryError;
  }

  async function dispatchItems(kind: JobKind, ctx: Context<void>, jobId: Uuid) {
    if (signal?.aborted) return;
    const { jobs, items } = tables(kind);
    const selected = await db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, jobId),
            or(
              inArray(jobs.status, activeStatuses),
              kind === "import" ? eq(jobs.status, "cancelled") : undefined,
            ),
          ),
        )
        .for("no key update");
      if (!job) return [];
      // Validate an initial batch once. Migration diagnoses already-started
      // partial legacy jobs; routine completion dispatch must not rescan N rows.
      if (job.status !== "cancelled" && job.startedAt == null) {
        const [stats] = await tx
          .select({ total: sql<number>`count(*)`.mapWith(Number) })
          .from(items)
          .where(eq(items.jobId, jobId));
        if (stats.total < job.totalItems) {
          await tx
            .update(jobs)
            .set({
              status: "failed",
              completedAt: sql`clock_timestamp()`,
              errorMessage:
                "Incomplete legacy job batch; upload or schedule this job again",
            })
            .where(eq(jobs.id, jobId));
          return [];
        }
      }
      if (job.status !== "cancelled" && job.processedItems >= job.totalItems) {
        const unfinished = await tx
          .select({ id: items.id })
          .from(items)
          .where(
            and(eq(items.jobId, jobId), inArray(items.status, activeStatuses)),
          )
          .limit(1);
        if (unfinished.length === 0) {
          await tx
            .update(jobs)
            .set({ status: "completed", completedAt: sql`clock_timestamp()` })
            .where(eq(jobs.id, jobId));
          return [];
        }
      }
      const remainingDelivery =
        job.status === "cancelled"
          ? inArray(
              items.id,
              tx
                .select({ id: schema.importJobEffects.itemId })
                .from(schema.importJobEffects)
                .where(
                  sql`${schema.importJobEffects.delivered} < jsonb_array_length(${schema.importJobEffects.deliveries})`,
                ),
            )
          : undefined;
      const reserved = await tx
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            eq(items.jobId, jobId),
            inArray(items.status, activeStatuses),
            sql`${items.nextDispatchAt} > clock_timestamp()`,
            remainingDelivery,
          ),
        )
        .limit(WINDOW_SIZE);
      if (job.status !== "cancelled")
        await tx
          .update(jobs)
          .set({
            status: "processing",
            startedAt: job.startedAt ?? sql`clock_timestamp()`,
          })
          .where(eq(jobs.id, jobId));
      if (
        reserved.length >= WINDOW_SIZE ||
        (await queueDepth()) >= QUEUE_HIGH_WATER
      )
        return [];
      const batch = await tx
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            eq(items.jobId, jobId),
            inArray(items.status, activeStatuses),
            sql`${items.nextDispatchAt} <= clock_timestamp()`,
            sql`${items.nextAttemptAt} <= clock_timestamp()`,
            remainingDelivery,
          ),
        )
        .orderBy(items.nextDispatchAt, items.id)
        .limit(WINDOW_SIZE - reserved.length)
        .for("no key update", { skipLocked: true });
      if (batch.length > 0)
        await tx
          .update(items)
          .set({ nextDispatchAt: sql`clock_timestamp() + interval '1 minute'` })
          .where(
            inArray(
              items.id,
              batch.map((row) => row.id),
            ),
          );
      return batch;
    });
    for (const row of selected) {
      if (signal?.aborted) break;
      try {
        await ctx.enqueueTask(tasks[kind].item, { jobId, itemId: row.id });
      } catch (error) {
        logger.error(
          "Item {itemId} dispatch failed; recovery will retry: {error}",
          { itemId: row.id, error },
        );
      }
    }
  }

  let firstRecoveryKind: JobKind = "import";
  async function recover(ctx: Context<void>) {
    const second = firstRecoveryKind === "import" ? "cleanup" : "import";
    const order = [firstRecoveryKind, second] as const;
    firstRecoveryKind = second;
    for (const kind of order) {
      if (signal?.aborted || (await queueDepth()) >= QUEUE_HIGH_WATER) return;
      const { jobs } = tables(kind);
      const batch = await db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            kind === "import"
              ? sql`${jobs.id} IN (
              SELECT id FROM (
                (SELECT id, next_dispatch_at FROM ${schema.importJobs}
                 WHERE status IN ('pending', 'processing') AND next_dispatch_at <= clock_timestamp()
                 ORDER BY next_dispatch_at, id LIMIT ${RECOVERY_BATCH})
                UNION
                (SELECT DISTINCT j.id, j.next_dispatch_at FROM ${schema.importJobEffects} e
                 JOIN ${schema.importJobItems} i ON i.id = e.item_id
                 JOIN ${schema.importJobs} j ON j.id = i.job_id
                 WHERE j.status = 'cancelled' AND j.next_dispatch_at <= clock_timestamp()
                   AND i.status IN ('pending', 'processing')
                   AND e.delivered < jsonb_array_length(e.deliveries)
                 ORDER BY j.next_dispatch_at, j.id LIMIT ${RECOVERY_BATCH})
              ) candidates
            )`
              : and(
                  inArray(jobs.status, activeStatuses),
                  sql`${jobs.nextDispatchAt} <= clock_timestamp()`,
                ),
          )
          .orderBy(jobs.nextDispatchAt, jobs.id)
          .limit(RECOVERY_BATCH)
          .for("no key update", { skipLocked: true });
        if (rows.length > 0)
          await tx
            .update(jobs)
            .set({
              nextDispatchAt: sql`clock_timestamp() + interval '1 minute'`,
            })
            .where(
              inArray(
                jobs.id,
                rows.map((row) => row.id),
              ),
            );
        return rows;
      });
      for (const row of batch) {
        if (signal?.aborted) return;
        await enqueueJob(ctx, kind, row.id);
      }
    }
  }

  function startRecovery(ctx: Context<void>, abortSignal: AbortSignal) {
    signal = abortSignal;
    let running: Promise<void> | undefined;
    const pass = () => {
      if (running || signal?.aborted) return;
      running = recover(ctx)
        .catch((error: unknown) => {
          logger.error("Job recovery failed: {error}", { error });
        })
        .finally(() => {
          running = undefined;
        });
    };
    const timer = setInterval(pass, 60_000);
    pass();
    return async () => {
      clearInterval(timer);
      await running;
    };
  }

  return {
    enqueueJob,
    recover,
    startRecovery,
    setSignal(value: AbortSignal) {
      signal = value;
    },
  };
}
