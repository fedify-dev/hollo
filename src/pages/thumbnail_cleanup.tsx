import { getLogger } from "@logtape/logtape";
import { and, count, eq, ilike, inArray, not, notExists } from "drizzle-orm";
import { Hono } from "hono";

import { DashboardLayout } from "../components/DashboardLayout";
import db from "../db";
import { getMediaWithDeletableThumbnails } from "../entities/medium";
import { loginRequired } from "../login";
import {
  accountOwners,
  accounts,
  cleanupJobItems,
  cleanupJobs,
  media,
  posts,
} from "../schema";
import { STORAGE_URL_BASE } from "../storage-config";
import { isUuid, uuidv7 } from "../uuid";

const logger = getLogger(["hollo", "pages", "thumbnail_cleanup"]);

const data = new Hono();

data.use(loginRequired);

data.get("/", async (c) => {
  const done = c.req.query("done");
  const error = c.req.query("error");
  const before = c.req.query("before");
  const fileCount = Number(c.req.query("fileCount") ?? "0");
  const firstFile = c.req.query("firstFile");
  const lastFile = c.req.query("lastFile");
  const cleanupDataResult = c.req.query("cleanup-data-result");

  const suggestedCleanupCutoff =
    typeof before === "string"
      ? before
      : new Date(new Date().getFullYear() - 1, 0, 1)
          .toISOString()
          .split("T")[0];

  // Check for active cleanup job (from query param or database)
  const cleanupJobId = c.req.query("cleanup-job");
  const activeJob =
    cleanupJobId && isUuid(cleanupJobId)
      ? await db.query.cleanupJobs.findFirst({
          where: and(eq(cleanupJobs.id, cleanupJobId)),
        })
      : await db.query.cleanupJobs.findFirst({
          where: and(
            inArray(cleanupJobs.status, ["pending", "processing"]),
            inArray(cleanupJobs.category, ["cleanup_thumbnails"]),
          ),
          orderBy: (cleanupJobs, { desc }) => [desc(cleanupJobs.created)],
        });

  // Check if we need to auto-refresh (job in progress)
  const shouldAutoRefresh =
    activeJob?.status === "pending" || activeJob?.status === "processing";

  // compute statistics table
  let remoteThumbnailsCountResult: { count: number }[];
  try {
    remoteThumbnailsCountResult = await db
      .select({
        count: count(),
      })
      .from(media)
      .innerJoin(posts, eq(media.postId, posts.id))
      .innerJoin(accounts, eq(posts.accountId, accounts.id))
      .where(
        and(
          not(media.thumbnailCleaned),
          ilike(media.thumbnailUrl, `${STORAGE_URL_BASE}%`),
          notExists(
            db
              .select()
              .from(accountOwners)
              .where(eq(accounts.id, accountOwners.id)),
          ),
        ),
      );
  } catch {
    remoteThumbnailsCountResult = [{ count: 0 }];
  }
  const thumbnailsRemoteCount = remoteThumbnailsCountResult[0].count;

  let thumbnailsCountResult: { count: number }[];
  try {
    thumbnailsCountResult = await db
      .select({
        count: count(),
      })
      .from(media)
      .where(
        and(
          not(media.thumbnailCleaned),
          ilike(media.thumbnailUrl, `${STORAGE_URL_BASE}%`),
        ),
      );
  } catch {
    thumbnailsCountResult = [{ count: 0 }];
  }
  const thumbnailsCount = thumbnailsCountResult[0].count;

  const thumbnailsTable: { caption: string; count: number }[] = [
    {
      caption: "Total, thumbnail hosted locally",
      count: thumbnailsCount,
    },
    {
      caption: "Remote, thumbnail hosted locally",
      count: thumbnailsRemoteCount,
    },
  ];

  const dateInputClass =
    "rounded-md border bg-white px-3 py-2 text-sm shadow-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-brand-900";
  const primaryButtonClass =
    "rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-brand-700 dark:hover:bg-brand-800";
  const secondaryButtonClass =
    "rounded-md border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";
  return c.html(
    <DashboardLayout
      title="Hollo: Thumbnail Cleanup"
      selectedMenu="thumbnail_cleanup"
    >
      <header class="mb-6">
        <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Thumbnail cleanup
        </h1>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Free up storage by deleting old thumbnails for remote posts.
        </p>
      </header>

      <div class="space-y-6">
        <section class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
          <header class="mb-4">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Thumbnail statistics
            </h2>
            <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              An overview of thumbnails tracked by Hollo.
            </p>
          </header>
          <div class="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table class="w-full text-sm">
              <thead class="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
                <tr>
                  <th class="px-3 py-2 text-left font-semibold">Type</th>
                  <th class="px-3 py-2 text-right font-semibold">Thumbnails</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-900">
                {thumbnailsTable.map((entry) => (
                  <tr>
                    <td class="px-3 py-2 text-neutral-800 dark:text-neutral-200">
                      {entry.caption}
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums text-neutral-700 dark:text-neutral-300">
                      {entry.count.toLocaleString("en")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section
          id="cleanup-preview"
          class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <header class="mb-4">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Preview cleanup
            </h2>
            <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {done === "clean_preview"
                ? "Preview ready."
                : "Preview which thumbnails would be deleted."}
            </p>
          </header>
          <form
            method="post"
            action="/thumbnail_cleanup/clean_preview"
            onsubmit="this.submit.ariaBusy = 'true'"
          >
            <div class="flex gap-2">
              <input
                type="date"
                name="before"
                value={suggestedCleanupCutoff}
                required
                aria-invalid={error === "clean" ? "true" : undefined}
                class={`${dateInputClass} flex-1 ${
                  error === "clean_preview"
                    ? "border-red-500"
                    : "border-neutral-300 dark:border-neutral-700"
                }`}
              />
              <button name="submit" type="submit" class={primaryButtonClass}>
                Preview
              </button>
            </div>
            <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              {error === "clean_preview"
                ? "Something went wrong while previewing the cleanup."
                : "Cutoff date — thumbnails older than this will be deleted."}
            </p>
          </form>
          {done === "clean_preview" &&
            (fileCount > 0 ? (
              <dl class="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    Items
                  </dt>
                  <dd class="mt-1 font-semibold text-neutral-900 dark:text-neutral-100">
                    {fileCount.toLocaleString("en")}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    First
                  </dt>
                  <dd class="mt-1 text-neutral-700 dark:text-neutral-300">
                    {firstFile}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                    Last
                  </dt>
                  <dd class="mt-1 text-neutral-700 dark:text-neutral-300">
                    {lastFile}
                  </dd>
                </div>
              </dl>
            ) : (
              <p class="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
                No thumbnails to clean.
              </p>
            ))}
        </section>

        {activeJob && (
          <section
            id="cleanup-progress"
            class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {activeJob.status === "pending"
                  ? "Cleanup queued"
                  : activeJob.status === "processing"
                    ? "Cleanup in progress"
                    : activeJob.status === "completed"
                      ? "Cleanup completed"
                      : activeJob.status === "cancelled"
                        ? "Cleanup cancelled"
                        : "Cleanup failed"}
              </h2>
              <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {activeJob.status === "pending" && "Waiting to start."}
                {activeJob.status === "processing" && "Processing..."}
              </p>
            </header>

            <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div
                class="h-full bg-brand-600 transition-all"
                style={`width: ${
                  activeJob.totalItems > 0
                    ? Math.round(
                        (activeJob.processedItems / activeJob.totalItems) * 100,
                      )
                    : 0
                }%`}
              />
            </div>

            <p class="mt-3 text-sm text-neutral-700 dark:text-neutral-300">
              <strong class="font-semibold text-neutral-900 dark:text-neutral-100">
                {activeJob.processedItems.toLocaleString("en-US")}
              </strong>{" "}
              / {activeJob.totalItems.toLocaleString("en-US")} items processed
              {activeJob.processedItems > 0 && (
                <>
                  {" "}
                  (
                  <strong class="font-semibold text-green-700 dark:text-green-400">
                    {activeJob.successfulItems.toLocaleString("en-US")}
                  </strong>{" "}
                  successful
                  {activeJob.failedItems > 0 && (
                    <>
                      ,{" "}
                      <strong class="font-semibold text-red-700 dark:text-red-400">
                        {activeJob.failedItems.toLocaleString("en-US")}
                      </strong>{" "}
                      failed
                    </>
                  )}
                  )
                </>
              )}
            </p>

            {shouldAutoRefresh && (
              <>
                <form
                  method="post"
                  action={`/thumbnail_cleanup/clean/${activeJob.id}/cancel`}
                  class="mt-4"
                >
                  <button type="submit" class={secondaryButtonClass}>
                    Cancel cleanup
                  </button>
                </form>
                <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                  This page refreshes every 5 seconds. You can navigate away
                  safely — the cleanup keeps running in the background.
                </p>
                <script
                  dangerouslySetInnerHTML={{
                    __html: "setTimeout(() => location.reload(), 5000);",
                  }}
                />
              </>
            )}

            {activeJob.status === "completed" && (
              <p class="mt-3 text-sm font-medium text-green-700 dark:text-green-400">
                Cleanup completed successfully.
              </p>
            )}

            {activeJob.status === "cancelled" && (
              <p class="mt-3 text-sm font-medium text-red-700 dark:text-red-400">
                Cleanup was cancelled.
              </p>
            )}

            {activeJob.status === "failed" && activeJob.errorMessage && (
              <p class="mt-3 text-sm font-medium text-red-700 dark:text-red-400">
                Error: {activeJob.errorMessage}
              </p>
            )}
          </section>
        )}

        <section
          id="cleanup-thumbnails"
          class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <header class="mb-4">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Clean up thumbnails
            </h2>
            <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {cleanupDataResult ??
                "Free up storage by deleting old remote thumbnails.  Bookmarked, shared, and favorited posts are exempt."}
            </p>
          </header>
          <form method="post" action="/thumbnail_cleanup/clean">
            <div class="flex gap-2">
              <input
                type="date"
                name="before"
                value={suggestedCleanupCutoff}
                required
                aria-invalid={error === "clean" ? "true" : undefined}
                class={`${dateInputClass} flex-1 ${
                  error === "clean"
                    ? "border-red-500"
                    : "border-neutral-300 dark:border-neutral-700"
                }`}
              />
              <button
                name="submit"
                type="submit"
                disabled={shouldAutoRefresh}
                class={primaryButtonClass}
              >
                Clean
              </button>
            </div>
            <p class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              Cutoff date — thumbnails older than this will be deleted.
            </p>
          </form>
        </section>
      </div>
    </DashboardLayout>,
  );
});

data.post("/clean_preview", async (c) => {
  const form = await c.req.formData();
  var beforeParameter = form.get("before");
  if (typeof beforeParameter === "string") {
    const before = new Date(Date.parse(beforeParameter));
    if (STORAGE_URL_BASE !== undefined) {
      logger.info(`Starting cleanup preview - before: ${before.toISOString()}`);
      try {
        const mediaWithThumbnailToClean =
          await getMediaWithDeletableThumbnails(before);

        const firstItem = mediaWithThumbnailToClean.at(0);
        const lastItem = mediaWithThumbnailToClean.at(-1);
        const doneUrl: URL = new URL(
          "/thumbnail_cleanup",
          new URL(c.req.url).origin,
        );
        doneUrl.searchParams.set("done", "clean_preview");
        doneUrl.searchParams.set("before", beforeParameter);
        doneUrl.searchParams.set(
          "fileCount",
          String(mediaWithThumbnailToClean.length),
        );
        if (firstItem) {
          doneUrl.searchParams.set(
            "firstFile",
            firstItem.created.toLocaleString(),
          );
        }
        if (lastItem) {
          doneUrl.searchParams.set(
            "lastFile",
            lastItem.created.toLocaleString(),
          );
        }
        doneUrl.hash = "cleanup-preview";
        return c.redirect(doneUrl);
      } catch (error) {
        logger.error("Failed to clean up: {error}", { error });
      }
    }
  }

  const errorUrl: URL = new URL(
    "/thumbnail_cleanup",
    new URL(c.req.url).origin,
  );
  errorUrl.searchParams.set("error", "clean_preview");
  if (typeof beforeParameter === "string") {
    errorUrl.searchParams.set("before", beforeParameter);
  }
  errorUrl.hash = "cleanup-preview";
  return c.redirect(errorUrl);
});

data.post("/clean", async (c) => {
  const form = await c.req.formData();
  var beforeParameter = form.get("before");
  if (typeof beforeParameter !== "string") {
    return c.redirect(
      `/thumbnail_cleanup?cleanup-data-result=${encodeURIComponent("Invalid date")}#cleanup-thumbnails`,
    );
  }
  const before = new Date(Date.parse(beforeParameter));

  const category = "cleanup_thumbnails";

  const mediaWithThumbnailToClean =
    await getMediaWithDeletableThumbnails(before);

  if (mediaWithThumbnailToClean.length === 0) {
    return c.redirect(
      `/thumbnail_cleanup?cleanup-data-result=${encodeURIComponent("No thumbnails to delete")}#cleanup-thumbnails`,
    );
  }

  // Create the cleanup job
  const jobId = uuidv7();
  await db.insert(cleanupJobs).values({
    id: jobId,
    category: category,
    totalItems: mediaWithThumbnailToClean.length,
  });

  // Create cleanup job items in batches
  const itemValues = mediaWithThumbnailToClean.map((data) => ({
    id: uuidv7(),
    jobId,
    data: { id: data.id },
  }));

  // Insert in batches of 1000 to avoid hitting query size limits
  for (let i = 0; i < itemValues.length; i += 1000) {
    await db.insert(cleanupJobItems).values(itemValues.slice(i, i + 1000));
  }

  logger.info(
    "Created cleanup job {jobId} with {count} items for category {category}",
    { jobId, count: mediaWithThumbnailToClean.length, category },
  );

  // Redirect to thumbnail cleanup page with job ID
  return c.redirect(
    `/thumbnail_cleanup?cleanup-job=${jobId}#cleanup-thumbnails`,
  );
});

// Cancel cleanup job endpoint
data.post("/clean/:jobId/cancel", async (c) => {
  const jobId = c.req.param("jobId");

  if (!isUuid(jobId)) return c.notFound();

  // Verify job exists
  const job = await db.query.cleanupJobs.findFirst({
    where: eq(cleanupJobs.id, jobId),
  });

  if (!job) return c.notFound();

  // Only allow cancellation of pending or processing jobs
  if (job.status !== "pending" && job.status !== "processing") {
    return c.redirect(
      `/thumbnail_cleanup?cleanup-data-result=${encodeURIComponent("Job cannot be cancelled")}#cleanup-thumbnails`,
    );
  }

  // Mark job as cancelled
  await db
    .update(cleanupJobs)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(cleanupJobs.id, jobId));

  logger.info("Cleanup job {jobId} cancelled by user", { jobId });

  return c.redirect(
    `/thumbnail_cleanup?cleanup-data-result=${encodeURIComponent("Cleanup cancelled")}#cleanup-thumbnails`,
  );
});

export default data;
