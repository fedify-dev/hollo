import { type Context, type Federation } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { and, eq, lt, sql } from "drizzle-orm";
import { Unzip, UnzipInflate } from "fflate";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";

import {
  EMOJI_IMPORT_MAX_ENTRY_COUNT,
  EMOJI_IMPORT_MAX_EXTRACTED_BYTES,
} from "./custom-emoji-import-config";
import db from "./db";
import { customEmojiImportJobs, customEmojis } from "./schema";
import { uuid, type Uuid } from "./uuid";

const logger = getLogger(["hollo", "custom-emoji-imports"]);

const misskeyPackedEmojiMetaSchema = z.object({
  emojis: z.array(
    z.object({
      downloaded: z.boolean().optional().default(false),
      fileName: z.string().min(1),
      emoji: z.object({
        name: z.string().min(1),
        category: z.string().nullable().optional(),
      }),
    }),
  ),
});

export function registerCustomEmojiImports(federation: Federation<void>) {
  const task = federation.defineTask("hollo.custom-emoji-import.v1", {
    schema: z.object({
      jobId: uuid,
    }),
    retryPolicy: () => null,

    handler: async (_ctx, { jobId }) => {
      const [job] = await db
        .update(customEmojiImportJobs)
        .set({
          status: "processing",
          processingStarted: new Date(),
        })
        .where(
          and(
            eq(customEmojiImportJobs.id, jobId),
            eq(customEmojiImportJobs.status, "pending"),
          ),
        )
        .returning();

      if (job == null) {
        return;
      }
      const { drive } = await import("./storage");
      const archiveDisk = drive.use("emojiImports");
      const archive = await archiveDisk.getBytes(job.archiveKey);

      const files = await decompressZip(archive, {
        maxEntryCount: EMOJI_IMPORT_MAX_ENTRY_COUNT,
        maxExtractedBytes: EMOJI_IMPORT_MAX_EXTRACTED_BYTES,
      });
      const metaPaths = Object.keys(files).filter(
        (path) =>
          !path.startsWith("__MACOSX/") &&
          (path === "meta.json" || path.endsWith("/meta.json")),
      );

      if (metaPaths.length !== 1) {
        throw new Error("Expected exactly one meta.json file");
      }
      const metaPath = metaPaths[0];
      const archivePrefix = metaPath.slice(0, -"meta.json".length);
      const metaContents = files[metaPath];
      if (metaContents == null) {
        throw new Error("meta.json not found");
      }

      const rawMeta: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(metaContents),
      );

      const parsedMeta = misskeyPackedEmojiMetaSchema.safeParse(rawMeta);

      if (!parsedMeta.success) {
        logger.warn("Invalid Misskey packed emoji manifest: {error}", {
          error: parsedMeta.error.message,
        });

        throw new Error("Invalid Misskey packed emoji manifest");
      }

      const meta = parsedMeta.data;

      const imageDisk = drive.use();

      let importedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;

      const allowedTypes = new Set([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
      ]);

      for (const entry of meta.emojis) {
        if (!entry.downloaded) {
          skippedCount += 1;
          continue;
        }

        if (!isSafeArchivePath(entry.fileName)) {
          failedCount += 1;
          continue;
        }

        const content = files[archivePrefix + entry.fileName];
        if (content == null) {
          logger.warn("Image is missing from emoji archive: {fileName}", {
            fileName: entry.fileName,
          });
          failedCount += 1;
          continue;
        }

        const shortcode = entry.emoji.name;
        const category = entry.emoji.category;

        if (!/^[-a-z0-9_]+$/.test(shortcode)) {
          logger.warn("Invalid emoji shortcode: {shortcode}", { shortcode });
          skippedCount += 1;
          continue;
        }

        const fileType = await fileTypeFromBuffer(content);
        if (fileType == null || !allowedTypes.has(fileType.mime)) {
          logger.warn("Unsupported emoji image: {fileName}", {
            fileName: entry.fileName,
          });
          skippedCount += 1;
          continue;
        }

        const imageKey = `emojis/${shortcode}.${fileType.ext}`;
        let storedImage = false;

        try {
          const result = await db.transaction(async (tx) => {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${shortcode}))`,
            );

            const [existing] = await tx
              .select({ shortcode: customEmojis.shortcode })
              .from(customEmojis)
              .where(eq(customEmojis.shortcode, shortcode))
              .limit(1);

            if (existing != null) {
              return "skipped";
            }

            await imageDisk.put(imageKey, content, {
              contentType: fileType.mime,
              contentLength: content.byteLength,
              visibility: "public",
            });
            storedImage = true;

            const url = await imageDisk.getUrl(imageKey);

            await tx.insert(customEmojis).values({
              shortcode,
              category: category ?? null,
              url,
            });

            return "imported";
          });

          if (result === "skipped") {
            logger.info("Skipped duplicate emoji shortcode: {shortcode}", {
              shortcode,
            });
            skippedCount += 1;
          } else {
            importedCount += 1;
          }
        } catch (error) {
          logger.error("Failed to import emoji {shortcode}: {error}", {
            shortcode,
            error,
          });

          if (storedImage) {
            await imageDisk.delete(imageKey);
          }

          failedCount += 1;
        }
      }
      await db
        .update(customEmojiImportJobs)
        .set({
          status: "completed",
          importedCount: importedCount,
          skippedCount: skippedCount,
          failedCount: failedCount,
          completed: new Date(),
        })
        .where(
          and(
            eq(customEmojiImportJobs.id, jobId),
            eq(customEmojiImportJobs.status, "processing"),
          ),
        )
        .returning();
      try {
        await archiveDisk.delete(job.archiveKey);
      } catch (error) {
        logger.error(
          "Failed to delete custom emoji import archive {archiveKey}: {error}",
          { archiveKey: job.archiveKey, error },
        );
      }
    },

    onError: async (_ctx, error, { jobId }) => {
      logger.error("Custom emoji import {jobId} failed: {error}", {
        jobId,
        error,
      });
      const [failedJob] = await db
        .update(customEmojiImportJobs)
        .set({
          status: "failed",
          error:
            "The custom emoji import failed. Check the server logs for details.",
          completed: new Date(),
        })
        .where(
          and(
            eq(customEmojiImportJobs.id, jobId),
            eq(customEmojiImportJobs.status, "processing"),
          ),
        )
        .returning({
          archiveKey: customEmojiImportJobs.archiveKey,
        });

      if (failedJob == null) return;

      const { drive } = await import("./storage");
      await drive.use("emojiImports").delete(failedJob.archiveKey);
    },
  });

  async function enqueue(ctx: Context<void>, jobId: Uuid) {
    await ctx.enqueueTask(task, { jobId });
  }

  const STALE_PROCESSING_MS = 60 * 60 * 1000;
  async function recover(ctx: Context<void>) {
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);

    await db
      .update(customEmojiImportJobs)
      .set({
        status: "pending",
        processingStarted: null,
      })
      .where(
        and(
          eq(customEmojiImportJobs.status, "processing"),
          lt(customEmojiImportJobs.processingStarted, staleBefore),
        ),
      );

    const jobs = await db.query.customEmojiImportJobs.findMany({
      columns: { id: true },
      where: { status: { eq: "pending" } },
    });

    for (const job of jobs) {
      await enqueue(ctx, job.id);
    }
  }

  function decompressZip(
    archive: Uint8Array,
    {
      maxEntryCount,
      maxExtractedBytes,
    }: {
      maxEntryCount: number;
      maxExtractedBytes: number;
    },
  ): Promise<Record<string, Uint8Array>> {
    return new Promise((resolve, reject) => {
      const files: Record<string, Uint8Array> = {};
      const unzipper = new Unzip();
      let entryCount = 0;
      let extractedBytes = 0;
      let failed = false;

      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        reject(error);
      };

      unzipper.register(UnzipInflate);

      unzipper.onfile = (file) => {
        entryCount += 1;

        if (entryCount > maxEntryCount) {
          file.terminate();
          fail(new Error("ZIP contains too many entries"));
          return;
        }

        const entryPath = file.name.endsWith("/")
          ? file.name.slice(0, -1)
          : file.name;

        if (!isSafeArchivePath(entryPath)) {
          file.terminate();
          fail(new Error(`Unsafe ZIP entry path: ${file.name}`));
          return;
        }
        if (file.name.endsWith("/")) {
          return;
        }

        const chunks: Uint8Array[] = [];
        let fileBytes = 0;

        file.ondata = (error, chunk, final) => {
          if (failed) return;

          if (error != null) {
            fail(error);
            return;
          }

          fileBytes += chunk.byteLength;
          extractedBytes += chunk.byteLength;

          if (extractedBytes > maxExtractedBytes) {
            file.terminate();
            fail(new Error("ZIP expands beyond the allowed size"));
            return;
          }

          chunks.push(chunk);

          if (final) {
            const content = new Uint8Array(fileBytes);
            let offset = 0;

            for (const part of chunks) {
              content.set(part, offset);
              offset += part.byteLength;
            }

            files[file.name] = content;
          }
        };

        file.start();
      };

      try {
        const SLICE_BYTES = 64 * 1024;
        if (archive.byteLength === 0) {
          unzipper.push(archive, true);
        }
        for (
          let offset = 0;
          offset < archive.byteLength && !failed;
          offset += SLICE_BYTES
        ) {
          const end = Math.min(offset + SLICE_BYTES, archive.byteLength);
          unzipper.push(
            archive.subarray(offset, end),
            end === archive.byteLength,
          );
        }

        if (!failed) {
          resolve(files);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Invalid ZIP archive"));
      }
    });
  }

  function isSafeArchivePath(path: string): boolean {
    if (path.length === 0 || path.includes("\0")) {
      return false;
    }

    if (path.includes("\\") || /^[A-Za-z]:/.test(path)) {
      return false;
    }

    if (path.startsWith("/")) {
      return false;
    }

    return path
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== "..");
  }

  return { task, enqueue, recover };
}
