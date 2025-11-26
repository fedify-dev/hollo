import { getLogger } from "@logtape/logtape";
import { and, eq, sql } from "drizzle-orm";
import db from "../db";
import federation from "../federation/federation";
import * as schema from "../schema";
import {
  processBlockItem,
  processBookmarkItem,
  processFollowItem,
  processListItem,
  processMuteItem,
} from "./processors";

const logger = getLogger(["hollo", "import-worker"]);

// Configuration constants
const POLL_INTERVAL_MS = 5000; // Check for jobs every 5 seconds
const BATCH_SIZE = 10; // Items to fetch per poll
const CONCURRENT_ITEMS = 5; // Max parallel item processing

let isRunning = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startImportWorker(): void {
  if (isRunning) {
    logger.warn("Import worker is already running");
    return;
  }

  isRunning = true;
  logger.info("Starting import worker");

  // Initial poll
  pollAndProcess().catch((error) => {
    logger.error("Error in initial import worker poll: {error}", { error });
  });

  // Set up periodic polling
  pollTimer = setInterval(() => {
    pollAndProcess().catch((error) => {
      logger.error("Error in import worker poll: {error}", { error });
    });
  }, POLL_INTERVAL_MS);
}

export function stopImportWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
  logger.info("Import worker stopped");
}

async function pollAndProcess(): Promise<void> {
  try {
    // Find pending jobs and start them (only process one job at a time)
    const pendingJob = await db.query.importJobs.findFirst({
      where: eq(schema.importJobs.status, "pending"),
      orderBy: schema.importJobs.created,
    });

    if (pendingJob) {
      await startJob(pendingJob);
      return; // Process one job per poll cycle
    }

    // Continue processing jobs that are already "processing"
    const processingJob = await db.query.importJobs.findFirst({
      where: eq(schema.importJobs.status, "processing"),
    });

    if (processingJob) {
      await processJobItems(processingJob);
    }
  } catch (error) {
    logger.error("Error in import worker poll: {error}", { error });
  }
}

async function startJob(job: schema.ImportJob): Promise<void> {
  logger.info("Starting import job {jobId} for category {category}", {
    jobId: job.id,
    category: job.category,
  });

  await db
    .update(schema.importJobs)
    .set({
      status: "processing",
      startedAt: new Date(),
    })
    .where(eq(schema.importJobs.id, job.id));

  await processJobItems({
    ...job,
    status: "processing",
    startedAt: new Date(),
  });
}

async function processJobItems(job: schema.ImportJob): Promise<void> {
  // Check if job has been cancelled
  const currentJob = await db.query.importJobs.findFirst({
    where: eq(schema.importJobs.id, job.id),
  });

  if (!currentJob || currentJob.status === "cancelled") {
    logger.info("Import job {jobId} was cancelled", { jobId: job.id });
    await finalizeJob(job, "cancelled");
    return;
  }

  // Get pending items for this job
  const pendingItems = await db.query.importJobItems.findMany({
    where: and(
      eq(schema.importJobItems.jobId, job.id),
      eq(schema.importJobItems.status, "pending"),
    ),
    limit: BATCH_SIZE,
  });

  if (pendingItems.length === 0) {
    // No more items - mark job as completed
    await finalizeJob(job, "completed");
    return;
  }

  // Get account owner for this job
  const accountOwner = await db.query.accountOwners.findFirst({
    where: eq(schema.accountOwners.id, job.accountOwnerId),
    with: { account: true },
  });

  if (!accountOwner) {
    logger.error("Account owner not found for job {jobId}", { jobId: job.id });
    await db
      .update(schema.importJobs)
      .set({
        status: "failed",
        errorMessage: "Account owner not found",
        completedAt: new Date(),
      })
      .where(eq(schema.importJobs.id, job.id));
    return;
  }

  // Process items with limited concurrency
  const itemsToProcess = pendingItems.slice(0, CONCURRENT_ITEMS);

  await Promise.allSettled(
    itemsToProcess.map((item) => processItem(job, item, accountOwner)),
  );

  // Update processed count
  await db
    .update(schema.importJobs)
    .set({
      processedItems: sql`${schema.importJobs.processedItems} + ${itemsToProcess.length}`,
    })
    .where(eq(schema.importJobs.id, job.id));
}

async function finalizeJob(
  job: schema.ImportJob,
  status: "completed" | "cancelled" | "failed",
): Promise<void> {
  const [stats] = await db
    .select({
      successful:
        sql<number>`COUNT(*) FILTER (WHERE status = 'completed')`.mapWith(
          Number,
        ),
      failed: sql<number>`COUNT(*) FILTER (WHERE status = 'failed')`.mapWith(
        Number,
      ),
    })
    .from(schema.importJobItems)
    .where(eq(schema.importJobItems.jobId, job.id));

  await db
    .update(schema.importJobs)
    .set({
      status,
      completedAt: new Date(),
      successfulItems: stats.successful,
      failedItems: stats.failed,
    })
    .where(eq(schema.importJobs.id, job.id));

  logger.info(
    "Import job {jobId} {status}: {successful} successful, {failed} failed",
    {
      jobId: job.id,
      status,
      successful: stats.successful,
      failed: stats.failed,
    },
  );
}

async function processItem(
  job: schema.ImportJob,
  item: schema.ImportJobItem,
  accountOwner: schema.AccountOwner & { account: schema.Account },
): Promise<void> {
  // Mark as processing
  await db
    .update(schema.importJobItems)
    .set({ status: "processing" })
    .where(eq(schema.importJobItems.id, item.id));

  try {
    // Create a mock request to get federation context
    // We need the origin from the account's IRI
    const origin = new URL(accountOwner.account.iri).origin;
    const mockRequest = new Request(origin);
    const fedCtx = federation.createContext(mockRequest, undefined);

    const documentLoader = await fedCtx.getDocumentLoader({
      username: accountOwner.handle,
    });

    switch (job.category) {
      case "following_accounts":
        await processFollowItem(item, accountOwner, fedCtx, documentLoader);
        break;
      case "muted_accounts":
        await processMuteItem(item, accountOwner, fedCtx, documentLoader);
        break;
      case "blocked_accounts":
        await processBlockItem(item, accountOwner, fedCtx, documentLoader);
        break;
      case "bookmarks":
        await processBookmarkItem(item, accountOwner, fedCtx, documentLoader);
        break;
      case "lists":
        await processListItem(item, accountOwner, fedCtx, documentLoader);
        break;
    }

    await db
      .update(schema.importJobItems)
      .set({
        status: "completed",
        processedAt: new Date(),
      })
      .where(eq(schema.importJobItems.id, item.id));

    // Update successful count
    await db
      .update(schema.importJobs)
      .set({
        successfulItems: sql`${schema.importJobs.successfulItems} + 1`,
      })
      .where(eq(schema.importJobs.id, job.id));
  } catch (error) {
    logger.error("Failed to process import item {itemId}: {error}", {
      itemId: item.id,
      error,
    });

    await db
      .update(schema.importJobItems)
      .set({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        processedAt: new Date(),
      })
      .where(eq(schema.importJobItems.id, item.id));

    // Update failed count
    await db
      .update(schema.importJobs)
      .set({
        failedItems: sql`${schema.importJobs.failedItems} + 1`,
      })
      .where(eq(schema.importJobs.id, job.id));
  }
}
