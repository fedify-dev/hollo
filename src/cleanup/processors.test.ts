import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import db from "../db";
import * as schema from "../schema";
import { drive } from "../storage";
import { uuidv7 } from "../uuid";
import { processCleanupItem } from "./processors";

beforeEach(async () => {
  await cleanDatabase();
  drive.fake();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await drive.use().deleteAll();
  drive.restore();
});

async function enumeration() {
  const jobId = uuidv7();
  await db
    .insert(schema.cleanupJobs)
    .values({ id: jobId, category: "cleanup_thumbnails", totalItems: 1 });
  return (
    await db
      .insert(schema.cleanupJobItems)
      .values({ id: uuidv7(), jobId, data: { kind: "enumerate_proxy_cache" } })
      .returning()
  )[0];
}
function key(index: number) {
  return `proxy/${index.toString(16).padStart(64, "0")}.bin`;
}
const check = async () => {};

it("streams multiple listing pages, deduplicates legacy keys, and resumes failed enumeration", async () => {
  const item = await enumeration();
  await db.insert(schema.cleanupJobItems).values({
    id: uuidv7(),
    jobId: item.jobId,
    data: { kind: "proxy_cache", key: key(0) },
  });
  await db.update(schema.cleanupJobs).set({ totalItems: 2 });
  const disk = drive.use();
  type Listing = Awaited<ReturnType<typeof disk.listAll>>;
  const listing = (start: number, count: number, paginationToken?: string) =>
    ({
      objects: Array.from({ length: count }, (_, index) => ({
        key: key(start + index),
        isFile: true,
      })),
      paginationToken,
    }) as Listing;
  const list = vi.spyOn(disk, "listAll");
  list
    .mockResolvedValueOnce(listing(0, 1001, "second"))
    .mockRejectedValueOnce(new Error("S3 unavailable"));
  const dispatch = vi.fn(async () => {});
  await expect(processCleanupItem(item, check, dispatch)).rejects.toThrow(
    "S3 unavailable",
  );
  expect(await db.select().from(schema.cleanupJobItems)).toHaveLength(1001);
  expect((await db.select().from(schema.cleanupJobs))[0].totalItems).toBe(1001);
  list
    .mockResolvedValueOnce(listing(0, 1001, "second"))
    .mockResolvedValueOnce(listing(1001, 3));
  await processCleanupItem(item, check, dispatch);
  expect(await db.select().from(schema.cleanupJobItems)).toHaveLength(1005);
  expect((await db.select().from(schema.cleanupJobs))[0].totalItems).toBe(1005);
  expect(dispatch).toHaveBeenCalled();
  expect(list).toHaveBeenLastCalledWith("proxy/", {
    recursive: true,
    paginationToken: "second",
  });
});

it.each([false, true])(
  "bounds enumeration status queries while preserving cancellation between batches (cancel: %s)",
  async (cancel) => {
    const item = await enumeration();
    const disk = drive.use();
    vi.spyOn(disk, "listAll").mockResolvedValue({
      objects: Array.from({ length: 2500 }, (_, index) => ({
        key: key(index),
        isFile: true,
      })),
    } as Awaited<ReturnType<typeof disk.listAll>>);
    const guard = vi.fn(async () => {
      const [job] = await db
        .select({ status: schema.cleanupJobs.status })
        .from(schema.cleanupJobs)
        .where(eq(schema.cleanupJobs.id, item.jobId));
      if (job.status === "cancelled") throw new Error("Cleanup cancelled");
    });
    const dispatch = vi.fn(async () => {
      if (cancel)
        await db
          .update(schema.cleanupJobs)
          .set({ status: "cancelled" })
          .where(eq(schema.cleanupJobs.id, item.jobId));
    });
    const error = await processCleanupItem(item, guard, dispatch).then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(error).toBe(cancel ? "Cleanup cancelled" : undefined);
    expect(guard.mock.calls.length).toBeLessThan(20);
    expect(await db.select().from(schema.cleanupJobItems)).toHaveLength(
      cancel ? 1001 : 2501,
    );
    expect((await db.select().from(schema.cleanupJobs))[0].totalItems).toBe(
      cancel ? 1001 : 2501,
    );
    expect(dispatch).toHaveBeenCalledTimes(cancel ? 1 : 3);
  },
);

it("deletes actual filesystem proxy bodies and sidecars idempotently", async () => {
  const item = await enumeration();
  const disk = drive.use();
  const path = key(1);
  const sidecar = path.replace(/\.bin$/, ".json");
  await disk.put(path, "cached body");
  await disk.put(sidecar, "{}");
  const deletion = { ...item, data: { kind: "proxy_cache", key: path } };
  await processCleanupItem(deletion, check, check);
  await processCleanupItem(deletion, check, check);
  expect(await disk.exists(path)).toBe(false);
  expect(await disk.exists(sidecar)).toBe(false);
});

it("cancellation during enumeration prevents further batch insertion", async () => {
  const item = await enumeration();
  const disk = drive.use();
  vi.spyOn(disk, "listAll").mockImplementation(async () => {
    await db
      .update(schema.cleanupJobs)
      .set({ status: "cancelled" })
      .where(eq(schema.cleanupJobs.id, item.jobId));
    return { objects: [{ key: key(1), isFile: true }] } as Awaited<
      ReturnType<typeof disk.listAll>
    >;
  });
  await expect(processCleanupItem(item, check, check)).rejects.toThrow(
    "Cleanup cancelled",
  );
  expect(await db.select().from(schema.cleanupJobItems)).toHaveLength(1);
  expect((await db.select().from(schema.cleanupJobs))[0].totalItems).toBe(1);
});

it("deletes filesystem thumbnails and preserves completion on replay", async () => {
  const { STORAGE_URL_BASE } = await import("../storage-config");
  const item = await enumeration();
  const disk = drive.use();
  const id = uuidv7();
  const path = "thumbnails/ab/test.webp";
  await disk.put(path, "thumbnail");
  await db.insert(schema.media).values({
    id,
    type: "image/webp",
    url: "https://remote.test/original",
    width: 10,
    height: 10,
    thumbnailType: "image/webp",
    thumbnailUrl: new URL(path, STORAGE_URL_BASE!.replace(/\/$/, "") + "/")
      .href,
    thumbnailWidth: 10,
    thumbnailHeight: 10,
  });
  await processCleanupItem({ ...item, data: { id } }, check, check);
  await processCleanupItem({ ...item, data: { id } }, check, check);
  expect(await disk.exists(path)).toBe(false);
  expect((await db.select().from(schema.media))[0].thumbnailCleaned).toBe(true);
});

it.each(["lookup", "delete"])(
  "stops thumbnail mutations after ownership loss during %s",
  async (phase) => {
    const { STORAGE_URL_BASE } = await import("../storage-config");
    const item = await enumeration();
    const disk = drive.use();
    const id = uuidv7();
    const path = "thumbnails/ab/lost.webp";
    await disk.put(path, "thumbnail");
    await db.insert(schema.media).values({
      id,
      type: "image/webp",
      url: "https://remote.test/original",
      width: 10,
      height: 10,
      thumbnailType: "image/webp",
      thumbnailUrl: new URL(path, STORAGE_URL_BASE!.replace(/\/$/, "") + "/")
        .href,
      thumbnailWidth: 10,
      thumbnailHeight: 10,
    });
    let lost = false;
    const find = db.query.media.findFirst.bind(db.query.media);
    if (phase === "lookup") {
      vi.spyOn(db.query.media, "findFirst").mockImplementation(
        // @ts-expect-error The mocked Promise remains await-compatible.
        async (...args) => {
          const result = await find(...args);
          lost = true;
          return result;
        },
      );
    }
    const originalDelete = disk.delete.bind(disk);
    const deletion = vi
      .spyOn(disk, "delete")
      .mockImplementation(async (key) => {
        await originalDelete(key);
        lost = true;
      });
    const guard = async () => {
      if (lost) throw new Error("lease lost");
    };
    await expect(
      processCleanupItem({ ...item, data: { id } }, guard, check),
    ).rejects.toThrow("lease lost");
    expect(deletion).toHaveBeenCalledTimes(phase === "lookup" ? 0 : 1);
    expect((await db.select().from(schema.media))[0].thumbnailCleaned).toBe(
      false,
    );
  },
);

it("does not start sidecar deletion after losing ownership during body deletion", async () => {
  const item = await enumeration();
  const disk = drive.use();
  const path = key(8);
  const sidecar = path.replace(/\.bin$/, ".json");
  await disk.put(path, "body");
  await disk.put(sidecar, "{}");
  let lost = false;
  const originalDelete = disk.delete.bind(disk);
  vi.spyOn(disk, "delete").mockImplementation(async (key) => {
    await originalDelete(key);
    lost = true;
  });
  const guard = async () => {
    if (lost) throw new Error("lease lost");
  };
  await expect(
    processCleanupItem(
      { ...item, data: { kind: "proxy_cache", key: path } },
      guard,
      check,
    ),
  ).rejects.toThrow("lease lost");
  expect(await disk.exists(path)).toBe(false);
  expect(await disk.exists(sidecar)).toBe(true);
});
