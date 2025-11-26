import { getLogger } from "@logtape/logtape";
import { and, eq, inArray, sql } from "drizzle-orm";
import db, { type Transaction } from "../db";
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
    // Use a transaction with FOR UPDATE SKIP LOCKED to prevent
    // multiple workers from processing the same job
    await db.transaction(async (tx) => {
      // Find pending jobs and start them (only process one job at a time)
      const [pendingJob] = await tx
        .select()
        .from(schema.importJobs)
        .where(eq(schema.importJobs.status, "pending"))
        .orderBy(schema.importJobs.created)
        .limit(1)
        .for("update", { skipLocked: true });

      if (pendingJob) {
        await startJob(tx, pendingJob);
        return; // Process one job per poll cycle
      }

      // Continue processing jobs that are already "processing"
      const [processingJob] = await tx
        .select()
        .from(schema.importJobs)
        .where(eq(schema.importJobs.status, "processing"))
        .limit(1)
        .for("update", { skipLocked: true });

      if (processingJob) {
        await processJobItems(tx, processingJob);
      }
    });
  } catch (error) {
    logger.error("Error in import worker poll: {error}", { error });
  }
}

async function startJob(tx: Transaction, job: schema.ImportJob): Promise<void> {
  logger.info("Starting import job {jobId} for category {category}", {
    jobId: job.id,
    category: job.category,
  });

  await tx
    .update(schema.importJobs)
    .set({
      status: "processing",
      startedAt: new Date(),
    })
    .where(eq(schema.importJobs.id, job.id));

  await processJobItems(tx, {
    ...job,
    status: "processing",
    startedAt: new Date(),
  });
}

async function processJobItems(
  tx: Transaction,
  job: schema.ImportJob,
): Promise<void> {
  // Check if job has been cancelled (use tx to see latest state within transaction)
  const [currentJob] = await tx
    .select()
    .from(schema.importJobs)
    .where(eq(schema.importJobs.id, job.id));

  if (!currentJob || currentJob.status === "cancelled") {
    logger.info("Import job {jobId} was cancelled", { jobId: job.id });
    await finalizeJob(tx, job, "cancelled");
    return;
  }

  // Get pending items for this job with lock
  const pendingItems = await tx
    .select()
    .from(schema.importJobItems)
    .where(
      and(
        eq(schema.importJobItems.jobId, job.id),
        eq(schema.importJobItems.status, "pending"),
      ),
    )
    .limit(BATCH_SIZE)
    .for("update", { skipLocked: true });

  if (pendingItems.length === 0) {
    // No more items - mark job as completed
    await finalizeJob(tx, job, "completed");
    return;
  }

  // Get account owner for this job
  const accountOwner = await tx.query.accountOwners.findFirst({
    where: eq(schema.accountOwners.id, job.accountOwnerId),
    with: { account: true },
  });

  if (!accountOwner) {
    logger.error("Account owner not found for job {jobId}", { jobId: job.id });
    await tx
      .update(schema.importJobs)
      .set({
        status: "failed",
        errorMessage: "Account owner not found",
        completedAt: new Date(),
      })
      .where(eq(schema.importJobs.id, job.id));
    return;
  }

  // Mark items as processing within the transaction
  const itemsToProcess = pendingItems.slice(0, CONCURRENT_ITEMS);
  const itemIds = itemsToProcess.map((item) => item.id);

  await tx
    .update(schema.importJobItems)
    .set({ status: "processing" })
    .where(
      and(
        eq(schema.importJobItems.jobId, job.id),
        inArray(schema.importJobItems.id, itemIds),
      ),
    );

  // Update processed count within transaction
  await tx
    .update(schema.importJobs)
    .set({
      processedItems: sql`${schema.importJobs.processedItems} + ${itemsToProcess.length}`,
    })
    .where(eq(schema.importJobs.id, job.id));

  // Process items outside the transaction (federation calls are external)
  // We schedule this to run after the transaction commits
  setTimeout(() => {
    Promise.allSettled(
      itemsToProcess.map((item) => processItem(job, item, accountOwner)),
    ).catch((error) => {
      logger.error("Error processing import items: {error}", { error });
    });
  }, 0);
}

async function finalizeJob(
  tx: Transaction,
  job: schema.ImportJob,
  status: "completed" | "cancelled" | "failed",
): Promise<void> {
  const [stats] = await tx
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

  await tx
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
  // Item is already marked as "processing" in the transaction
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
