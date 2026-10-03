import type { Context } from "@fedify/fedify";
import { Collection, type DocumentLoader, lookupObject } from "@fedify/vocab";
import { and, eq, isNull, lte, sql } from "drizzle-orm";

import db from "../db";
import {
  posts,
  type RemoteReplyScrapeJob,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
} from "../schema";
import type { Uuid } from "../uuid";
import { iterateCollection } from "./collection";
import { isPost, persistPost } from "./post";
import {
  enqueueRemoteReplyScrape,
  laterBySeconds,
  REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS,
  REMOTE_REPLIES_SCRAPE_DEPTH,
  REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS,
  REMOTE_REPLIES_SCRAPE_MAX_ITEMS,
} from "./replies";

export const STALE_PROCESSING_TIMEOUT_SECONDS = 15 * 60;

class LostScrapeAttempt extends Error {}

export interface ProcessRemoteReplyScrapeJobsOptions {
  signal?: AbortSignal;
  backoffSeconds?: number;
  clock?: () => Date;
  documentLoader?: DocumentLoader;
  intervalSeconds?: number;
  maxDepth?: number;
  maxItems?: number;
  maxJobs?: number;
  now?: Date;
  sleep?: (milliseconds: number) => Promise<void>;
  staleProcessingSeconds?: number;
}

export async function claimRemoteReplyScrapeJob(
  jobId: Uuid,
  now = new Date(),
): Promise<RemoteReplyScrapeJob | null> {
  return await db.transaction(async (tx) => {
    const [claimableJob] = await tx
      .select({ job: remoteReplyScrapeJobs })
      .from(remoteReplyScrapeJobs)
      .innerJoin(
        remoteReplyScrapeOrigins,
        eq(
          remoteReplyScrapeOrigins.originHost,
          remoteReplyScrapeJobs.originHost,
        ),
      )
      .where(
        and(
          eq(remoteReplyScrapeJobs.id, jobId),
          eq(remoteReplyScrapeJobs.status, "pending"),
          lte(remoteReplyScrapeJobs.nextAttemptAt, now),
          isNull(remoteReplyScrapeOrigins.processingJobId),
          lte(remoteReplyScrapeOrigins.nextRequestAt, now),
        ),
      )
      .limit(1)
      .for("update", { skipLocked: true });

    const job = claimableJob?.job;
    if (job == null) return null;

    await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "processing",
        attempts: sql`${remoteReplyScrapeJobs.attempts} + 1`,
        startedAt: now,
        updated: now,
      })
      .where(eq(remoteReplyScrapeJobs.id, job.id));

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        processingJobId: job.id,
        processingStartedAt: now,
        updated: now,
      })
      .where(eq(remoteReplyScrapeOrigins.originHost, job.originHost));

    return {
      ...job,
      status: "processing",
      attempts: job.attempts + 1,
      startedAt: now,
      updated: now,
    };
  });
}

export async function processRemoteReplyScrapeJob(
  job: RemoteReplyScrapeJob,
  ctx: Context<void>,
  options: ProcessRemoteReplyScrapeJobsOptions = {},
): Promise<number> {
  const clock = options.clock ?? (() => options.now ?? new Date());
  let lost: unknown;
  let interrupted = false;
  let lastProgress = Date.now();
  let refreshing: Promise<void> | undefined;
  const checkpoint = async () => {
    if (lost != null) throw lost;
    if (options.signal?.aborted) {
      interrupted = true;
      throw options.signal.reason;
    }
    await updateProcessingHeartbeat(job, clock());
    lastProgress = Date.now();
  };
  const staleSeconds =
    options.staleProcessingSeconds ?? STALE_PROCESSING_TIMEOUT_SECONDS;
  const timer = setInterval(
    () => {
      if (refreshing || Date.now() - lastProgress >= staleSeconds * 1000)
        return;
      refreshing = updateProcessingHeartbeat(job, clock())
        .catch((error: unknown) => {
          if (error instanceof LostScrapeAttempt) lost = error;
        })
        .finally(() => {
          refreshing = undefined;
        });
    },
    Math.max(1, staleSeconds * 500),
  );
  timer.unref();
  try {
    const post = await db.query.posts.findFirst({
      where: { id: { eq: job.postId } },
    });

    if (post == null) {
      await failJob(job, "Post not found", clock());
      return 0;
    }

    let fetchedItems = 0;
    let lastFetchError: unknown;
    let lastFetchErrorUrl: URL | undefined;
    const isLastFetchOriginRateLimit = (error: unknown = lastFetchError) =>
      error === lastFetchError &&
      isOriginRateLimit(error, lastFetchErrorUrl, job);

    try {
      const documentLoader =
        options.documentLoader ??
        (await getDefaultDocumentLoader(ctx, job.baseUrl));
      const throttledDocumentLoader = createThrottledDocumentLoader(job, {
        documentLoader,
        intervalSeconds:
          options.intervalSeconds ?? REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS,
        staleProcessingSeconds:
          options.staleProcessingSeconds ?? STALE_PROCESSING_TIMEOUT_SECONDS,
        clock,
        sleep: options.sleep ?? ((ms) => sleep(ms, options.signal)),
        checkpoint,
      });
      const recordingDocumentLoader: DocumentLoader = async (
        url,
        loadOptions,
      ) => {
        try {
          return await throttledDocumentLoader(url, loadOptions);
        } catch (error) {
          if (error instanceof LostScrapeAttempt) lost = error;
          if (options.signal?.aborted) interrupted = true;
          lastFetchError = error;
          lastFetchErrorUrl = new URL(url);
          throw error;
        }
      };
      const collection = await lookupObject(new URL(job.repliesIri), {
        documentLoader: recordingDocumentLoader,
      });

      if (collection == null && isLastFetchOriginRateLimit()) {
        throw lastFetchError;
      }

      if (collection == null) {
        throw new Error(`Replies collection not found: ${job.repliesIri}`);
      }

      if (!(collection instanceof Collection)) {
        throw new Error(
          `Replies collection is not a Collection: ${job.repliesIri}`,
        );
      }

      for await (const item of iterateCollection(collection, {
        documentLoader: recordingDocumentLoader,
      })) {
        if (
          fetchedItems >= (options.maxItems ?? REMOTE_REPLIES_SCRAPE_MAX_ITEMS)
        ) {
          break;
        }
        if (!isPost(item)) continue;

        await checkpoint();
        const reply = await persistPost(db, item, job.baseUrl, {
          documentLoader: recordingDocumentLoader,
          enqueueRemoteReplies: false,
          fetchEmojiReactions: false,
          replyTarget: post,
          skipUpdate: true,
        });
        await checkpoint();
        if (reply == null) continue;

        fetchedItems++;
        const childRepliesIri = item.repliesId;
        if (
          childRepliesIri != null &&
          job.depth + 1 < (options.maxDepth ?? REMOTE_REPLIES_SCRAPE_DEPTH)
        ) {
          await enqueueRemoteReplyScrape(db, {
            baseUrl: job.baseUrl,
            depth: job.depth + 1,
            post: reply,
            repliesIri: childRepliesIri,
          });
        }
      }

      await checkpoint();
      await updateScrapedRepliesCount(job.postId);
      await completeJob(job, fetchedItems, clock());
      return fetchedItems;
    } catch (error) {
      if (lost != null || error instanceof LostScrapeAttempt) return 0;
      if (interrupted || options.signal?.aborted) {
        await interruptJob(job, clock());
        return 0;
      }
      await checkpoint();
      await updateScrapedRepliesCount(job.postId);
      if (isLastFetchOriginRateLimit(error)) {
        const failedAt = clock();
        await backOffJob(
          job,
          retryAfterSeconds(error, failedAt) ??
            options.backoffSeconds ??
            REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS,
          error,
          failedAt,
        );
        return 0;
      }
      await failJob(
        job,
        error instanceof Error ? error.message : String(error),
        clock(),
      );
      return 0;
    }
  } finally {
    clearInterval(timer);
    await refreshing;
  }
}

function createThrottledDocumentLoader(
  job: RemoteReplyScrapeJob,
  {
    documentLoader,
    intervalSeconds,
    staleProcessingSeconds,
    clock,
    sleep,
    checkpoint,
  }: {
    checkpoint: () => Promise<void>;
    clock: () => Date;
    documentLoader: DocumentLoader;
    intervalSeconds: number;
    sleep: (milliseconds: number) => Promise<void>;
    staleProcessingSeconds: number;
  },
): DocumentLoader {
  let originRequests = 0;

  return async (url, options) => {
    const sameOrigin = new URL(url).host === job.originHost;
    if (sameOrigin && originRequests > 0) {
      await sleepWithProcessingHeartbeats(job, {
        clock,
        seconds: intervalSeconds,
        sleep,
        staleProcessingSeconds,
      });
    }
    if (sameOrigin) originRequests++;

    try {
      await checkpoint();
      return await documentLoader(url, options);
    } finally {
      const requestTime = clock();
      await db.transaction(async (tx) => {
        const [updatedJob] = await tx
          .update(remoteReplyScrapeJobs)
          .set({ updated: requestTime })
          .where(processingJobAttemptCondition(job))
          .returning({ id: remoteReplyScrapeJobs.id });
        if (updatedJob == null) {
          await releaseOriginLeaseIfJobDeleted(tx, job, requestTime);
          return;
        }

        if (sameOrigin) {
          await tx
            .update(remoteReplyScrapeOrigins)
            .set({
              lastRequestAt: requestTime,
              nextRequestAt: laterBySeconds(intervalSeconds, requestTime),
              processingStartedAt: requestTime,
              updated: requestTime,
            })
            .where(
              and(
                eq(remoteReplyScrapeOrigins.originHost, job.originHost),
                eq(remoteReplyScrapeOrigins.processingJobId, job.id),
              ),
            );
        } else {
          await tx
            .update(remoteReplyScrapeOrigins)
            .set({
              processingStartedAt: requestTime,
              updated: requestTime,
            })
            .where(
              and(
                eq(remoteReplyScrapeOrigins.originHost, job.originHost),
                eq(remoteReplyScrapeOrigins.processingJobId, job.id),
              ),
            );
        }
      });
    }
  };
}

function processingJobAttemptCondition(job: RemoteReplyScrapeJob) {
  return and(
    eq(remoteReplyScrapeJobs.id, job.id),
    eq(remoteReplyScrapeJobs.status, "processing"),
    eq(remoteReplyScrapeJobs.attempts, job.attempts),
    job.startedAt == null
      ? isNull(remoteReplyScrapeJobs.startedAt)
      : eq(remoteReplyScrapeJobs.startedAt, job.startedAt),
  );
}

async function sleepWithProcessingHeartbeats(
  job: RemoteReplyScrapeJob,
  {
    clock,
    seconds,
    sleep,
    staleProcessingSeconds,
  }: {
    clock: () => Date;
    seconds: number;
    sleep: (milliseconds: number) => Promise<void>;
    staleProcessingSeconds: number;
  },
): Promise<void> {
  let remainingMilliseconds = seconds * 1000;
  if (remainingMilliseconds <= 0) return;

  const heartbeatMilliseconds =
    Math.max(1, Math.floor(staleProcessingSeconds / 2)) * 1000;

  while (remainingMilliseconds > 0) {
    await updateProcessingHeartbeat(job, clock());
    const sleepMilliseconds = Math.min(
      remainingMilliseconds,
      heartbeatMilliseconds,
    );
    await sleep(sleepMilliseconds);
    remainingMilliseconds -= sleepMilliseconds;
  }
}

async function updateProcessingHeartbeat(
  job: RemoteReplyScrapeJob,
  now: Date,
): Promise<void> {
  const owned = await db.transaction(async (tx) => {
    const [updatedJob] = await tx
      .update(remoteReplyScrapeJobs)
      .set({ updated: now })
      .where(processingJobAttemptCondition(job))
      .returning({ id: remoteReplyScrapeJobs.id });
    if (updatedJob == null) {
      await releaseOriginLeaseIfJobDeleted(tx, job, now);
      return false;
    }

    const owned = await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        processingStartedAt: now,
        updated: now,
      })
      .where(
        and(
          eq(remoteReplyScrapeOrigins.originHost, job.originHost),
          eq(remoteReplyScrapeOrigins.processingJobId, job.id),
        ),
      )
      .returning({ host: remoteReplyScrapeOrigins.originHost });
    return owned.length > 0;
  });
  if (!owned)
    throw new LostScrapeAttempt(
      "Scrape attempt no longer owns the job and origin",
    );
}

async function updateScrapedRepliesCount(
  postId: RemoteReplyScrapeJob["postId"],
) {
  await db.execute(sql`
    update ${posts}
    set replies_count = (
      select count(*)
      from ${posts} as replies
      where replies.reply_target_id = ${postId}
    )
    where ${posts.id} = ${postId}
  `);
}

async function completeJob(
  job: RemoteReplyScrapeJob,
  fetchedItems: number,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updatedJob] = await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "completed",
        nextDispatchAt: now,
        fetchedItems,
        completedAt: now,
        errorMessage: null,
        updated: now,
      })
      .where(processingJobAttemptCondition(job))
      .returning({ id: remoteReplyScrapeJobs.id });
    if (updatedJob == null) {
      await releaseOriginLeaseIfJobDeleted(tx, job, now);
      return;
    }

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        processingJobId: null,
        processingStartedAt: null,
        updated: sql`greatest(${remoteReplyScrapeOrigins.updated}, ${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(remoteReplyScrapeOrigins.originHost, job.originHost),
          eq(remoteReplyScrapeOrigins.processingJobId, job.id),
        ),
      );
  });
}

async function failJob(
  job: RemoteReplyScrapeJob,
  message: string,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updatedJob] = await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "failed",
        nextDispatchAt: now,
        errorMessage: message,
        completedAt: now,
        updated: now,
      })
      .where(processingJobAttemptCondition(job))
      .returning({ id: remoteReplyScrapeJobs.id });
    if (updatedJob == null) {
      await releaseOriginLeaseIfJobDeleted(tx, job, now);
      return;
    }

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        processingJobId: null,
        processingStartedAt: null,
        updated: sql`greatest(${remoteReplyScrapeOrigins.updated}, ${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(remoteReplyScrapeOrigins.originHost, job.originHost),
          eq(remoteReplyScrapeOrigins.processingJobId, job.id),
        ),
      );
  });
}

async function backOffJob(
  job: RemoteReplyScrapeJob,
  seconds: number,
  error: unknown,
  now: Date,
): Promise<void> {
  const nextAttemptAt = laterBySeconds(seconds, now);
  await db.transaction(async (tx) => {
    const [updatedJob] = await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "pending",
        nextDispatchAt: now,
        nextAttemptAt,
        errorMessage: error instanceof Error ? error.message : String(error),
        startedAt: null,
        completedAt: null,
        updated: now,
      })
      .where(processingJobAttemptCondition(job))
      .returning({ id: remoteReplyScrapeJobs.id });
    if (updatedJob == null) {
      await releaseOriginLeaseIfJobDeleted(tx, job, now);
      return;
    }

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        nextRequestAt: nextAttemptAt,
        processingJobId: null,
        processingStartedAt: null,
        updated: sql`greatest(${remoteReplyScrapeOrigins.updated}, ${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(remoteReplyScrapeOrigins.originHost, job.originHost),
          eq(remoteReplyScrapeOrigins.processingJobId, job.id),
        ),
      );
  });
}

async function releaseOriginLeaseIfJobDeleted(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  job: RemoteReplyScrapeJob,
  now: Date,
): Promise<void> {
  const [existingJob] = await tx
    .select({ id: remoteReplyScrapeJobs.id })
    .from(remoteReplyScrapeJobs)
    .where(eq(remoteReplyScrapeJobs.id, job.id))
    .limit(1);
  if (existingJob != null) return;

  await tx
    .update(remoteReplyScrapeOrigins)
    .set({
      processingJobId: null,
      processingStartedAt: null,
      updated: sql`greatest(${remoteReplyScrapeOrigins.updated}, ${now.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(remoteReplyScrapeOrigins.originHost, job.originHost),
        eq(remoteReplyScrapeOrigins.processingJobId, job.id),
      ),
    );
}

async function getDefaultDocumentLoader(
  ctx: Context<void>,
  baseUrl: string,
): Promise<DocumentLoader> {
  const context = ctx.federation.createContext(new URL(baseUrl), undefined);
  const owner = await db.query.accountOwners.findFirst();
  if (owner == null) return context.documentLoader;

  // Remote replies collections can vary by the signer, so crawling them with
  // the anonymous loader would omit replies visible to the local actor.
  return await context.getDocumentLoader({ username: owner.handle });
}

function getErrorStatus(error: unknown): number | null {
  if (
    error == null ||
    typeof error !== "object" ||
    !("response" in error) ||
    !(error.response instanceof Response)
  ) {
    return null;
  }
  return error.response.status;
}

function isOriginRateLimit(
  error: unknown,
  errorUrl: URL | undefined,
  job: RemoteReplyScrapeJob,
): boolean {
  return getErrorStatus(error) === 429 && errorUrl?.host === job.originHost;
}

function retryAfterSeconds(error: unknown, now = new Date()): number | null {
  if (
    error == null ||
    typeof error !== "object" ||
    !("response" in error) ||
    !(error.response instanceof Response)
  ) {
    return null;
  }

  const retryAfter = error.response.headers.get("Retry-After");
  if (retryAfter == null) return null;

  const trimmedRetryAfter = retryAfter.trim();
  if (/^-?\d+$/.test(trimmedRetryAfter)) {
    const seconds = Number.parseInt(trimmedRetryAfter, 10);
    return seconds >= 0 ? seconds : null;
  }

  const date = Date.parse(trimmedRetryAfter);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now.getTime()) / 1000));
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function interruptJob(job: RemoteReplyScrapeJob, now: Date) {
  await db.transaction(async (tx) => {
    const [owned] = await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "pending",
        nextDispatchAt: now,
        startedAt: null,
        updated: now,
      })
      .where(processingJobAttemptCondition(job))
      .returning({ id: remoteReplyScrapeJobs.id });
    if (!owned) {
      await releaseOriginLeaseIfJobDeleted(tx, job, now);
      return;
    }
    await tx
      .update(remoteReplyScrapeOrigins)
      .set({ processingJobId: null, processingStartedAt: null, updated: now })
      .where(
        and(
          eq(remoteReplyScrapeOrigins.originHost, job.originHost),
          eq(remoteReplyScrapeOrigins.processingJobId, job.id),
        ),
      );
  });
}
