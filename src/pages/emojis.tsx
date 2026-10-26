import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { getLogger } from "@logtape/logtape";
import { inArray, isNotNull, asc, eq, ne, sql, and } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import mime from "mime";

import { DashboardLayout } from "../components/DashboardLayout";
import { EMOJI_IMPORT_MAX_ARCHIVE_BYTES } from "../custom-emoji-import-config";
import db from "../db";
import federation, { customEmojiImports } from "../federation/federation";
import { loginRequired } from "../login";
import { proxyUrl } from "../media-proxy";
import {
  customEmojiImportJobs,
  customEmojiImportResults,
  customEmojis,
} from "../schema";
import { EMOJI_IMPORT_DISK } from "../storage-config";
import { isUuid, uuidv7 } from "../uuid";

const logger = getLogger(["hollo", "pages", "emojis"]);

const emojis = new Hono();
const MEBIBYTE = 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = MEBIBYTE;
const MAX_EMOJI_IMAGE_BYTES = 32 * MEBIBYTE;

function fileStream(file: File): Readable {
  // TypeScript's DOM and Node stream declarations disagree on BYOB readers.
  return Readable.fromWeb(file.stream() as unknown as NodeReadableStream);
}

emojis.use(csrf());
emojis.use(loginRequired);

emojis.get("/", async (c) => {
  const emojis = await db.query.customEmojis.findMany({
    orderBy: (customEmojis, { desc }) => [
      customEmojis.category,
      desc(customEmojis.created),
    ],
  });

  return c.html(
    <DashboardLayout title="Hollo: Custom emojis" selectedMenu="emojis">
      <header class="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
            Custom emojis
          </h1>
          <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Register custom emojis for your Hollo accounts.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <a
            href="/emojis/new"
            class="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
          >
            <span class="i-lucide-plus" aria-hidden="true" />
            Add emoji
          </a>
          {EMOJI_IMPORT_DISK != null ? (
            <a
              href="/emojis/zip"
              class="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <span class="i-lucide-upload" aria-hidden="true" />
              Upload ZIP
            </a>
          ) : (
            <button
              class="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 transition-colors  dark:border-neutral-700 dark:text-neutral-300  opacity-50"
              title="ZIP import requires EMOJI_IMPORT_FS_PATH or S3_EMOJI_IMPORT_BUCKET."
              type="button"
              disabled
            >
              <span class="i-lucide-upload" aria-hidden="true" />
              Upload ZIP
            </button>
          )}

          <a
            href="/emojis/import"
            class="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <span class="i-lucide-download" aria-hidden="true" />
            Import
          </a>
        </div>
      </header>
      <form
        method="post"
        action="/emojis/delete"
        onsubmit="const cnt = this.querySelectorAll('input[name=emoji]:checked').length; return window.confirm('Are you sure you want to delete the selected ' + (cnt > 1 ? cnt + ' emojis' : cnt + ' emoji') + '?');"
      >
        {emojis.length > 0 ? (
          <div class="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
            <table class="w-full text-sm">
              <thead class="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
                <tr>
                  <th class="w-10 px-3 py-2 text-left">
                    <span class="sr-only">Select</span>
                  </th>
                  <th class="px-3 py-2 text-left font-semibold">Category</th>
                  <th class="px-3 py-2 text-left font-semibold">Shortcode</th>
                  <th class="px-3 py-2 text-left font-semibold">Image</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-900">
                {emojis.map((emoji) => {
                  const previewUrl = proxyUrl(emoji.url, c.req.url);
                  return (
                    <tr>
                      <td class="px-3 py-2">
                        <input
                          type="checkbox"
                          id={`emoji-${emoji.shortcode}`}
                          name="emoji"
                          value={emoji.shortcode}
                          aria-label={`:${emoji.shortcode}:`}
                          class="size-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-200 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:ring-brand-900"
                          onchange="this.form.querySelector('button[type=submit]').disabled = !this.form.querySelectorAll('input[name=emoji]:checked').length"
                        />
                      </td>
                      <td class="px-3 py-2 text-neutral-700 dark:text-neutral-300">
                        <label htmlFor={`emoji-${emoji.shortcode}`}>
                          {emoji.category ?? "—"}
                        </label>
                      </td>
                      <td class="px-3 py-2">
                        <label
                          htmlFor={`emoji-${emoji.shortcode}`}
                          class="font-mono text-neutral-900 dark:text-neutral-100"
                        >
                          :{emoji.shortcode}:
                        </label>
                      </td>
                      <td class="px-3 py-2">
                        <label htmlFor={`emoji-${emoji.shortcode}`}>
                          {previewUrl == null ? (
                            <span class="text-xs text-neutral-500 dark:text-neutral-400">
                              :{emoji.shortcode}:
                            </span>
                          ) : (
                            <img
                              src={previewUrl}
                              alt={`:${emoji.shortcode}:`}
                              class="h-6 w-auto"
                            />
                          )}
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="rounded-xl border border-dashed border-neutral-300 px-6 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            No custom emojis yet. Add one above to get started.
          </div>
        )}
        {emojis.length > 0 && (
          <div class="mt-4 flex justify-end">
            <button
              type="submit"
              disabled
              class="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950"
            >
              <span class="i-lucide-trash-2" aria-hidden="true" />
              Delete selected
            </button>
          </div>
        )}
      </form>
    </DashboardLayout>,
  );
});

emojis.get("/new", async (c) => {
  const categories = await db
    .select({ category: customEmojis.category })
    .from(customEmojis)
    .where(isNotNull(customEmojis.category))
    .groupBy(customEmojis.category);
  return c.html(
    <DashboardLayout title="Hollo: Add custom emoji" selectedMenu="emojis">
      <header class="mb-6">
        <p class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          <a
            href="/emojis"
            class="hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            Custom emojis
          </a>
        </p>
        <h1 class="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Add a custom emoji
        </h1>
      </header>
      <form
        method="post"
        action="/emojis"
        enctype="multipart/form-data"
        class="space-y-4 rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="emoji-category"
              class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
            >
              Category
            </label>
            <select
              id="emoji-category"
              name="category"
              class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-brand-900"
              onchange="this.form.new.disabled = this.value != 'new'"
            >
              <option>None</option>
              <option value="new">New category</option>
              {categories.map(({ category }) => (
                <option value={`category:${category}`}>{category}</option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="emoji-new-category"
              class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
            >
              New category
            </label>
            <input
              id="emoji-new-category"
              type="text"
              name="new"
              disabled={true}
              aria-label="New category"
              class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-brand-900"
            />
          </div>
        </div>
        <div>
          <label
            htmlFor="emoji-shortcode"
            class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
          >
            Short code
          </label>
          <input
            id="emoji-shortcode"
            type="text"
            name="shortcode"
            required
            pattern="^:(-|[a-z0-9_])+:$"
            placeholder=":shortcode:"
            aria-label="Short code"
            class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono text-sm shadow-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-brand-900"
          />
        </div>
        <div>
          <label
            htmlFor="emoji-image"
            class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
          >
            Image
          </label>
          <label
            htmlFor="emoji-image"
            class="mt-1 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-neutral-300 bg-neutral-50 px-4 py-8 text-center text-sm text-neutral-600 transition-colors hover:border-brand-400 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-brand-600 dark:hover:bg-brand-950/20"
          >
            <span
              class="i-lucide-image-up text-2xl text-neutral-500 dark:text-neutral-400"
              aria-hidden="true"
            />
            <span class="font-medium text-neutral-800 dark:text-neutral-200">
              Click to choose an image
            </span>
            <span class="text-xs text-neutral-500 dark:text-neutral-400">
              PNG, JPEG, GIF, or WebP
            </span>
            <input
              id="emoji-image"
              type="file"
              name="image"
              required
              accept="image/png, image/jpeg, image/gif, image/webp"
              aria-label="Emoji image file"
              class="sr-only"
            />
          </label>
        </div>
        <div class="flex justify-end">
          <button
            type="submit"
            class="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
          >
            Add emoji
          </button>
        </div>
      </form>
    </DashboardLayout>,
  );
});

emojis.get("/zip", async (c) => {
  return c.html(
    <DashboardLayout title="Hollo: Upload custom emojis" selectedMenu="emojis">
      <header class="mb-6">
        <p class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          <a
            href="/emojis"
            class="hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            Custom emojis
          </a>
        </p>
        <h1 class="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Upload custom emojis (ZIP)
        </h1>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          <a
            href="https://misskey-hub.net/en/docs/for-admin/features/managing-emojis/#packed-emoji-format"
            target={"_blank"}
            rel="noopener noreferrer"
          >
            Hollo supports Misskey's packed emoji format.
          </a>
        </p>
      </header>
      {EMOJI_IMPORT_DISK != null ? (
        <form
          method="post"
          action="/emojis/zip"
          enctype="multipart/form-data"
          class="space-y-4 rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div>
            <label
              htmlFor="emoji-image"
              class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
            >
              ZIP file
            </label>
            <label
              htmlFor="emoji-image"
              class="mt-1 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-neutral-300 bg-neutral-50 px-4 py-8 text-center text-sm text-neutral-600 transition-colors hover:border-brand-400 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-brand-600 dark:hover:bg-brand-950/20"
            >
              <span
                class="i-lucide-file-up text-2xl text-neutral-500 dark:text-neutral-400"
                aria-hidden="true"
              />
              <span class="font-medium text-neutral-800 dark:text-neutral-200">
                Click to choose a ZIP file
              </span>
              <input
                id="emoji-image"
                type="file"
                name="archive"
                required
                accept=".zip"
                aria-label="Emoji ZIP file"
                class="sr-only"
              />
            </label>
          </div>
          <div class="flex justify-end gap-2">
            <a
              href={`/emojis/imports/job_list`}
              class="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <span class="i-lucide-list" aria-hidden="true" />
              Upload list
            </a>
            <button
              type="submit"
              class="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
            >
              Upload ZIP
            </button>
          </div>
        </form>
      ) : (
        <div class="space-y-4 rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
          <p class="text-sm text-red-700 dark:text-red-400">
            ZIP import requires EMOJI_IMPORT_FS_PATH or S3_EMOJI_IMPORT_BUCKET.
          </p>
        </div>
      )}
    </DashboardLayout>,
    EMOJI_IMPORT_DISK == null ? 503 : 200,
  );
});

emojis.get("/imports/job_list", async (c) => {
  const jobList = await db.query.customEmojiImportJobs.findMany({
    orderBy: { created: "desc" },
  });

  function formatDateTime(value: Date): string {
    // Access tokens carry no nickname, so the issue time is often the only thing
    // that tells two tokens from the same app apart; the date alone is not
    // enough.  Same server-locale caveat as formatDate() above.
    return value.toLocaleString();
  }

  return c.html(
    <DashboardLayout title="Hollo: Custom emoji import" selectedMenu="emojis">
      <header class="mb-6">
        <p class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          <a
            href="/emojis"
            class="hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            Custom emojis
          </a>
        </p>
        <h1 class="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Custom emoji import list
        </h1>
      </header>
      <section>
        <div class="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
          <table class="w-full text-sm">
            <thead class="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
              <tr>
                <th class="w-48 px-3 py-2 text-left">UPLOAD DATE</th>
                <th class="px-3 py-2 text-left font-semibold">JOBID</th>
                <th class="px-3 py-2 text-left font-semibold">RESULT</th>
                <th class="px-3 py-2 text-left font-semibold"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-900">
              {jobList.map((job) => {
                return (
                  <tr>
                    <td class="px-3 py-2">
                      {job.completed && (
                        <time dateTime={job.completed.toISOString()}>
                          {formatDateTime(job.completed)}
                        </time>
                      )}
                    </td>
                    <td class="px-3 py-2 text-neutral-700 dark:text-neutral-300">
                      {job.id}
                    </td>
                    <td class="px-3 py-2">{job.status}</td>
                    <td class="px-3 py-2">
                      <a
                        href={`/emojis/imports/${job.id}`}
                        class="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
                      >
                        {/* <span class="i-lucide-list" aria-hidden="true" /> */}
                        View details
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div class="mt-3 flex gap-2">
        <a
          href={`/emojis/zip`}
          class="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <span class="i-lucide-arrow-left" aria-hidden="true" />
          Back
        </a>
      </div>
    </DashboardLayout>,
  );
});

emojis.get("/imports/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  if (!isUuid(jobId)) {
    return c.notFound();
  }
  const job = await db.query.customEmojiImportJobs.findFirst({
    where: { id: { eq: jobId } },
  });

  if (job == null) {
    return c.notFound();
  }

  const results = await db
    .select()
    .from(customEmojiImportResults)
    .where(
      and(
        eq(customEmojiImportResults.jobId, job.id),
        ne(customEmojiImportResults.reason, "imported"),
      ),
    )
    .orderBy(asc(customEmojiImportResults.entryIndex));

  const inProgress = job.status === "pending" || job.status === "processing";

  const statusLabel = {
    pending: "Waiting",
    processing: "Importing",
    completed: "Completed",
    failed: "Failed",
  }[job.status];

  const resultLabel = {
    imported: "The emoji was imported.",
    duplicate_existing: "An emoji with the same shortcode already exists.",
    duplicate_in_pack: "The emoji pack contains duplicate shortcodes.",
    not_downloaded: "The emoji image could not be downloaded.",
    unsafe_file_path: "The file path is unsafe or invalid.",
    image_missing: "The emoji image file is missing.",
    invalid_shortcode: "The emoji shortcode is invalid.",
    unsupported_image_type: "The image format is not supported.",
    image_too_large: "The image file exceeds the maximum allowed size.",
    invalid_or_corrupt_image: "The image file is invalid or corrupted.",
    import_failed: "The emoji could not be imported.",
  } as const;

  const { drive } = await import("../storage");

  const canRetry =
    job.status === "failed" &&
    EMOJI_IMPORT_DISK != null &&
    (await drive.use("emojiImports").exists(job.archiveKey));

  return c.html(
    <DashboardLayout title="Hollo: Custom emoji import" selectedMenu="emojis">
      <header class="mb-6">
        <p class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          <a
            href="/emojis"
            class="hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            Custom emojis
          </a>
        </p>
        <h1 class="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Custom emoji import
        </h1>
      </header>

      <section class="rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <dl class="grid gap-4 sm:grid-cols-2">
          <div>
            <dt class="text-sm text-neutral-500 dark:text-neutral-400">
              Status
            </dt>
            <dd class="mt-1 font-semibold text-neutral-900 dark:text-neutral-100">
              {statusLabel}
            </dd>
          </div>

          <div>
            <dt class="text-sm text-neutral-500 dark:text-neutral-400">
              Imported
            </dt>
            <dd class="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
              {job.importedCount}
            </dd>
          </div>

          <div>
            <dt class="text-sm text-neutral-500 dark:text-neutral-400">
              Skipped
            </dt>
            <dd class="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
              {job.skippedCount}
            </dd>
          </div>

          <div>
            <dt class="text-sm text-neutral-500 dark:text-neutral-400">
              Failed
            </dt>
            <dd class="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
              {job.failedCount}
            </dd>
          </div>
        </dl>

        {job.error != null && (
          <p
            role="alert"
            class="mt-6 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {job.error}
          </p>
        )}

        {canRetry && (
          <form method="post" action={`/emojis/imports/${job.id}/retry`}>
            <button
              type="submit"
              class=" mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
            >
              Retry import
            </button>
          </form>
        )}

        {inProgress && (
          <>
            <p class="mt-6 text-sm text-neutral-500 dark:text-neutral-400">
              This page refreshes every 5 seconds while the import is running.
            </p>
            <script
              dangerouslySetInnerHTML={{
                __html: "setTimeout(() => location.reload(), 5000);",
              }}
            />
          </>
        )}
      </section>
      {results.length > 0 && (
        <section class="mt-6">
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Import result
          </h2>

          <div class="mt-3 overflow-x-auto">
            <table class="w-full table-fixed text-left text-sm">
              <colgroup>
                <col class="w-2/5" />
                <col class="w-3/5" />
              </colgroup>
              <thead>
                <tr class="border-b border-neutral-200 dark:border-neutral-800">
                  <th class="px-3 py-2">Entry</th>
                  <th class="px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => (
                  <tr class="border-b border-neutral-200 dark:border-neutral-800">
                    <td class="px-3 py-2">
                      <code class="block truncate">
                        :{result.originalShortcode}:
                      </code>
                    </td>
                    <td class="px-3 py-2">{resultLabel[result.reason]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <div class="mt-3 flex gap-2">
        <a
          href={`/emojis/zip`}
          class="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <span class="i-lucide-arrow-left" aria-hidden="true" />
          Back
        </a>
      </div>
    </DashboardLayout>,
  );
});
emojis.post("/imports/:jobId/retry", async (c) => {
  const jobId = c.req.param("jobId");

  if (!isUuid(jobId)) {
    return c.notFound();
  }

  const retryJob = await db.query.customEmojiImportJobs.findFirst({
    where: {
      id: { eq: jobId },
      status: { eq: "failed" },
    },
  });

  if (retryJob == null) return c.notFound();

  if (EMOJI_IMPORT_DISK == null) {
    return c.text("ZIP import storage is not configured", 503);
  }

  const { drive } = await import("../storage");
  const archiveExists = await drive
    .use("emojiImports")
    .exists(retryJob.archiveKey);

  if (!archiveExists) {
    return c.text("The original ZIP archive is no longer available.", 409);
  }

  const job = await db.transaction(async (tx) => {
    const [job] = await tx
      .update(customEmojiImportJobs)
      .set({
        status: "pending",
        importedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        error: null,
        completed: null,
        processingStarted: null,
        attemptToken: null,
        leaseExpiresAt: null,
        nextDispatchAt: new Date(),
      })
      .where(
        and(
          eq(customEmojiImportJobs.id, jobId),
          eq(customEmojiImportJobs.status, "failed"),
        ),
      )
      .returning();

    if (job == null) return null;

    await tx
      .delete(customEmojiImportResults)
      .where(
        and(
          eq(customEmojiImportResults.jobId, job.id),
          eq(customEmojiImportResults.reason, "import_failed"),
        ),
      );

    return job;
  });
  if (job == null) return c.notFound();

  try {
    await customEmojiImports.enqueue(
      federation.createContext(c.req.raw, undefined),
      job.id,
    );
  } catch (error) {
    logger.error(
      "Custom emoji import {jobId} committed but dispatch failed; recovery will retry: {error}",
      { jobId: job.id, error },
    );
  }

  return c.redirect(`/emojis/imports/${job.id}`);
});

emojis.post(
  "/",
  bodyLimit({
    maxSize: MAX_EMOJI_IMAGE_BYTES + MULTIPART_OVERHEAD_BYTES,
    onError: (c) => c.text("Emoji image is too large", 413),
  }),
  async (c) => {
    const { drive } = await import("../storage");
    const disk = drive.use();
    const form = await c.req.formData();
    const categoryValue = form.get("category")?.toString();
    const category = categoryValue?.startsWith("category:")
      ? categoryValue.slice(9)
      : categoryValue === "new"
        ? (form.get("new")?.toString() ?? "")
        : null;
    let shortcode = form.get("shortcode")?.toString();
    if (shortcode == null) {
      return c.text("No shortcode provided", 400);
    }
    if (!/^:(-|[a-z0-9_])+:$/.test(shortcode)) {
      return c.text("Invalid shortcode format", 400);
    }
    shortcode = shortcode.replace(/^:|:$/g, "");
    const image = form.get("image");
    if (image == null || !(image instanceof File)) {
      return c.text("No image provided", 400);
    }
    if (image.size > MAX_EMOJI_IMAGE_BYTES) {
      return c.text("Emoji image is too large", 413);
    }
    const extension = mime.getExtension(image.type);
    if (!extension) {
      return c.text("Unsupported image type", 400);
    }
    const imageKey = `emojis/${uuidv7()}.${extension}`;
    let storedImage = false;

    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${shortcode}))`,
        );

        const [existingEmoji] = await tx
          .select({ shortcode: customEmojis.shortcode })
          .from(customEmojis)
          .where(eq(customEmojis.shortcode, shortcode))
          .limit(1);

        if (existingEmoji != null) return "duplicate";

        await disk.putStream(imageKey, fileStream(image), {
          contentType: image.type,
          contentLength: image.size,
          visibility: "public",
        });
        storedImage = true;

        const url = await disk.getUrl(imageKey);
        await tx.insert(customEmojis).values({
          category,
          shortcode,
          url,
        });

        return "created";
      });

      if (result === "duplicate") {
        return c.text("Skipped duplicate emoji shortcode", 400);
      }
    } catch (error) {
      logger.error("Failed to store custom emoji", {
        error,
        imageKey,
        contentLength: image.size,
      });

      if (storedImage) {
        await disk.delete(imageKey);
      }

      return c.text("Failed to store emoji image", 500);
    }

    return c.redirect("/emojis");
  },
);

emojis.post("/delete", async (c) => {
  const form = await c.req.formData();
  const shortcodes = form.getAll("emoji");
  if (shortcodes.length === 0) {
    return c.redirect("/emojis");
  }
  await db.delete(customEmojis).where(
    inArray(
      customEmojis.shortcode,
      shortcodes.map((s) => s.toString()),
    ),
  );
  return c.redirect("/emojis");
});

emojis.get("/import", async (c) => {
  const postList = await db.query.posts.findMany({
    with: { account: true },
    where: { emojis: { ne: {} } },
    orderBy: (posts, { desc }) => [desc(posts.updated)],
    limit: 500,
  });
  const reactionList = await db.query.reactions.findMany({
    with: { account: true },
    where: { customEmoji: { isNotNull: true } },
    orderBy: (reactions, { desc }) => [desc(reactions.created)],
    limit: 500,
  });
  const accountList = await db.query.accounts.findMany({
    where: { emojis: { ne: {} } },
    orderBy: (accounts, { desc }) => [desc(accounts.updated)],
    limit: 500,
  });
  const customEmojis = await db.query.customEmojis.findMany();
  const customEmojiCodes = new Set<string>();
  const customEmojiUrls = new Set<string>();
  const categories = new Set<string>();
  for (const customEmoji of customEmojis) {
    customEmojiCodes.add(customEmoji.shortcode);
    customEmojiUrls.add(customEmoji.url);
    if (customEmoji.category != null) categories.add(customEmoji.category);
  }
  const emojis: Record<
    string,
    { id: string; shortcode: string; url: string; domain: string }
  > = {};
  for (const post of postList) {
    for (let shortcode in post.emojis) {
      const url = post.emojis[shortcode];
      shortcode = shortcode.replace(/^:|:$/g, "");
      if (customEmojiCodes.has(shortcode)) continue;
      if (customEmojiUrls.has(url)) continue;
      const domain = post.account.handle.replace(/^@?[^@]+@/, "");
      const id = `${shortcode}@${domain}`;
      emojis[id] = {
        id,
        shortcode,
        url,
        domain,
      };
    }
  }
  for (const reaction of reactionList) {
    if (reaction.customEmoji == null) continue;
    const shortcode = reaction.emoji.replace(/^:|:$/g, "");
    if (customEmojiCodes.has(shortcode)) continue;
    if (customEmojiUrls.has(reaction.customEmoji)) continue;
    const domain = reaction.account.handle.replace(/^@?[^@]+@/, "");
    const id = `${shortcode}@${domain}`;
    emojis[id] = {
      id,
      shortcode,
      url: reaction.customEmoji,
      domain,
    };
  }
  for (const account of accountList) {
    for (let shortcode in account.emojis) {
      const url = account.emojis[shortcode];
      shortcode = shortcode.replace(/^:|:$/g, "");
      if (customEmojiCodes.has(shortcode)) continue;
      if (customEmojiUrls.has(url)) continue;
      const domain = account.handle.replace(/^@?[^@]+@/, "");
      const id = `${shortcode}@${domain}`;
      emojis[id] = {
        id,
        shortcode,
        url,
        domain,
      };
    }
  }
  return c.html(
    <DashboardLayout title="Hollo: Import custom emojis" selectedMenu="emojis">
      <header class="mb-6">
        <p class="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          <a
            href="/emojis"
            class="hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            Custom emojis
          </a>
        </p>
        <h1 class="mt-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Import custom emojis
        </h1>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Import custom emojis discovered on peer servers.
        </p>
      </header>
      <form method="post" class="space-y-4">
        <div class="overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
          <table class="w-full text-sm">
            <thead class="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
              <tr>
                <th class="w-10 px-3 py-2 text-left">
                  <span class="sr-only">Select</span>
                </th>
                <th class="px-3 py-2 text-left font-semibold">Shortcode</th>
                <th class="px-3 py-2 text-left font-semibold">Domain</th>
                <th class="px-3 py-2 text-left font-semibold">Image</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-900">
              {Object.values(emojis).map(({ id, shortcode, url, domain }) => {
                const previewUrl = proxyUrl(url, c.req.url);
                return (
                  <tr>
                    <td class="px-3 py-2">
                      <input
                        type="checkbox"
                        id={id}
                        name="import"
                        value={JSON.stringify({ shortcode, url })}
                        aria-label={`:${shortcode}:`}
                        class="size-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-200 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:ring-brand-900"
                      />
                    </td>
                    <td class="px-3 py-2">
                      <label
                        htmlFor={id}
                        class="font-mono text-neutral-900 dark:text-neutral-100"
                      >
                        :{shortcode}:
                      </label>
                    </td>
                    <td class="px-3 py-2 text-neutral-700 dark:text-neutral-300">
                      <label htmlFor={id}>{domain}</label>
                    </td>
                    <td class="px-3 py-2">
                      <label htmlFor={id}>
                        {previewUrl == null ? (
                          <span class="text-xs text-neutral-500 dark:text-neutral-400">
                            :{shortcode}:
                          </span>
                        ) : (
                          <img
                            src={previewUrl}
                            alt={`:${shortcode}:`}
                            class="h-6 w-auto"
                          />
                        )}
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div class="grid gap-4 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 sm:grid-cols-2">
          <div>
            <label
              htmlFor="import-category"
              class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
            >
              Category
            </label>
            <select
              id="import-category"
              name="category"
              class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-brand-900"
              onchange="this.form.new.disabled = this.value != 'new'"
            >
              <option>None</option>
              <option value="new">New category</option>
              {[...categories].map((category) => (
                <option value={`category:${category}`}>{category}</option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="import-new-category"
              class="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
            >
              New category
            </label>
            <input
              id="import-new-category"
              type="text"
              name="new"
              disabled={true}
              aria-label="New category"
              class="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:ring-brand-900"
            />
          </div>
        </div>
        <div class="flex justify-end">
          <button
            type="submit"
            class="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700 dark:bg-brand-700 dark:hover:bg-brand-800"
          >
            Import selected emojis
          </button>
        </div>
      </form>
    </DashboardLayout>,
  );
});

emojis.post("/import", async (c) => {
  const form = await c.req.formData();
  const categoryValue = form.get("category")?.toString();
  const category = categoryValue?.startsWith("category:")
    ? categoryValue.slice(9)
    : categoryValue === "new"
      ? (form.get("new")?.toString() ?? "")
      : null;
  const imports = form.getAll("import").map((i) => JSON.parse(i.toString()));
  for (const { shortcode, url } of imports) {
    try {
      await db.insert(customEmojis).values({ category, shortcode, url });
    } catch (error) {
      logger.error(
        "Failed to import emoji {shortcode} to {category}: {error}",
        { category, shortcode, error },
      );
    }
  }
  return c.redirect("/emojis");
});

emojis.post(
  "/zip",
  bodyLimit({
    maxSize: EMOJI_IMPORT_MAX_ARCHIVE_BYTES + MULTIPART_OVERHEAD_BYTES,
    onError: (c) => c.text("ZIP archive is too large", 413),
  }),
  async (c) => {
    if (EMOJI_IMPORT_DISK == null) {
      return c.text("ZIP import storage is not configured", 503);
    }
    const form = await c.req.formData();
    const file = form.get("archive");

    if (!(file instanceof File)) {
      return c.text("No ZIP file provided", 400);
    }

    if (file.size > EMOJI_IMPORT_MAX_ARCHIVE_BYTES) {
      return c.text("ZIP archive is too large", 413);
    }

    const jobId = uuidv7();
    const archiveKey = `emoji-imports/${jobId}/archive.zip`;

    const { drive } = await import("../storage");
    const archiveDisk = drive.use("emojiImports");

    try {
      await archiveDisk.putStream(archiveKey, fileStream(file), {
        contentType: "application/zip",
        contentLength: file.size,
        visibility: "private",
      });
      try {
        await db.insert(customEmojiImportJobs).values({
          id: jobId,
          archiveKey,
          status: "pending",
        });
      } catch (error) {
        await archiveDisk.delete(archiveKey);
        throw error;
      }
    } catch (error) {
      logger.error("Failed to store emoji import archive: {error}", { error });
      return c.text("Failed to store ZIP archive", 500);
    }

    try {
      await customEmojiImports.enqueue(
        federation.createContext(c.req.raw, undefined),
        jobId,
      );
    } catch (error) {
      logger.error(
        "Custom emoji import {jobId} committed but dispatch failed; recovery will retry: {error}",
        { jobId, error },
      );
    }

    return c.redirect(`/emojis/imports/${jobId}`);
  },
);

export default emojis;
