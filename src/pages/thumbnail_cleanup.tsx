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

  return c.html(
    <DashboardLayout
      title="Hollo: Thumbnail Cleanup"
      selectedMenu="thumbnail_cleanup"
    >
      <hgroup>
        <h1>Thumbnail cleanup</h1>
        <p>This control panel allows you to clean up thumbnails.</p>
      </hgroup>

      <article>
        <header>
          <hgroup>
            <h2>Thumbnail statistics</h2>
            <p>An overview about the number of thumbnails tracked by hollo.</p>
          </hgroup>
        </header>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th style="text-align: right">Number of thumbnails</th>
            </tr>
          </thead>
          <tbody>
            {thumbnailsTable.map((entry) => (
              <tr>
                <td>{entry.caption}</td>
                <td style="text-align: right">
                  {entry.count.toLocaleString("en")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
      <article id="cleanup-preview">
        <header>
          <hgroup>
            <h2>Preview cleanup</h2>
            {done === "clean_preview" ? (
              <p>Preview done.</p>
            ) : (
              <p>Use this to preview the cleanup.</p>
            )}
          </hgroup>
        </header>
        <form
          method="post"
          action="/thumbnail_cleanup/clean_preview"
          onsubmit="this.submit.ariaBusy = 'true'"
        >
          <fieldset role="group">
            <input
              type="date"
              name="before"
              value={suggestedCleanupCutoff}
              required
              aria-invalid={error === "clean" ? "true" : undefined}
            />
            <button name="submit" type="submit">
              preview
            </button>
          </fieldset>
          {error === "clean_preview" ? (
            <small>Something went wrong while previewing the cleanup.</small>
          ) : (
            <small>The date before which remote thumbnails get deleted.</small>
          )}
        </form>
        {done === "clean_preview" &&
          (fileCount > 0 ? (
            <p>
              Number of Items: {fileCount.toLocaleString("en")}
              <br />
              First: {firstFile}
              <br />
              Last: {lastFile}
              <br />
            </p>
          ) : (
            <p>No thumbnails to clean.</p>
          ))}
      </article>

      {/* Cleanup Progress Section */}
      {activeJob && (
        <article id="cleanup-progress">
          <header>
            <hgroup>
              <h2>
                {activeJob.status === "pending"
                  ? "Cleanup Queued"
                  : activeJob.status === "processing"
                    ? "Cleanup in Progress"
                    : activeJob.status === "completed"
                      ? "Cleanup Completed"
                      : activeJob.status === "cancelled"
                        ? "Cleanup Cancelled"
                        : "Cleanup Failed"}
              </h2>
              <p>
                Cleanup
                {activeJob.status === "pending" && " waiting to start"}
                {activeJob.status === "processing" && " processing..."}
              </p>
            </hgroup>
          </header>

          <progress
            value={activeJob.processedItems}
            max={activeJob.totalItems}
          />

          <p>
            <strong>{activeJob.processedItems.toLocaleString("en-US")}</strong>{" "}
            / {activeJob.totalItems.toLocaleString("en-US")} items processed
            {activeJob.processedItems > 0 && (
              <>
                {" "}
                (
                <strong style={{ color: "var(--pico-ins-color)" }}>
                  {activeJob.successfulItems.toLocaleString("en-US")}
                </strong>{" "}
                successful
                {activeJob.failedItems > 0 && (
                  <>
                    ,{" "}
                    <strong style={{ color: "var(--pico-del-color)" }}>
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
              >
                <button type="submit" class="secondary">
                  Cancel Cleanup
                </button>
              </form>
              <small>
                This page refreshes automatically every 5 seconds. You can
                navigate away safely &mdash; the cleanup will continue in the
                background.
              </small>
              <script
                dangerouslySetInnerHTML={{
                  __html: "setTimeout(() => location.reload(), 5000);",
                }}
              />
            </>
          )}

          {activeJob.status === "completed" && (
            <p style={{ color: "var(--pico-ins-color)" }}>
              Cleanup completed successfully!
            </p>
          )}

          {activeJob.status === "cancelled" && (
            <p style={{ color: "var(--pico-del-color)" }}>
              Cleanup was cancelled.
            </p>
          )}

          {activeJob.status === "failed" && activeJob.errorMessage && (
            <p style={{ color: "var(--pico-del-color)" }}>
              Error: {activeJob.errorMessage}
            </p>
          )}
        </article>
      )}

      <article id="cleanup-thumbnails">
        <header>
          <hgroup>
            <h2>Clean up thumbnails</h2>
            {cleanupDataResult == null ? (
              <p>
                Use this if you want to free up storage by deleting old
                thumbnails from remote posts. Bookmarked, shared and favorited
                posts are exempt.
              </p>
            ) : (
              <p>{cleanupDataResult}</p>
            )}
          </hgroup>
        </header>
        <form method="post" action="/thumbnail_cleanup/clean">
          <fieldset role="group">
            <input
              type="date"
              name="before"
              value={suggestedCleanupCutoff}
              required
              aria-invalid={error === "clean" ? "true" : undefined}
            />
            <button
              name="submit"
              type="submit"
              {...(shouldAutoRefresh ? { disabled: true } : {})}
            >
              clean
            </button>
          </fieldset>
          <small>The date before which remote thumbnails get deleted.</small>
        </form>
      </article>
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
