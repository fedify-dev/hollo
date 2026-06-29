import { Collection, type DocumentLoader, lookupObject } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";

import db from "../db";
import {
  posts,
  type RemoteReplyScrapeJob,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
} from "../schema";
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

const logger = getLogger(["hollo", "federation", "replies-worker"]);

const POLL_INTERVAL_MS = 5000;
const STALE_PROCESSING_TIMEOUT_SECONDS = 15 * 60;

let isRunning = false;
let isPolling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export interface ProcessRemoteReplyScrapeJobsOptions {
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

export function startRemoteReplyScrapeWorker(): void {
  if (isRunning) {
    logger.warn("Remote reply scrape worker is already running");
    return;
  }

  isRunning = true;
  logger.info("Starting remote reply scrape worker");

  runRemoteReplyScrapeWorkerPoll().catch((error) => {
    logger.error("Error in initial remote reply scrape worker poll: {error}", {
      error,
    });
  });

  pollTimer = setInterval(() => {
    runRemoteReplyScrapeWorkerPoll().catch((error) => {
      logger.error("Error in remote reply scrape worker poll: {error}", {
        error,
      });
    });
  }, POLL_INTERVAL_MS);
}

export function stopRemoteReplyScrapeWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
  logger.info("Remote reply scrape worker stopped");
}

export async function processDueRemoteReplyScrapeJobs(
  options: ProcessRemoteReplyScrapeJobsOptions = {},
): Promise<number> {
  if ((options.maxDepth ?? REMOTE_REPLIES_SCRAPE_DEPTH) < 1) return 0;

  const maxJobs = options.maxJobs ?? 1;
  let processedItems = 0;

  for (let i = 0; i < maxJobs; i++) {
    const job = await claimRemoteReplyScrapeJob(
      options.now,
      options.staleProcessingSeconds,
    );
    if (job == null) break;
    processedItems += await processRemoteReplyScrapeJob(job, options);
  }

  return processedItems;
}

export async function claimRemoteReplyScrapeJob(
  now = new Date(),
  staleProcessingSeconds = STALE_PROCESSING_TIMEOUT_SECONDS,
): Promise<RemoteReplyScrapeJob | null> {
  return await db.transaction(async (tx) => {
    const staleStartedBefore = new Date(
      now.getTime() - staleProcessingSeconds * 1000,
    );

    await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "pending",
        nextAttemptAt: now,
        errorMessage: "Reclaimed stale processing job",
        startedAt: null,
        updated: now,
      })
      .where(
        and(
          eq(remoteReplyScrapeJobs.status, "processing"),
          lte(remoteReplyScrapeJobs.updated, staleStartedBefore),
        ),
      );

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        processingJobId: null,
        processingStartedAt: null,
        updated: now,
      })
      .where(
        and(
          isNotNull(remoteReplyScrapeOrigins.processingStartedAt),
          lte(remoteReplyScrapeOrigins.processingStartedAt, staleStartedBefore),
        ),
      );

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
          eq(remoteReplyScrapeJobs.status, "pending"),
          lte(remoteReplyScrapeJobs.nextAttemptAt, now),
          isNull(remoteReplyScrapeOrigins.processingJobId),
          lte(remoteReplyScrapeOrigins.nextRequestAt, now),
        ),
      )
      .orderBy(asc(remoteReplyScrapeJobs.created))
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

async function pollAndProcess(): Promise<void> {
  await processDueRemoteReplyScrapeJobs();
}

export async function runRemoteReplyScrapeWorkerPoll(
  processJobs: () => Promise<void> = pollAndProcess,
): Promise<void> {
  if (isPolling) return;

  isPolling = true;
  try {
    await processJobs();
  } finally {
    isPolling = false;
  }
}

async function processRemoteReplyScrapeJob(
  job: RemoteReplyScrapeJob,
  options: ProcessRemoteReplyScrapeJobsOptions,
): Promise<number> {
  const clock = options.clock ?? (() => options.now ?? new Date());
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
      options.documentLoader ?? (await getDefaultDocumentLoader(job.baseUrl));
    const throttledDocumentLoader = createThrottledDocumentLoader(job, {
      documentLoader,
      intervalSeconds:
        options.intervalSeconds ?? REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS,
      staleProcessingSeconds:
        options.staleProcessingSeconds ?? STALE_PROCESSING_TIMEOUT_SECONDS,
      clock,
      sleep: options.sleep ?? sleep,
    });
    const recordingDocumentLoader: DocumentLoader = async (url, options) => {
      try {
        return await throttledDocumentLoader(url, options);
      } catch (error) {
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

      await updateProcessingHeartbeat(job, clock());
      const reply = await persistPost(db, item, job.baseUrl, {
        documentLoader: recordingDocumentLoader,
        enqueueRemoteReplies: false,
        fetchEmojiReactions: false,
        replyTarget: post,
        skipUpdate: true,
      });
      await updateProcessingHeartbeat(job, clock());
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

    await updateScrapedRepliesCount(job.postId);
    await completeJob(job, fetchedItems, clock());
    return fetchedItems;
  } catch (error) {
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
}

function createThrottledDocumentLoader(
  job: RemoteReplyScrapeJob,
  {
    documentLoader,
    intervalSeconds,
    staleProcessingSeconds,
    clock,
    sleep,
  }: {
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
      await updateProcessingHeartbeat(job, clock());
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
  await db.transaction(async (tx) => {
    const [updatedJob] = await tx
      .update(remoteReplyScrapeJobs)
      .set({ updated: now })
      .where(processingJobAttemptCondition(job))
      .returning({ id: remoteReplyScrapeJobs.id });
    if (updatedJob == null) {
      await releaseOriginLeaseIfJobDeleted(tx, job, now);
      return;
    }

    await tx
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
      );
  });
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
  baseUrl: string,
): Promise<DocumentLoader> {
  const { federation } = await import("./index");
  const context = federation.createContext(new Request(baseUrl), undefined);
  return context.documentLoader;
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
