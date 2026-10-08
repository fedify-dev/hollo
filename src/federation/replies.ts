import { getLogger } from "@logtape/logtape";
import { and, count, eq, inArray, sql } from "drizzle-orm";

import database, { type DatabaseLike, type Transaction } from "../db";
import {
  remoteContextScrapeAliases,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
  type Post,
  type RemoteReplyScrapeJob,
} from "../schema";
import { uuidv7 } from "../uuid";

export const REMOTE_REPLIES_SCRAPE_DEPTH = parseNonNegativeInteger(
  "REMOTE_REPLIES_SCRAPE_DEPTH",
  2,
);
export const REMOTE_REPLIES_SCRAPE_MAX_ITEMS = parsePositiveInteger(
  "REMOTE_REPLIES_SCRAPE_MAX_ITEMS",
  100,
);
export const REMOTE_REPLIES_SCRAPE_MAX_REQUESTS = parsePositiveInteger(
  "REMOTE_REPLIES_SCRAPE_MAX_REQUESTS",
  200,
);
export const REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS = parsePositiveInteger(
  "REMOTE_REPLIES_SCRAPE_INTERVAL_SECONDS",
  5,
);
export const REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS = parsePositiveInteger(
  "REMOTE_REPLIES_SCRAPE_BACKOFF_SECONDS",
  300,
);
export const REMOTE_REPLIES_SCRAPE_COOLDOWN_SECONDS = parseNonNegativeInteger(
  "REMOTE_REPLIES_SCRAPE_COOLDOWN_SECONDS",
  300,
);

type Database = DatabaseLike;

/** Serialize collection identity changes, never remote I/O. */
export async function lockContextScrapeIdentity(tx: Transaction) {
  await tx.execute(sql`select pg_advisory_xact_lock(1213156428, 1129270868)`);
}

export function isHttpIri(iri: URL): boolean {
  return iri.protocol === "https:" || iri.protocol === "http:";
}

export async function enqueueRemoteReplyScrape(
  db: Database,
  {
    baseUrl,
    depth = 0,
    post,
    repliesIri,
    contextIri,
  }: {
    baseUrl: URL | string;
    depth?: number;
    post: Post;
    repliesIri?: URL | null;
    contextIri?: URL | null;
  },
): Promise<void> {
  if (REMOTE_REPLIES_SCRAPE_DEPTH < 1 || depth >= REMOTE_REPLIES_SCRAPE_DEPTH)
    return;
  const context =
    contextIri != null && isHttpIri(contextIri) ? contextIri : null;
  const replies =
    repliesIri != null && isHttpIri(repliesIri) ? repliesIri : null;
  if (context == null && replies == null) return;
  const now = new Date();
  const baseUrlString = new URL(baseUrl).origin;
  const cutoff = laterBySeconds(-REMOTE_REPLIES_SCRAPE_COOLDOWN_SECONDS, now);
  const dispatchIds = await db.transaction(async (tx) => {
    const ids: RemoteReplyScrapeJob["id"][] = [];
    let blocker: RemoteReplyScrapeJob | undefined;
    if (context != null) {
      await lockContextScrapeIdentity(tx);
      const alias = await tx.query.remoteContextScrapeAliases.findFirst({
        where: { iri: { eq: context.href } },
      });
      const [existing] = await tx
        .select()
        .from(remoteReplyScrapeJobs)
        .where(
          alias == null
            ? and(
                eq(remoteReplyScrapeJobs.kind, "context"),
                eq(remoteReplyScrapeJobs.repliesIri, context.href),
              )
            : eq(remoteReplyScrapeJobs.id, alias.jobId),
        )
        .for("update");
      blocker = await createOrResetJob(tx, existing, {
        post,
        iri: context,
        baseUrl: baseUrlString,
        depth: 0,
        kind: "context",
        now,
        cutoff,
      });
      await tx
        .insert(remoteContextScrapeAliases)
        .values({ iri: context.href, jobId: blocker.id })
        .onConflictDoUpdate({
          target: remoteContextScrapeAliases.iri,
          set: { jobId: blocker.id },
        });
      if (blocker.status === "pending") ids.push(blocker.id);
      if (blocker.status === "completed" && !blocker.partial) return ids;
    }
    if (replies != null) {
      const [existing] = await tx
        .select()
        .from(remoteReplyScrapeJobs)
        .where(
          and(
            eq(remoteReplyScrapeJobs.kind, "replies"),
            eq(remoteReplyScrapeJobs.repliesIri, replies.href),
          ),
        )
        .for("update");
      if (existing != null && isActiveOrCoolingDown(existing, cutoff))
        return ids;
      const waiting =
        blocker?.status === "pending" || blocker?.status === "processing";
      const job = await createOrResetJob(tx, existing, {
        post,
        iri: replies,
        baseUrl: baseUrlString,
        depth,
        kind: "replies",
        now,
        cutoff,
        blockedByJobId: waiting ? blocker!.id : null,
      });
      if (job.status === "pending") ids.push(job.id);
    }
    return ids;
  });
  // Transaction handles only create durable rows; recovery dispatches after
  // their outer transaction commits.
  if (db === database) {
    for (const jobId of dispatchIds) {
      try {
        const { federation, replyScrapes } = await import("./federation");
        await replyScrapes.enqueue(
          federation.createContext(new URL(baseUrlString), undefined),
          jobId,
        );
      } catch (error) {
        getLogger(["hollo", "federation", "replies-worker"]).error(
          "Scrape {jobId} committed but dispatch failed; recovery will retry: {error}",
          { jobId, error },
        );
      }
    }
  }
}

async function createOrResetJob(
  tx: Transaction,
  existing: RemoteReplyScrapeJob | undefined,
  options: {
    post: Post;
    iri: URL;
    baseUrl: string;
    depth: number;
    kind: "context" | "replies";
    now: Date;
    cutoff: Date;
    blockedByJobId?: RemoteReplyScrapeJob["id"] | null;
  },
): Promise<RemoteReplyScrapeJob> {
  if (existing != null && isActiveOrCoolingDown(existing, options.cutoff))
    return existing;
  const iri =
    existing?.kind === "context" ? new URL(existing.repliesIri) : options.iri;
  await tx
    .insert(remoteReplyScrapeOrigins)
    .values({ originHost: iri.host })
    .onConflictDoNothing();
  const values = {
    postId: options.post.id,
    postIri: options.post.iri,
    repliesIri: iri.href,
    kind: options.kind,
    baseUrl: options.baseUrl,
    originHost: iri.host,
    depth: options.depth,
    status:
      options.blockedByJobId != null
        ? ("waiting" as const)
        : ("pending" as const),
    blockedByJobId: options.blockedByJobId ?? null,
    attempts: 0,
    fetchedItems: 0,
    yieldedItems: 0,
    requestCount: 0,
    skippedItems: 0,
    partial: false,
    hostRequeues: 0,
    nextAttemptAt: options.now,
    nextDispatchAt: options.now,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    updated: options.now,
  };
  if (existing != null) {
    const [job] = await tx
      .update(remoteReplyScrapeJobs)
      .set(values)
      .where(eq(remoteReplyScrapeJobs.id, existing.id))
      .returning();
    return job;
  }
  const [created] = await tx
    .insert(remoteReplyScrapeJobs)
    .values({ ...values, id: uuidv7(), created: options.now })
    .onConflictDoNothing({
      target: [remoteReplyScrapeJobs.kind, remoteReplyScrapeJobs.repliesIri],
    })
    .returning();
  if (created != null) return created;
  const [concurrent] = await tx
    .select()
    .from(remoteReplyScrapeJobs)
    .where(
      and(
        eq(remoteReplyScrapeJobs.kind, options.kind),
        eq(remoteReplyScrapeJobs.repliesIri, iri.href),
      ),
    )
    .for("update");
  return concurrent;
}

/** Called only after locking/updating the context blocker. */
export async function settleContextReplies(
  tx: Transaction,
  blocker: RemoteReplyScrapeJob,
  now: Date,
) {
  if (blocker.status !== "completed" && blocker.status !== "failed") return;
  const covered = blocker.status === "completed" && !blocker.partial;
  await tx
    .update(remoteReplyScrapeJobs)
    .set({
      status: covered ? "completed" : "pending",
      blockedByJobId: null,
      nextDispatchAt: now,
      completedAt: covered ? now : null,
      errorMessage: covered ? "Covered by context collection" : null,
      updated: now,
    })
    .where(
      and(
        eq(remoteReplyScrapeJobs.status, "waiting"),
        eq(remoteReplyScrapeJobs.blockedByJobId, blocker.id),
      ),
    );
}

export async function countActiveRemoteReplyScrapeJobs(
  db: Database,
  repliesIri: URL,
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(remoteReplyScrapeJobs)
    .where(
      and(
        eq(remoteReplyScrapeJobs.repliesIri, repliesIri.href),
        eq(remoteReplyScrapeJobs.kind, "replies"),
        inArray(remoteReplyScrapeJobs.status, [
          "pending",
          "processing",
          "waiting",
        ]),
      ),
    );
  return row?.count ?? 0;
}

export function isActiveOrCoolingDown(
  job: RemoteReplyScrapeJob,
  cooldownStartedAt: Date,
): boolean {
  return (
    job.status === "pending" ||
    job.status === "processing" ||
    job.status === "waiting" ||
    ((job.status === "completed" ||
      (job.kind === "context" && job.status === "failed")) &&
      job.completedAt != null &&
      job.completedAt > cooldownStartedAt)
  );
}

function parsePositiveInteger(name: string, fallback: number): number {
  const value = parseInteger(name, fallback);
  return value < 1 ? fallback : value;
}

function parseNonNegativeInteger(name: string, fallback: number): number {
  const value = parseInteger(name, fallback);
  return value < 0 ? fallback : value;
}

function parseInteger(name: string, fallback: number): number {
  // oxlint-disable-next-line typescript/dot-notation
  const envValue = process.env[name];
  if (envValue == null || envValue.trim() === "") return fallback;
  const value = Number.parseInt(envValue, 10);
  return Number.isInteger(value) ? value : fallback;
}

export function laterBySeconds(seconds: number, from = new Date()): Date {
  return new Date(from.getTime() + seconds * 1000);
}
