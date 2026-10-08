import { backfill } from "@fedify/backfill";
import type { Context } from "@fedify/fedify";
import {
  Collection,
  CollectionPage,
  type DocumentLoader,
  Note,
} from "@fedify/vocab";
import { and, eq, isNull, lte, sql } from "drizzle-orm";

import db, { type DatabaseLike } from "../db";
import { FEDIFY_ORIGIN } from "../env";
import {
  posts,
  listPosts,
  timelinePosts,
  type RemoteReplyScrapeJob,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
} from "../schema";
import type { Uuid } from "../uuid";
import { iterateCollection } from "./collection";
import { isPost, persistPost, type ASPost } from "./post";
import {
  enqueueRemoteReplyScrape,
  isHttpIri,
  settleContextReplies,
  laterBySeconds,
  REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS,
  REMOTE_REPLIES_SCRAPE_DEPTH,
  REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS,
  REMOTE_REPLIES_SCRAPE_MAX_ITEMS,
  REMOTE_REPLIES_SCRAPE_MAX_REQUESTS,
} from "./replies";
import { canonicalizeContextJob } from "./replies-context";
import {
  createScrapeLoader,
  ScrapeDeferred,
  ScrapeRequestLimit,
} from "./replies-loader";
import {
  LostScrapeAttempt,
  lockScrapeAttempt,
  processingJobAttemptCondition,
} from "./replies-state";
import { appendPostToTimelines } from "./timeline";

export const STALE_PROCESSING_TIMEOUT_SECONDS = 15 * 60;

interface ScrapeProgress {
  fetchedItems: number;
  yieldedItems: number;
  requestCount: number;
  skippedItems: number;
  partial: boolean;
  errorMessage: string | null;
}

export interface ProcessRemoteReplyScrapeJobsOptions {
  signal?: AbortSignal;
  backoffSeconds?: number;
  clock?: () => Date;
  documentLoader?: DocumentLoader;
  intervalSeconds?: number;
  maxDepth?: number;
  maxItems?: number;
  maxRequests?: number;
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
    let yieldedItems = 0;
    let skippedItems = 0;
    let partial = false;
    const parents = new Set<Uuid>();
    const orphanHints = new Map<string, URL>();
    const verifiedParents = new Map<string, URL | null>();
    let defaultLoader: Promise<DocumentLoader> | undefined;
    const loader = createScrapeLoader({
      getJob: () => job,
      documentLoader:
        options.documentLoader ??
        ((url, loaderOptions) =>
          (defaultLoader ??= getDefaultDocumentLoader(ctx, job.baseUrl)).then(
            (load) => load(url, loaderOptions),
          )),
      contextLoader: ctx.contextLoader,
      maxRequests: options.maxRequests ?? REMOTE_REPLIES_SCRAPE_MAX_REQUESTS,
      intervalSeconds: Math.max(
        0,
        options.intervalSeconds ?? REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS,
      ),
      backoffSeconds: Math.max(
        0,
        options.backoffSeconds ?? REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS,
      ),
      clock,
      checkpoint,
      sleep: options.sleep ?? ((ms) => sleep(ms, options.signal)),
      signal: options.signal,
    });
    const progress = (): ScrapeProgress => ({
      fetchedItems,
      yieldedItems,
      skippedItems: skippedItems + loader.skippedItems,
      requestCount: loader.requestCount,
      partial: partial || loader.partial,
      errorMessage: loader.errorMessage,
    });
    const maxItems = options.maxItems ?? REMOTE_REPLIES_SCRAPE_MAX_ITEMS;
    const persistOptions = {
      documentLoader: loader.documentLoader,
      contextLoader: loader.contextLoader,
      objectLoader: loader.lookup,
      enqueueRemoteReplies: false,
      fetchEmojiReactions: false,
      skipUpdate: true,
      ...(job.kind === "context"
        ? { fetchReplyTarget: false }
        : { replyTarget: post }),
    };
    const authoritativePost = async (object: ASPost) => {
      const id = object.id;
      if (
        id == null ||
        !isHttpIri(id) ||
        id.origin === ctx.origin ||
        id.origin === new URL(job.baseUrl).origin ||
        id.origin === FEDIFY_ORIGIN?.webOrigin ||
        id.host === FEDIFY_ORIGIN?.handleHost
      )
        return null;
      const fetched = await loader.lookup(id);
      loader.check();
      if (
        !isPost(fetched) ||
        fetched.id?.href !== id.href ||
        fetched.attributionId == null ||
        fetched.attributionId.origin !== id.origin
      )
        return null;
      verifiedParents.set(id.href, fetched.replyTargetId);
      return fetched;
    };
    const persistItem = async (object: ASPost) => {
      await checkpoint();
      loader.check();
      const saved = await persistPost(db, object, job.baseUrl, {
        ...persistOptions,
        persistPrepared: async (write) => {
          loader.check();
          return await db.transaction(async (tx) => {
            await lockScrapeAttempt(tx, job);
            loader.check();
            const result = await write(tx);
            if (result?.replyTargetId != null)
              await updateScrapedRepliesCount(result.replyTargetId, tx);
            loader.check();
            return result;
          });
        },
      });
      if (saved?.replyTargetId != null) parents.add(saved.replyTargetId);
      await checkpoint();
      return saved;
    };
    // Relink only authoritative orphan metadata, after out-of-order parents
    // have arrived. Existing canonical relationships are never overwritten.
    const reconcile = async (localOnly = false) => {
      for (const [childIri, hintedParent] of orphanHints) {
        if (localOnly) await checkpoint();
        else loader.check();
        const parent = await db.query.posts.findFirst({
          where: { iri: { eq: hintedParent.href } },
        });
        if (parent == null) continue;
        if (localOnly && !verifiedParents.has(childIri)) continue;
        const parentIri = verifiedParents.has(childIri)
          ? verifiedParents.get(childIri)
          : (await authoritativePost(new Note({ id: new URL(childIri) })))
              ?.replyTargetId;
        if (parentIri == null || parentIri.href === childIri) continue;
        await db.transaction(async (tx) => {
          await lockScrapeAttempt(tx, job);
          if (localOnly) options.signal?.throwIfAborted();
          else loader.check();
          const actualParent = await tx.query.posts.findFirst({
            where: { iri: { eq: parentIri.href } },
          });
          const child = await tx.query.posts.findFirst({
            where: { iri: { eq: childIri } },
          });
          if (
            actualParent == null ||
            child == null ||
            child.replyTargetId != null ||
            actualParent.id === child.id
          )
            return;
          const ancestry = await tx.execute<{ id: string }>(sql`
            with recursive ancestors as (
              select id, reply_target_id from ${posts} where id = ${actualParent.id}
              union select p.id, p.reply_target_id from ${posts} p join ancestors a on p.id = a.reply_target_id
            ) select id from ancestors where id = ${child.id}
          `);
          if (ancestry.length > 0) return;
          await tx
            .update(posts)
            .set({ replyTargetId: actualParent.id })
            .where(and(eq(posts.id, child.id), isNull(posts.replyTargetId)));
          // The child may have entered inboxes as a root before its parent
          // arrived. Reapply the existing reply policies in the same transaction.
          const repaired = await tx.query.posts.findFirst({
            where: { id: { eq: child.id } },
            with: {
              mentions: true,
              sharing: { with: { mentions: true } },
              replyTarget: true,
            },
          });
          if (repaired != null) {
            await tx
              .delete(timelinePosts)
              .where(eq(timelinePosts.postId, child.id));
            await tx.delete(listPosts).where(eq(listPosts.postId, child.id));
            await appendPostToTimelines(tx, repaired);
          }
          await updateScrapedRepliesCount(actualParent.id, tx);
          parents.add(actualParent.id);
        });
      }
    };
    const pageTargets = new Set<string>();
    const inspectedCollections = new WeakSet<Collection>();
    const inspectPageReferences = async (collection: Collection) => {
      if (inspectedCollections.has(collection)) return;
      inspectedCollections.add(collection);
      // Expanded JSON-LD distinguishes embedded pages from URL references
      // without fetching pages ahead of traversal or logging fake failures.
      const namespace = "https://www.w3.org/ns/activitystreams#";
      const inspect = (value: unknown) => {
        if (Array.isArray(value)) {
          for (const entry of value) inspect(entry);
          return;
        }
        if (value == null || typeof value !== "object") return;
        const document = value as Record<string, unknown>;
        const types = document["@type"];
        const isPage =
          Array.isArray(types) &&
          (types.includes(`${namespace}CollectionPage`) ||
            types.includes(`${namespace}OrderedCollectionPage`));
        const references = [
          document[`${namespace}first`],
          ...(isPage ? [document[`${namespace}next`]] : []),
        ];
        for (const reference of references) {
          for (const target of Array.isArray(reference) ? reference : []) {
            if (target == null || typeof target !== "object") continue;
            const page = target as Record<string, unknown>;
            if (typeof page["@id"] === "string") pageTargets.add(page["@id"]);
            const pageTypes = page["@type"];
            if (!Array.isArray(pageTypes) || pageTypes.length === 0) continue;
            if (
              pageTypes.includes(`${namespace}CollectionPage`) ||
              pageTypes.includes(`${namespace}OrderedCollectionPage`)
            )
              inspect(page);
            else {
              partial = true;
              skippedItems++;
            }
          }
        }
      };
      inspect(await collection.toJsonLd({ format: "expand" }));
      loader.check();
    };
    const loadBackfillObject = async (iri: URL) => {
      const object = await loader.lookup(iri);
      if (pageTargets.has(iri.href) && !(object instanceof CollectionPage)) {
        partial = true;
        skippedItems++;
        return null;
      }
      if (object instanceof Collection) await inspectPageReferences(object);
      return object;
    };
    try {
      if (
        maxItems <= 0 ||
        (options.maxRequests ?? REMOTE_REPLIES_SCRAPE_MAX_REQUESTS) <= 0
      ) {
        partial = true;
      } else {
        const requested = new URL(job.repliesIri);
        const collection = await (job.kind === "context"
          ? loader.loadObject(requested)
          : loader.lookup(requested));
        if (!(collection instanceof Collection)) {
          throw new Error(
            `${job.kind === "context" ? "Context" : "Replies"} collection not found: ${job.repliesIri}`,
          );
        }
        if (job.kind === "context") {
          const finalUrl = await loader.documentUrl(requested);
          const canonical = collection.id ?? finalUrl;
          if (!isHttpIri(canonical) || canonical.origin !== finalUrl.origin)
            throw new Error("Unusable context collection identity");
          const promoted = await canonicalizeContextJob(
            job,
            canonical,
            finalUrl,
            clock(),
          );
          if (promoted == null) return 0;
          job = promoted;
          loader.cacheObject(collection, [requested, finalUrl, canonical]);
          await inspectPageReferences(collection);
        }
        const items =
          job.kind === "context"
            ? (async function* () {
                for await (const item of backfill(
                  { documentLoader: loadBackfillObject },
                  new Note({
                    // Include the stored seed in collection-based orphan repair.
                    contexts: [new URL(job.repliesIri)],
                  }),
                  {
                    strategies: ["context-auto"],
                    maxItems,
                    signal: loader.signal,
                  },
                ))
                  yield item.object;
              })()
            : iterateCollection(collection, {
                documentLoader: loader.documentLoader,
                contextLoader: loader.contextLoader,
              });
        for await (const candidate of items) {
          loader.check();
          await checkpoint();
          yieldedItems++;
          if (!isPost(candidate)) {
            partial = true;
            skippedItems++;
            continue;
          }
          let item: ASPost = candidate;
          if (job.kind === "context") {
            const existing =
              item.id == null
                ? null
                : await db.query.posts.findFirst({
                    where: { iri: { eq: item.id.href } },
                  });
            if (existing != null) {
              fetchedItems++;
              if (existing.replyTargetId == null && item.replyTargetId != null)
                orphanHints.set(existing.iri, item.replyTargetId);
              continue;
            }
            const trusted = await authoritativePost(item);
            if (trusted == null) {
              partial = true;
              skippedItems++;
              continue;
            }
            item = trusted;
          }
          let saved;
          try {
            saved = await persistItem(item);
          } catch (error) {
            loader.check();
            if (error instanceof LostScrapeAttempt || job.kind === "replies")
              throw error;
            // A malformed item must not prevent later conversation items.
            partial = true;
            skippedItems++;
            continue;
          }
          if (saved == null) {
            partial = true;
            skippedItems++;
            continue;
          }
          fetchedItems++;
          if (
            job.kind === "context" &&
            saved.replyTargetId == null &&
            item.replyTargetId != null
          )
            orphanHints.set(saved.iri, item.replyTargetId);
          if (job.kind === "replies") {
            if (
              item.repliesId != null &&
              job.depth + 1 < (options.maxDepth ?? REMOTE_REPLIES_SCRAPE_DEPTH)
            ) {
              await enqueueRemoteReplyScrape(db, {
                baseUrl: job.baseUrl,
                depth: job.depth + 1,
                post: saved,
                repliesIri: item.repliesId,
              });
            }
            if (fetchedItems >= maxItems) {
              partial = true;
              break;
            }
          }
        }
        loader.check();
        if (job.kind === "context" && yieldedItems >= maxItems) partial = true;
        await reconcile();
      }
      await checkpoint();
      await completeJob(job, progress(), clock());
      return fetchedItems;
    } catch (error) {
      if (lost != null || error instanceof LostScrapeAttempt) return 0;
      if (options.signal?.aborted || interrupted) {
        await interruptJob(job, clock(), progress());
        return 0;
      }
      try {
        await checkpoint();
      } catch (checkpointError) {
        if (lost != null || checkpointError instanceof LostScrapeAttempt)
          return 0;
        if (options.signal?.aborted || interrupted) {
          await interruptJob(job, clock(), progress());
          return 0;
        }
      }
      if (error instanceof ScrapeDeferred && error.host === job.originHost) {
        await backOffJob(
          job,
          Math.max(0, (+error.retryAt - +clock()) / 1000),
          error.cause ?? error,
          clock(),
          progress(),
        );
        return 0;
      }
      if (error instanceof ScrapeRequestLimit) {
        partial = true;
        // The loader is deliberately aborted at the cap. Repair only links
        // from metadata already verified in this attempt, without new I/O.
        try {
          await reconcile(true);
          await checkpoint();
        } catch (reconcileError) {
          if (lost != null || reconcileError instanceof LostScrapeAttempt)
            return 0;
          if (options.signal?.aborted || interrupted) {
            await interruptJob(job, clock(), progress());
            return 0;
          }
          throw reconcileError;
        }
        await completeJob(job, progress(), clock());
        return fetchedItems;
      }
      await failJob(
        job,
        error instanceof Error ? error.message : String(error),
        clock(),
        progress(),
      );
      return 0;
    } finally {
      // These counts derive solely from committed rows, so a lost lease must
      // not strand counts for children this attempt already committed.
      parents.add(job.postId);
      for (const parentId of parents) await updateScrapedRepliesCount(parentId);
    }
  } finally {
    clearInterval(timer);
    await refreshing;
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
  database: DatabaseLike = db,
) {
  await database.execute(sql`
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
  progress: ScrapeProgress,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updatedJob] = await tx
      .update(remoteReplyScrapeJobs)
      .set({
        status: "completed",
        nextDispatchAt: now,
        ...progress,
        completedAt: now,
        updated: now,
      })
      .where(processingJobAttemptCondition(job))
      .returning();
    if (updatedJob == null) {
      await releaseOriginLeaseIfJobDeleted(tx, job, now);
      return;
    }

    if (updatedJob.kind === "context")
      await settleContextReplies(tx, updatedJob, now);

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
  progress?: ScrapeProgress,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updatedJob] = await tx
      .update(remoteReplyScrapeJobs)
      .set({
        ...progress,
        status: "failed",
        nextDispatchAt: now,
        errorMessage:
          job.kind === "context" && progress?.errorMessage
            ? `${message}; ${progress.errorMessage}`
            : message,
        completedAt: now,
        updated: now,
      })
      .where(processingJobAttemptCondition(job))
      .returning();
    if (updatedJob == null) {
      await releaseOriginLeaseIfJobDeleted(tx, job, now);
      return;
    }

    if (updatedJob.kind === "context")
      await settleContextReplies(tx, updatedJob, now);

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
  progress?: ScrapeProgress,
): Promise<void> {
  const nextAttemptAt = laterBySeconds(seconds, now);
  await db.transaction(async (tx) => {
    const [updatedJob] = await tx
      .update(remoteReplyScrapeJobs)
      .set({
        ...progress,
        status: "pending",
        nextDispatchAt: now,
        nextAttemptAt,
        errorMessage:
          job.kind === "context" && progress?.errorMessage
            ? progress.errorMessage
            : error instanceof Error
              ? error.message
              : String(error),
        startedAt: null,
        completedAt: null,
        updated: now,
      })
      .where(processingJobAttemptCondition(job))
      .returning();
    if (updatedJob == null) {
      await releaseOriginLeaseIfJobDeleted(tx, job, now);
      return;
    }

    if (updatedJob.kind === "context")
      await settleContextReplies(tx, updatedJob, now);

    await tx
      .update(remoteReplyScrapeOrigins)
      .set({
        nextRequestAt: sql`greatest(${remoteReplyScrapeOrigins.nextRequestAt}, ${nextAttemptAt.toISOString()}::timestamptz)`,
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

async function interruptJob(
  job: RemoteReplyScrapeJob,
  now: Date,
  progress?: ScrapeProgress,
) {
  await db.transaction(async (tx) => {
    const [owned] = await tx
      .update(remoteReplyScrapeJobs)
      .set({
        ...progress,
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
