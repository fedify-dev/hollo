import { getLogger } from "@logtape/logtape";
import { and, count, eq, inArray } from "drizzle-orm";

import database, { type DatabaseLike } from "../db";
import {
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

export async function enqueueRemoteReplyScrape(
  db: Database,
  {
    baseUrl,
    depth = 0,
    post,
    repliesIri,
  }: {
    baseUrl: URL | string;
    depth?: number;
    post: Post;
    repliesIri: URL;
  },
): Promise<void> {
  if (REMOTE_REPLIES_SCRAPE_DEPTH < 1) return;
  if (depth >= REMOTE_REPLIES_SCRAPE_DEPTH) return;

  const now = new Date();
  const originHost = repliesIri.host;
  const baseUrlString =
    typeof baseUrl === "string" ? new URL(baseUrl).origin : baseUrl.origin;
  const cooldownStartedAt = new Date(
    now.getTime() - REMOTE_REPLIES_SCRAPE_COOLDOWN_SECONDS * 1000,
  );

  const jobId = await db.transaction(async (tx) => {
    await tx
      .insert(remoteReplyScrapeOrigins)
      .values({
        originHost,
      })
      .onConflictDoNothing();

    // Lock an existing generation before resetting an expired cooldown.
    const [existingJob] = await tx
      .select()
      .from(remoteReplyScrapeJobs)
      .where(eq(remoteReplyScrapeJobs.repliesIri, repliesIri.href))
      .for("update");

    if (
      existingJob != null &&
      isActiveOrCoolingDown(existingJob, cooldownStartedAt)
    ) {
      return;
    }

    const values = {
      postId: post.id,
      postIri: post.iri,
      repliesIri: repliesIri.href,
      baseUrl: baseUrlString,
      originHost,
      depth,
      status: "pending" as const,
      attempts: 0,
      fetchedItems: 0,
      nextAttemptAt: now,
      nextDispatchAt: now,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      updated: now,
    };

    if (existingJob != null) {
      await tx
        .update(remoteReplyScrapeJobs)
        .set(values)
        .where(eq(remoteReplyScrapeJobs.id, existingJob.id));
      return existingJob.id;
    }
    const [created] = await tx
      .insert(remoteReplyScrapeJobs)
      .values({ ...values, id: uuidv7(), created: now })
      .onConflictDoNothing({ target: remoteReplyScrapeJobs.repliesIri })
      .returning({ id: remoteReplyScrapeJobs.id });
    return created?.id;
  });

  // A nested transaction is only a savepoint.  Its caller may still roll
  // back, so only the application's root handle may dispatch immediately.
  // Committed rows created through other handles are picked up by recovery.
  if (jobId != null && db === database) {
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
        inArray(remoteReplyScrapeJobs.status, ["pending", "processing"]),
      ),
    );
  return row?.count ?? 0;
}

function isActiveOrCoolingDown(
  job: RemoteReplyScrapeJob,
  cooldownStartedAt: Date,
): boolean {
  return (
    job.status === "pending" ||
    job.status === "processing" ||
    (job.status === "completed" &&
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
