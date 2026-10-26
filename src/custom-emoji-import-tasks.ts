import { type Context, type Federation } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { and, eq, gt, lt, lte, sql } from "drizzle-orm";
import { Unzip, UnzipInflate } from "fflate";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { z } from "zod";

import {
  EMOJI_IMPORT_MAX_ENTRY_COUNT,
  EMOJI_IMPORT_MAX_EXTRACTED_BYTES,
} from "./custom-emoji-import-config";
import db from "./db";
import {
  customEmojiImportResultEnum,
  customEmojiImportJobs,
  customEmojiImportResults,
  customEmojis,
} from "./schema";
import { EMOJI_IMPORT_DISK } from "./storage-config";
import { uuid, uuidv7, type Uuid } from "./uuid";

const logger = getLogger(["hollo", "custom-emoji-imports"]);
const DISPATCH_RESERVATION_MS = 60_000;
const LEASE_DURATION_MS = 5 * 60_000;
const LEASE_HEARTBEAT_MS = 60_000;
const QUEUE_HIGH_WATER = 200;
const RECOVERY_BATCH = 100;

class LeaseLostError extends Error {
  constructor() {
    super("Custom emoji import lease was lost");
  }
}

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

export function registerCustomEmojiImports(
  federation: Federation<void>,
  queueDepth: () => Promise<number> = async () => 0,
) {
  let signal: AbortSignal | undefined;
  const leaseTimers = new Map<Uuid, ReturnType<typeof setInterval>>();
  const lostAttempts = new Set<Uuid>();

  function stopLease(attemptToken: Uuid) {
    const timer = leaseTimers.get(attemptToken);
    if (timer != null) clearInterval(timer);
    leaseTimers.delete(attemptToken);
  }

  async function renewLease(jobId: Uuid, attemptToken: Uuid) {
    const [renewed] = await db
      .update(customEmojiImportJobs)
      .set({ leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS) })
      .where(
        and(
          eq(customEmojiImportJobs.id, jobId),
          eq(customEmojiImportJobs.status, "processing"),
          eq(customEmojiImportJobs.attemptToken, attemptToken),
          gt(customEmojiImportJobs.leaseExpiresAt, new Date()),
        ),
      )
      .returning({ id: customEmojiImportJobs.id });
    if (renewed != null) return;
    lostAttempts.add(attemptToken);
    stopLease(attemptToken);
  }

  function startLease(jobId: Uuid, attemptToken: Uuid) {
    const timer = setInterval(() => {
      void renewLease(jobId, attemptToken).catch((error) => {
        lostAttempts.add(attemptToken);
        stopLease(attemptToken);
        logger.error(
          "Failed to renew custom emoji import {jobId} lease: {error}",
          {
            jobId,
            error,
          },
        );
      });
    }, LEASE_HEARTBEAT_MS);
    timer.unref();
    leaseTimers.set(attemptToken, timer);
  }

  function check(attemptToken: Uuid) {
    signal?.throwIfAborted();
    if (lostAttempts.has(attemptToken)) throw new LeaseLostError();
  }
  const task = federation.defineTask("hollo.custom-emoji-import.v1", {
    schema: z.object({
      jobId: uuid,
      attemptToken: uuid,
    }),
    retryPolicy: () => null,

    handler: async (_ctx, { jobId, attemptToken }) => {
      if (signal?.aborted) return;
      const [job] = await db
        .update(customEmojiImportJobs)
        .set({
          status: "processing",
          processingStarted: new Date(),
          leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
        })
        .where(
          and(
            eq(customEmojiImportJobs.id, jobId),
            eq(customEmojiImportJobs.status, "pending"),
            eq(customEmojiImportJobs.attemptToken, attemptToken),
          ),
        )
        .returning();

      if (job == null) {
        return;
      }
      const existingResults = await db
        .select({
          entryIndex: customEmojiImportResults.entryIndex,
          normalizedShortcode: customEmojiImportResults.normalizedShortcode,
          reason: customEmojiImportResults.reason,
        })
        .from(customEmojiImportResults)
        .where(eq(customEmojiImportResults.jobId, jobId));
      startLease(jobId, attemptToken);
      check(attemptToken);
      const { drive } = await import("./storage");
      const archiveDisk = drive.use("emojiImports");
      const archive = await archiveDisk.getBytes(job.archiveKey);
      check(attemptToken);

      const files = await decompressZip(archive, {
        maxEntryCount: EMOJI_IMPORT_MAX_ENTRY_COUNT,
        maxExtractedBytes: EMOJI_IMPORT_MAX_EXTRACTED_BYTES,
      });
      check(attemptToken);
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

      const completedEntryIndexes = new Set<number>();
      const importedEntryIndexes = new Map<string, number>();
      let importedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;

      for (const result of existingResults) {
        completedEntryIndexes.add(result.entryIndex);
        if (result.reason === "imported") {
          importedCount += 1;
          importedEntryIndexes.set(
            result.normalizedShortcode,
            result.entryIndex,
          );
        } else if (
          result.reason === "duplicate_existing" ||
          result.reason === "duplicate_in_pack" ||
          result.reason === "not_downloaded"
        ) {
          skippedCount += 1;
        } else {
          failedCount += 1;
        }
      }

      async function saveProgress() {
        check(attemptToken);
        const [saved] = await db
          .update(customEmojiImportJobs)
          .set({
            importedCount,
            skippedCount,
            failedCount,
          })
          .where(
            and(
              eq(customEmojiImportJobs.id, jobId),
              eq(customEmojiImportJobs.status, "processing"),
              eq(customEmojiImportJobs.attemptToken, attemptToken),
              gt(customEmojiImportJobs.leaseExpiresAt, new Date()),
            ),
          )
          .returning({ id: customEmojiImportJobs.id });
        if (saved != null) return;
        lostAttempts.add(attemptToken);
        throw new LeaseLostError();
      }

      async function recordResult(
        entryIndex: number,
        originalShortcode: string,
        normalizedShortcode: string,
        reason: (typeof customEmojiImportResultEnum.enumValues)[number],
        conflictingEntryIndex: number | null = null,
      ) {
        check(attemptToken);
        await db.transaction(async (tx) => {
          const [owned] = await tx
            .select({ id: customEmojiImportJobs.id })
            .from(customEmojiImportJobs)
            .where(
              and(
                eq(customEmojiImportJobs.id, jobId),
                eq(customEmojiImportJobs.status, "processing"),
                eq(customEmojiImportJobs.attemptToken, attemptToken),
                gt(customEmojiImportJobs.leaseExpiresAt, new Date()),
              ),
            )
            .for("no key update");
          if (owned == null) throw new LeaseLostError();
          await tx.insert(customEmojiImportResults).values({
            id: uuidv7(),
            jobId,
            entryIndex,
            originalShortcode,
            normalizedShortcode,
            reason,
            conflictingEntryIndex,
          });
        });
      }

      const allowedTypes = new Set([
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
      ]);

      for (const [entryIndex, entry] of meta.emojis.entries()) {
        check(attemptToken);
        if (completedEntryIndexes.has(entryIndex)) continue;
        const originalShortcode = entry.emoji.name;
        const shortcode = entry.emoji.name.toLowerCase();
        const category = entry.emoji.category?.trim() || null;

        if (!entry.downloaded) {
          await recordResult(
            entryIndex,
            originalShortcode,
            shortcode,
            "not_downloaded",
          );
          skippedCount += 1;
          await saveProgress();
          continue;
        }

        if (!isSafeArchivePath(entry.fileName)) {
          await recordResult(
            entryIndex,
            originalShortcode,
            shortcode,
            "unsafe_file_path",
          );
          failedCount += 1;
          await saveProgress();
          continue;
        }

        const imagePath = archivePrefix + entry.fileName;

        if (!Object.hasOwn(files, imagePath)) {
          logger.warn("Image is missing from emoji archive: {fileName}", {
            fileName: entry.fileName,
          });
          await recordResult(
            entryIndex,
            originalShortcode,
            shortcode,
            "image_missing",
          );
          failedCount += 1;
          await saveProgress();
          continue;
        }

        const content = files[imagePath];
        if (content == null) {
          logger.warn("Image is missing from emoji archive: {fileName}", {
            fileName: entry.fileName,
          });
          await recordResult(
            entryIndex,
            originalShortcode,
            shortcode,
            "image_missing",
          );
          failedCount += 1;
          await saveProgress();
          continue;
        }

        if (!/^[-a-z0-9_]{1,255}$/.test(shortcode)) {
          logger.warn("Invalid emoji shortcode: {shortcode}", {
            shortcode: originalShortcode,
          });
          await recordResult(
            entryIndex,
            originalShortcode,
            shortcode,
            "invalid_shortcode",
          );
          failedCount += 1;
          await saveProgress();
          continue;
        }

        const MAX_EMOJI_BYTES = 32 * 1024 * 1024;
        const MAX_EMOJI_PIXELS = 16_000_000;

        let fileType: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
        let imageFailureReason:
          | "unsupported_image_type"
          | "image_too_large"
          | "invalid_or_corrupt_image"
          | undefined;

        try {
          fileType = await fileTypeFromBuffer(content);

          if (fileType == null || !allowedTypes.has(fileType.mime)) {
            imageFailureReason = "unsupported_image_type";
          } else if (content.byteLength > MAX_EMOJI_BYTES) {
            imageFailureReason = "image_too_large";
          } else {
            await sharp(content, {
              limitInputPixels: MAX_EMOJI_PIXELS,
            }).toBuffer();
          }
        } catch (error) {
          if (error instanceof LeaseLostError || signal?.aborted) throw error;
          imageFailureReason = "invalid_or_corrupt_image";
        }

        if (imageFailureReason != null) {
          if (imageFailureReason === "unsupported_image_type") {
            logger.warn("Unsupported emoji image: {fileName}", {
              fileName: entry.fileName,
            });
          } else if (imageFailureReason === "image_too_large") {
            logger.warn("Emoji image is too large: {fileName}", {
              fileName: entry.fileName,
            });
          } else {
            logger.warn("Invalid or corrupt emoji image: {fileName}", {
              fileName: entry.fileName,
            });
          }
          await recordResult(
            entryIndex,
            originalShortcode,
            shortcode,
            imageFailureReason,
          );
          failedCount += 1;
          await saveProgress();
          continue;
        }

        if (fileType == null) {
          throw new Error("Emoji image type is unexpectedly missing");
        }
        check(attemptToken);

        const conflictingEntryIndex = importedEntryIndexes.get(shortcode);

        if (conflictingEntryIndex != null) {
          await recordResult(
            entryIndex,
            originalShortcode,
            shortcode,
            "duplicate_in_pack",
            conflictingEntryIndex,
          );

          skippedCount += 1;
          await saveProgress();
          continue;
        }

        const imageKey = `emojis/${jobId}/${entryIndex}.${fileType.ext}`;
        let storedImage = false;

        try {
          const result = await db.transaction(async (tx) => {
            const [owned] = await tx
              .select({ id: customEmojiImportJobs.id })
              .from(customEmojiImportJobs)
              .where(
                and(
                  eq(customEmojiImportJobs.id, jobId),
                  eq(customEmojiImportJobs.status, "processing"),
                  eq(customEmojiImportJobs.attemptToken, attemptToken),
                  gt(customEmojiImportJobs.leaseExpiresAt, new Date()),
                ),
              )
              .for("no key update");
            if (owned == null) throw new LeaseLostError();
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${shortcode}))`,
            );

            const [existing] = await tx
              .select({ shortcode: customEmojis.shortcode })
              .from(customEmojis)
              .where(eq(customEmojis.shortcode, shortcode))
              .limit(1);

            if (existing != null) {
              await tx.insert(customEmojiImportResults).values({
                id: uuidv7(),
                jobId,
                entryIndex,
                originalShortcode,
                normalizedShortcode: shortcode,
                reason: "duplicate_existing",
                conflictingEntryIndex: null,
              });

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

            await tx.insert(customEmojiImportResults).values({
              id: uuidv7(),
              jobId,
              entryIndex,
              originalShortcode,
              normalizedShortcode: shortcode,
              reason: "imported",
              conflictingEntryIndex: null,
            });

            return "imported";
          });

          if (result === "skipped") {
            logger.info("Skipped duplicate emoji shortcode: {shortcode}", {
              shortcode,
            });
            skippedCount += 1;
            await saveProgress();
          } else {
            importedEntryIndexes.set(shortcode, entryIndex);
            importedCount += 1;
            await saveProgress();
          }
        } catch (error) {
          if (error instanceof LeaseLostError || signal?.aborted) throw error;
          logger.error("Failed to import emoji {shortcode}: {error}", {
            shortcode,
            error,
          });

          if (storedImage) {
            try {
              await imageDisk.delete(imageKey);
            } catch (deleteError) {
              logger.error(
                "Failed to delete image after emoji import failure {shortcode}: {error}",
                {
                  shortcode,
                  error: deleteError,
                },
              );
            }
          }

          await recordResult(
            entryIndex,
            originalShortcode,
            shortcode,
            "import_failed",
          );
          failedCount += 1;
          await saveProgress();
        }
      }
      check(attemptToken);
      const [completedJob] = await db
        .update(customEmojiImportJobs)
        .set({
          status: "completed",
          importedCount: importedCount,
          skippedCount: skippedCount,
          failedCount: failedCount,
          completed: new Date(),
          attemptToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(customEmojiImportJobs.id, jobId),
            eq(customEmojiImportJobs.status, "processing"),
            eq(customEmojiImportJobs.attemptToken, attemptToken),
            gt(customEmojiImportJobs.leaseExpiresAt, new Date()),
          ),
        )
        .returning();
      if (completedJob == null) {
        lostAttempts.add(attemptToken);
        throw new LeaseLostError();
      }
      stopLease(attemptToken);
      try {
        await archiveDisk.delete(job.archiveKey);
      } catch (error) {
        logger.error(
          "Failed to delete custom emoji import archive {archiveKey}: {error}",
          { archiveKey: job.archiveKey, error },
        );
      }
    },

    onError: async (_ctx, error, { jobId, attemptToken }) => {
      stopLease(attemptToken);
      if (signal?.aborted || error instanceof LeaseLostError) return;
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
          attemptToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(customEmojiImportJobs.id, jobId),
            eq(customEmojiImportJobs.status, "processing"),
            eq(customEmojiImportJobs.attemptToken, attemptToken),
            gt(customEmojiImportJobs.leaseExpiresAt, new Date()),
          ),
        )
        .returning({
          archiveKey: customEmojiImportJobs.archiveKey,
        });

      if (failedJob == null) return;
    },
  });

  async function enqueue(ctx: Context<void>, jobId: Uuid) {
    if (signal?.aborted || (await queueDepth()) >= QUEUE_HIGH_WATER) return;
    const attemptToken = uuidv7();
    const now = new Date();
    const [reserved] = await db
      .update(customEmojiImportJobs)
      .set({
        attemptToken,
        nextDispatchAt: new Date(now.getTime() + DISPATCH_RESERVATION_MS),
      })
      .where(
        and(
          eq(customEmojiImportJobs.id, jobId),
          eq(customEmojiImportJobs.status, "pending"),
          lte(customEmojiImportJobs.nextDispatchAt, now),
        ),
      )
      .returning({ id: customEmojiImportJobs.id });
    if (reserved == null) return;
    await ctx.enqueueTask(task, { jobId, attemptToken });
  }

  async function recover(ctx: Context<void>) {
    if (signal?.aborted) return;
    await cleanupExpiredFailedImports();
    if (signal?.aborted) return;

    await db
      .update(customEmojiImportJobs)
      .set({
        status: "pending",
        processingStarted: null,
        attemptToken: null,
        leaseExpiresAt: null,
        nextDispatchAt: new Date(),
      })
      .where(
        and(
          eq(customEmojiImportJobs.status, "processing"),
          lt(customEmojiImportJobs.leaseExpiresAt, new Date()),
        ),
      );

    const jobs = await db
      .select({ id: customEmojiImportJobs.id })
      .from(customEmojiImportJobs)
      .where(
        and(
          eq(customEmojiImportJobs.status, "pending"),
          lte(customEmojiImportJobs.nextDispatchAt, new Date()),
        ),
      )
      .limit(RECOVERY_BATCH);

    for (const job of jobs) {
      if (signal?.aborted) return;
      await enqueue(ctx, job.id);
    }
  }

  const FAILED_IMPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  const FAILED_IMPORT_CLEANUP_BATCH = 100;
  async function cleanupExpiredFailedImports() {
    if (signal?.aborted || EMOJI_IMPORT_DISK == null) return;
    const expiredBefore = new Date(Date.now() - FAILED_IMPORT_RETENTION_MS);

    const jobs = await db
      .select({
        id: customEmojiImportJobs.id,
        archiveKey: customEmojiImportJobs.archiveKey,
      })
      .from(customEmojiImportJobs)
      .where(
        and(
          eq(customEmojiImportJobs.status, "failed"),
          lt(customEmojiImportJobs.completed, expiredBefore),
        ),
      )
      .limit(FAILED_IMPORT_CLEANUP_BATCH);

    const { drive } = await import("./storage");
    const archiveDisk = drive.use("emojiImports");

    for (const job of jobs) {
      if (signal?.aborted) return;
      try {
        await archiveDisk.delete(job.archiveKey);

        await db
          .delete(customEmojiImportJobs)
          .where(
            and(
              eq(customEmojiImportJobs.id, job.id),
              eq(customEmojiImportJobs.status, "failed"),
            ),
          );
      } catch (error) {
        logger.error(
          "Failed to clean up expired custom emoji import {jobId}: {error}",
          { jobId: job.id, error },
        );
      }
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
      const files: Record<string, Uint8Array> = Object.create(null);
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
        const entryPath = file.name.endsWith("/")
          ? file.name.slice(0, -1)
          : file.name;

        if (!isSafeArchivePath(entryPath)) {
          file.terminate();
          fail(new Error(`Unsafe ZIP entry path: ${file.name}`));
          return;
        }

        const isDirectory = file.name.endsWith("/");
        const isMacOsMetadata = file.name.startsWith("__MACOSX/");
        const isMetaFile =
          entryPath === "meta.json" || entryPath.endsWith("/meta.json");

        if (!isDirectory && !isMacOsMetadata && !isMetaFile) {
          entryCount += 1;

          if (entryCount > maxEntryCount) {
            file.terminate();
            fail(new Error("ZIP contains too many entries"));
            return;
          }
        }

        if (isDirectory || isMacOsMetadata) {
          return;
        }

        if (
          file.originalSize != null &&
          file.originalSize > maxExtractedBytes - extractedBytes
        ) {
          file.terminate();
          fail(new Error("ZIP expands beyond the allowed size"));
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
        const SLICE_BYTES = 8 * 1024;
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

  return {
    task,
    enqueue,
    recover,
    setSignal(value: AbortSignal) {
      signal = value;
    },
  };
}
