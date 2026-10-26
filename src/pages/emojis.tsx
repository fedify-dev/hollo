import { getLogger } from "@logtape/logtape";
import { inArray, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import mime from "mime";

import { DashboardLayout } from "../components/DashboardLayout";
import { EMOJI_IMPORT_MAX_ARCHIVE_BYTES } from "../custom-emoji-import-config";
import db from "../db";
import federation, { customEmojiImports } from "../federation/federation";
import { loginRequired } from "../login";
import { proxyUrl } from "../media-proxy";
import { customEmojiImportJobs, customEmojis } from "../schema";
import { EMOJI_IMPORT_DISK } from "../storage-config";
import { isUuid, uuidv7 } from "../uuid";

const logger = getLogger(["hollo", "pages", "emojis"]);

const emojis = new Hono();

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
          <a
            href="/emojis/zip"
            class="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <span class="i-lucide-upload" aria-hidden="true" />
            Upload ZIP
          </a>
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
          Upload Custom Emojis (ZIP)
        </h1>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          <a
            href="https://misskey-hub.net/en/docs/for-admin/features/managing-emojis/#packed-emoji-format"
            target={"_blank"}
          >
            {" "}
            support Misskey's packed emoji format
          </a>
        </p>
      </header>
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
            Zip
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
              name="image"
              required
              accept=".zip"
              aria-label="Emoji image Zip"
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

emojis.get("/imports/:jobId", async (c) => {
  const jobId = c.req.param("jobId");

  if (jobId == null) {
    return c.notFound();
  }

  if (!isUuid(jobId)) {
    return c.notFound();
  }
  const job = await db.query.customEmojiImportJobs.findFirst({
    where: { id: { eq: jobId } },
  });

  if (job == null) {
    return c.notFound();
  }

  const inProgress = job.status === "pending" || job.status === "processing";

  const statusLabel = {
    pending: "Waiting",
    processing: "Importing",
    completed: "Completed",
    failed: "Failed",
  }[job.status];

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
    </DashboardLayout>,
  );
});
emojis.post("/", async (c) => {
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
  const content = new Uint8Array(await image.arrayBuffer());
  const extension = mime.getExtension(image.type);
  if (!extension) {
    return c.text("Unsupported image type", 400);
  }
  const path = `emojis/${shortcode}.${extension}`;
  try {
    await disk.put(path, content, {
      contentType: image.type,
      contentLength: content.byteLength,
      visibility: "public",
    });
  } catch (error) {
    logger.error("Failed to store emoji image", {
      error,
      path,
      contentLength: content.byteLength,
    });
    return c.text("Failed to store emoji image", 500);
  }
  const url = await disk.getUrl(path);
  await db.insert(customEmojis).values({
    category,
    shortcode,
    url,
  });
  return c.redirect("/emojis");
});

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

emojis.post("/zip", async (c) => {
  if (EMOJI_IMPORT_DISK == null) {
    return c.text("ZIP import storage is not configured", 503);
  }
  const form = await c.req.formData();
  const file = form.get("image");

  if (!(file instanceof File)) {
    return c.text("No ZIP file provided", 400);
  }

  if (file.size > EMOJI_IMPORT_MAX_ARCHIVE_BYTES) {
    return c.text("ZIP archive is too large", 413);
  }

  const archive = new Uint8Array(await file.arrayBuffer());
  const jobId = uuidv7();
  const archiveKey = `emoji-imports/${jobId}/archive.zip`;

  const { drive } = await import("../storage");
  const archiveDisk = drive.use("emojiImports");

  try {
    await archiveDisk.put(archiveKey, archive, {
      contentType: "application/zip",
      contentLength: archive.byteLength,
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

  await customEmojiImports.enqueue(
    federation.createContext(c.req.raw, undefined),
    jobId,
  );

  return c.redirect(`/emojis/imports/${jobId}`);
});

export default emojis;
