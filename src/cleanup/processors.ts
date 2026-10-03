import { createHash } from "node:crypto";

import { getLogger } from "@logtape/logtape";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { JobCancelledError, TerminalJobItemError } from "../background/errors";
import db from "../db";
import * as schema from "../schema";
import { drive } from "../storage";
import { STORAGE_URL_BASE } from "../storage-config";
import { type Uuid, uuid } from "../uuid";

const logger = getLogger(["hollo", "cleanup"]);

// Match exactly what writeCached() in src/proxy.ts mints: a sha256 hex digest
// (64 lowercase hex chars) under the "proxy/" prefix, suffixed with ".bin".
// Rejects path traversal (../) and any other shape we did not produce.
const PROXY_CACHE_BIN_KEY = /^proxy\/[0-9a-f]{64}\.bin$/;

interface ThumbnailCleanupItemData {
  kind?: "thumbnail";
  id: Uuid;
}

interface ProxyCacheCleanupItemData {
  kind: "proxy_cache";
  key: string;
}

const cleanupItemSchema = z.union([
  z.object({ kind: z.literal("thumbnail").optional(), id: uuid }),
  z.object({
    kind: z.literal("proxy_cache"),
    key: z.string().regex(PROXY_CACHE_BIN_KEY),
  }),
  z.object({ kind: z.literal("enumerate_proxy_cache") }),
]);

// Single entry point used by the worker.  The cleanup_thumbnails enum value
// historically meant "delete a Hollo-derived sharp thumbnail"; we now also
// queue proxy-cache files under it (distinguished by data.kind) so we don't
// need a schema migration for an extra enum value.
export async function processCleanupItem(
  item: schema.CleanupJobItem,
  check: () => Promise<void>,
  dispatch: () => Promise<void>,
): Promise<void> {
  await check();
  const parsed = cleanupItemSchema.safeParse(item.data);
  if (!parsed.success) throw new TerminalJobItemError(parsed.error.message);
  const data = parsed.data;
  if (data != null && data.kind === "proxy_cache") {
    await processProxyCacheDeletion(data, check);
    return;
  }
  if (data != null && data.kind === "enumerate_proxy_cache") {
    await processProxyCacheEnumeration(item, check, dispatch);
    return;
  }
  if (
    data == null ||
    (data.kind != null && data.kind !== "thumbnail") ||
    typeof (data as ThumbnailCleanupItemData).id !== "string"
  ) {
    throw new TerminalJobItemError("Invalid cleanup item data");
  }
  await processThumbnailDeletion(item, check);
}

export async function processThumbnailDeletion(
  item: schema.CleanupJobItem,
  check: () => Promise<void>,
): Promise<void> {
  const data = item.data as unknown as ThumbnailCleanupItemData;

  const medium = await db.query.media.findFirst({
    where: { id: { eq: data.id } },
  });

  if (medium == null) {
    throw new TerminalJobItemError(`medium missing in database: ${data.id}`);
  }

  if (STORAGE_URL_BASE == null) {
    throw new TerminalJobItemError("storage url is not configured");
  }

  const key = medium.thumbnailUrl.split("/").slice(-3).join("/");

  const reconstructedUrl = new URL(
    key,
    STORAGE_URL_BASE + (STORAGE_URL_BASE.endsWith("/") ? "" : "/"),
  ).toString();

  if (reconstructedUrl !== medium.thumbnailUrl) {
    if (!medium.thumbnailUrl.startsWith(STORAGE_URL_BASE)) {
      throw new TerminalJobItemError(
        `The thumbnail URL ${medium.thumbnailUrl} does not match the storage URL pattern ${STORAGE_URL_BASE}!`,
      );
    } else {
      throw new TerminalJobItemError(
        `The thumbnail URL ${medium.thumbnailUrl} is malformed.`,
      );
    }
  }

  const disk = drive.use();
  await check();
  await disk.delete(key);
  await check();
  await db
    .update(schema.media)
    .set({ thumbnailCleaned: true })
    .where(eq(schema.media.id, medium.id));
}

// Walks the proxy cache and enqueues one per-key deletion item per .bin
// entry under the same parent job.  Run by the worker (not by the admin
// request handler) so the dashboard POST stays responsive even on a
// multi-million-entry cache, and so the worker is the sole owner of the
// job lifecycle — that's what stops the previous "worker picks up an
// empty pending job and finalizes it mid-enqueue" race.
async function processProxyCacheEnumeration(
  item: schema.CleanupJobItem,
  check: () => Promise<void>,
  dispatch: () => Promise<void>,
): Promise<void> {
  const batch = new Set<string>();
  let added = 0;
  const flush = async () => {
    if (batch.size === 0) return;
    await check();
    const keys = [...batch];
    added += await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      const [job] = await tx
        .select()
        .from(schema.cleanupJobs)
        .where(eq(schema.cleanupJobs.id, item.jobId))
        .for("no key update");
      if (!job || !["pending", "processing"].includes(job.status))
        throw new JobCancelledError("Cleanup cancelled");
      // Include legacy random-ID children, including already deleted keys.
      const existing = await tx
        .select({ key: sql<string>`${schema.cleanupJobItems.data}->>'key'` })
        .from(schema.cleanupJobItems)
        .where(
          and(
            eq(schema.cleanupJobItems.jobId, item.jobId),
            sql`${schema.cleanupJobItems.data}->>'kind' = 'proxy_cache'`,
            sql`${schema.cleanupJobItems.data}->>'key' IN (${sql.join(
              keys.map((key) => sql`${key}`),
              sql`, `,
            )})`,
          ),
        );
      const known = new Set(existing.map((row) => row.key));
      const values = keys
        .filter((key) => !known.has(key))
        .map((key) => {
          const hash = createHash("sha256")
            .update(`${item.jobId}:${key}`)
            .digest("hex");
          const id =
            `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}` as Uuid;
          return { id, jobId: item.jobId, data: { kind: "proxy_cache", key } };
        });
      if (values.length === 0) return 0;
      await check();
      const inserted = await tx
        .insert(schema.cleanupJobItems)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: schema.cleanupJobItems.id });
      await tx
        .update(schema.cleanupJobs)
        .set({
          totalItems: sql`${schema.cleanupJobs.totalItems} + ${inserted.length}`,
        })
        .where(eq(schema.cleanupJobs.id, item.jobId));
      await check();
      return inserted.length;
    });
    batch.clear();
    await check();
    await dispatch();
  };
  for await (const key of iterateProxyCacheBinKeys()) {
    batch.add(key);
    if (batch.size >= 1000) await flush();
  }
  await flush();
  logger.info(
    "Enumerated proxy cache for cleanup job {jobId}: queued {count} items",
    { jobId: item.jobId, count: added },
  );
}

async function processProxyCacheDeletion(
  data: ProxyCacheCleanupItemData,
  check: () => Promise<void>,
): Promise<void> {
  if (typeof data.key !== "string" || !PROXY_CACHE_BIN_KEY.test(data.key)) {
    throw new TerminalJobItemError(
      `Invalid proxy cache key: ${String(data.key)}`,
    );
  }
  const disk = drive.use();
  const stem = data.key.slice(0, -".bin".length);
  // Deleting the body is required; we want a failed delete to surface as a
  // failed item so it can be retried, instead of being silently lost.
  await check();
  await disk.delete(`${stem}.bin`);
  // The JSON sidecar is best-effort: a previous partial cleanup may have
  // already removed it, and that should not flip the item to failed.
  await check();
  try {
    await disk.delete(`${stem}.json`);
  } catch (error) {
    logger.warn("Proxy cache sidecar delete failed for {key}: {error}", {
      key: `${stem}.json`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Streams every .bin entry currently in the proxy cache, one key at a time.
// Pages through every listing page so S3 buckets with more than one page are
// fully enumerated.  Yielding (instead of collecting into an array) keeps the
// dashboard count and the cleanup-job enqueue path constant-memory regardless
// of how large the cache has grown.
export async function* iterateProxyCacheBinKeys(): AsyncGenerator<
  string,
  void,
  void
> {
  const disk = drive.use();
  let paginationToken: string | undefined;
  do {
    const result = await disk.listAll("proxy/", {
      recursive: true,
      paginationToken,
    });
    for (const obj of result.objects) {
      if (obj.isFile && PROXY_CACHE_BIN_KEY.test(obj.key)) {
        yield obj.key;
      }
    }
    paginationToken = result.paginationToken;
  } while (paginationToken != null);
}

// Maximum value reported by countProxyCacheBinKeysBounded.  The dashboard
// only needs an order-of-magnitude indicator, so we stop the storage walk
// once we know there are at least this many entries instead of paging
// through every object on every page load.
export const PROXY_CACHE_COUNT_CAP = 10_000;

export interface ProxyCacheCountResult {
  count: number;
  truncated: boolean;
}

export async function countProxyCacheBinKeys(): Promise<ProxyCacheCountResult> {
  let count = 0;
  for await (const _key of iterateProxyCacheBinKeys()) {
    count++;
    if (count >= PROXY_CACHE_COUNT_CAP) return { count, truncated: true };
  }
  return { count, truncated: false };
}
