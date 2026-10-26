import {
  createFederation,
  MemoryKvStore,
  type Message,
  type MessageQueue,
  type MessageQueueEnqueueOptions,
} from "@fedify/fedify";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase, getFixtureFile } from "../tests/helpers";
import { registerCustomEmojiImports } from "./custom-emoji-import-tasks";
import db from "./db";
import {
  customEmojiImportJobs,
  customEmojiImportResults,
  customEmojis,
} from "./schema";
import { drive } from "./storage";
import { uuidv7 } from "./uuid";

class TestQueue implements MessageQueue {
  messages: Message[] = [];

  async enqueue(
    message: Message,
    _options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    this.messages.push(message);
  }

  async listen(): Promise<void> {}
}

function fixture() {
  const queue = new TestQueue();

  const federation = createFederation<void>({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
  });

  const tasks = registerCustomEmojiImports(federation);

  const ctx = federation.createContext(
    new URL("https://hollo.test"),
    undefined,
  );

  return {
    queue,
    tasks,
    ctx,
    run: () => federation.processQueuedTask(undefined, queue.messages.shift()!),
  };
}

async function emojiImage() {
  return new Uint8Array(
    await (await getFixtureFile("emoji.png", "image/png")).arrayBuffer(),
  );
}

function packedArchive(
  emojis: Array<{
    downloaded?: boolean;
    fileName: string;
    emoji: { name: string; category?: string | null };
  }>,
  files: Record<string, Uint8Array>,
) {
  return zipSync({
    "emoji-pack/meta.json": strToU8(
      JSON.stringify({
        metaVersion: 1,
        host: "",
        exportedAt: "2026-10-29T00:00:00.000Z",
        emojis,
      }),
    ),
    ...Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        `emoji-pack/${name}`,
        content,
      ]),
    ),
  });
}

describe("Custom emoji import tasks", () => {
  beforeEach(cleanDatabase);

  afterEach(() => {
    vi.restoreAllMocks();
    drive.restore();
    drive.restore("emojiImports");
  });

  it("imports an emoji from a Misskey packed emoji archive", async () => {
    expect.assertions(5);

    const imageDisk = drive.fake();
    const archiveDisk = drive.fake("emojiImports");

    const image = new Uint8Array(
      await (await getFixtureFile("emoji.png", "image/png")).arrayBuffer(),
    );

    const archive = zipSync({
      "emoji-pack/meta.json": strToU8(
        JSON.stringify({
          metaVersion: 1,
          host: "",
          exportedAt: "2026-10-29T00:00:00.000Z",
          emojis: [
            {
              downloaded: true,
              fileName: "cat.png",
              emoji: {
                name: "cat",
                category: "animals",
              },
            },
          ],
        }),
      ),
      "emoji-pack/cat.png": image,
    });

    const jobId = uuidv7();
    const archiveKey = `emoji-imports/${jobId}/archive.zip`;

    await archiveDisk.put(archiveKey, archive);

    await db.insert(customEmojiImportJobs).values({
      id: jobId,
      archiveKey,
      status: "pending",
    });

    const f = fixture();
    await f.tasks.enqueue(f.ctx, jobId);
    await f.run();

    const job = await db.query.customEmojiImportJobs.findFirst({
      where: { id: { eq: jobId } },
    });

    expect(job).toMatchObject({
      status: "completed",
      importedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });

    const emoji = await db.query.customEmojis.findFirst({
      where: { shortcode: { eq: "cat" } },
    });

    expect(emoji).toMatchObject({
      shortcode: "cat",
      category: "animals",
      url: `http://hollo.test/assets/emojis/${jobId}/0.png`,
    });

    const results = await db
      .select({ reason: customEmojiImportResults.reason })
      .from(customEmojiImportResults)
      .where(eq(customEmojiImportResults.jobId, jobId));

    expect(results).toEqual([{ reason: "imported" }]);

    expect(() => imageDisk.assertExists(`emojis/${jobId}/0.png`)).not.toThrow();

    expect(() => archiveDisk.assertMissing(archiveKey)).not.toThrow();
  });

  it("resumes an expired lease without repeating completed entries", async () => {
    expect.assertions(2);

    const archiveDisk = drive.fake("emojiImports");
    const image = new Uint8Array(
      await (await getFixtureFile("emoji.png", "image/png")).arrayBuffer(),
    );
    const archive = zipSync({
      "emoji-pack/meta.json": strToU8(
        JSON.stringify({
          metaVersion: 1,
          host: "",
          exportedAt: "2026-10-29T00:00:00.000Z",
          emojis: [
            {
              downloaded: true,
              fileName: "cat.png",
              emoji: { name: "cat" },
            },
          ],
        }),
      ),
      "emoji-pack/cat.png": image,
    });
    const jobId = uuidv7();
    const archiveKey = `emoji-imports/${jobId}/archive.zip`;
    await archiveDisk.put(archiveKey, archive);
    await db.insert(customEmojiImportJobs).values({
      id: jobId,
      archiveKey,
      status: "processing",
      processingStarted: new Date(Date.now() - 10 * 60_000),
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    await db.insert(customEmojis).values({
      shortcode: "cat",
      url: "http://hollo.test/assets/emojis/cat.png",
      category: null,
    });
    await db.insert(customEmojiImportResults).values({
      id: uuidv7(),
      jobId,
      entryIndex: 0,
      originalShortcode: "cat",
      normalizedShortcode: "cat",
      reason: "imported",
      conflictingEntryIndex: null,
    });

    const f = fixture();
    await f.tasks.recover(f.ctx);
    await f.run();

    const job = await db.query.customEmojiImportJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const results = await db
      .select()
      .from(customEmojiImportResults)
      .where(eq(customEmojiImportResults.jobId, jobId));

    expect(job).toMatchObject({
      status: "completed",
      importedCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
    expect(results).toHaveLength(1);
  });

  it("fails the job when recording a duplicate emoji result fails", async () => {
    const archiveDisk = drive.fake("emojiImports");
    const image = new Uint8Array(
      await (await getFixtureFile("emoji.png", "image/png")).arrayBuffer(),
    );
    const archive = zipSync({
      "emoji-pack/meta.json": strToU8(
        JSON.stringify({
          metaVersion: 1,
          host: "",
          exportedAt: "2026-10-29T00:00:00.000Z",
          emojis: [
            {
              downloaded: true,
              fileName: "first.png",
              emoji: { name: "cat" },
            },
            {
              downloaded: true,
              fileName: "second.png",
              emoji: { name: "CAT" },
            },
          ],
        }),
      ),
      "emoji-pack/first.png": image,
      "emoji-pack/second.png": image,
    });
    const jobId = uuidv7();
    const archiveKey = `emoji-imports/${jobId}/archive.zip`;
    await archiveDisk.put(archiveKey, archive);
    await db.insert(customEmojiImportJobs).values({
      id: jobId,
      archiveKey,
      status: "pending",
    });

    const transaction = db.transaction.bind(db);
    let transactionCount = 0;
    vi.spyOn(db, "transaction").mockImplementation(async (callback) => {
      transactionCount += 1;
      if (transactionCount === 2) {
        throw new Error("database unavailable");
      }
      return transaction(callback);
    });

    const f = fixture();
    await f.tasks.enqueue(f.ctx, jobId);
    await f.run();

    const job = await db.query.customEmojiImportJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(job).toMatchObject({ status: "failed" });
  });

  it("records per-entry skipped and failed results while completing the job", async () => {
    const archiveDisk = drive.fake("emojiImports");
    const image = await emojiImage();
    const jobId = uuidv7();
    const archiveKey = `emoji-imports/${jobId}/archive.zip`;
    await archiveDisk.put(
      archiveKey,
      packedArchive(
        [
          {
            downloaded: false,
            fileName: "not-downloaded.png",
            emoji: { name: "skip" },
          },
          {
            downloaded: true,
            fileName: "../unsafe.png",
            emoji: { name: "unsafe" },
          },
          {
            downloaded: true,
            fileName: "missing.png",
            emoji: { name: "missing" },
          },
          {
            downloaded: true,
            fileName: "valid.png",
            emoji: { name: "invalid name" },
          },
          { downloaded: true, fileName: "text.txt", emoji: { name: "text" } },
        ],
        { "valid.png": image, "text.txt": strToU8("not an image") },
      ),
    );
    await db.insert(customEmojiImportJobs).values({
      id: jobId,
      archiveKey,
      status: "pending",
    });

    const f = fixture();
    await f.tasks.enqueue(f.ctx, jobId);
    await f.run();

    const job = await db.query.customEmojiImportJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const results = await db
      .select({ reason: customEmojiImportResults.reason })
      .from(customEmojiImportResults)
      .where(eq(customEmojiImportResults.jobId, jobId));

    expect(job).toMatchObject({
      status: "completed",
      importedCount: 0,
      skippedCount: 1,
      failedCount: 4,
    });
    expect(results.map((result) => result.reason)).toEqual([
      "not_downloaded",
      "unsafe_file_path",
      "image_missing",
      "invalid_shortcode",
      "unsupported_image_type",
    ]);
  });

  it("records existing and in-pack duplicate shortcodes", async () => {
    const archiveDisk = drive.fake("emojiImports");
    const image = await emojiImage();
    const jobId = uuidv7();
    const archiveKey = `emoji-imports/${jobId}/archive.zip`;
    await archiveDisk.put(
      archiveKey,
      packedArchive(
        [
          { downloaded: true, fileName: "cat.png", emoji: { name: "cat" } },
          {
            downloaded: true,
            fileName: "cat-upper.png",
            emoji: { name: "CAT" },
          },
          { downloaded: true, fileName: "dog.png", emoji: { name: "dog" } },
        ],
        { "cat.png": image, "cat-upper.png": image, "dog.png": image },
      ),
    );
    await db.insert(customEmojis).values({
      shortcode: "dog",
      url: "http://hollo.test/assets/emojis/dog.png",
      category: null,
    });
    await db.insert(customEmojiImportJobs).values({
      id: jobId,
      archiveKey,
      status: "pending",
    });

    const f = fixture();
    await f.tasks.enqueue(f.ctx, jobId);
    await f.run();

    const job = await db.query.customEmojiImportJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const results = await db
      .select({
        reason: customEmojiImportResults.reason,
        conflictingEntryIndex: customEmojiImportResults.conflictingEntryIndex,
      })
      .from(customEmojiImportResults)
      .where(eq(customEmojiImportResults.jobId, jobId))
      .orderBy(customEmojiImportResults.entryIndex);

    expect(job).toMatchObject({
      status: "completed",
      importedCount: 1,
      skippedCount: 2,
      failedCount: 0,
    });
    expect(results).toEqual([
      { reason: "imported", conflictingEntryIndex: null },
      { reason: "duplicate_in_pack", conflictingEntryIndex: 0 },
      { reason: "duplicate_existing", conflictingEntryIndex: null },
    ]);
  });

  it("keeps a malformed archive for retry after marking its job failed", async () => {
    const archiveDisk = drive.fake("emojiImports");
    const jobId = uuidv7();
    const archiveKey = `emoji-imports/${jobId}/archive.zip`;
    await archiveDisk.put(archiveKey, strToU8("not a ZIP archive"));
    await db.insert(customEmojiImportJobs).values({
      id: jobId,
      archiveKey,
      status: "pending",
    });

    const f = fixture();
    await f.tasks.enqueue(f.ctx, jobId);
    await f.run();

    const job = await db.query.customEmojiImportJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(job).toMatchObject({ status: "failed" });
    expect(() => archiveDisk.assertExists(archiveKey)).not.toThrow();
  });

  it("does not recover a job with a live lease", async () => {
    const jobId = uuidv7();
    await db.insert(customEmojiImportJobs).values({
      id: jobId,
      archiveKey: `emoji-imports/${jobId}/archive.zip`,
      status: "processing",
      attemptToken: uuidv7(),
      processingStarted: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    const f = fixture();
    await f.tasks.recover(f.ctx);

    const job = await db.query.customEmojiImportJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(job).toMatchObject({ status: "processing" });
    expect(f.queue.messages).toHaveLength(0);
  });

  it("re-enqueues a pending job after its dispatch reservation expires", async () => {
    const jobId = uuidv7();
    await db.insert(customEmojiImportJobs).values({
      id: jobId,
      archiveKey: `emoji-imports/${jobId}/archive.zip`,
      status: "pending",
    });

    const f = fixture();
    await f.tasks.enqueue(f.ctx, jobId);
    f.queue.messages = [];
    await db
      .update(customEmojiImportJobs)
      .set({ nextDispatchAt: new Date(0) })
      .where(eq(customEmojiImportJobs.id, jobId));
    await f.tasks.recover(f.ctx);

    expect(f.queue.messages).toHaveLength(1);
  });
});
