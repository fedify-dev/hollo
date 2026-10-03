import { readFile } from "node:fs/promises";

import {
  createFederation,
  MemoryKvStore,
  type Message,
  type MessageQueue,
  type MessageQueueEnqueueOptions,
} from "@fedify/fedify";
import { Block, Follow } from "@fedify/vocab";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import * as cleanupWorker from "../cleanup/worker";
import db from "../db";
import realFederation from "../federation/federation";
import * as schema from "../schema";
import { uuidv7 } from "../uuid";
import { TerminalJobItemError } from "./errors";
import { registerBackgroundJobs } from "./jobs";
import { itemLeases, ItemLeasePool } from "./lease";

class TestQueue implements MessageQueue {
  messages: Message[] = [];
  options: Array<MessageQueueEnqueueOptions | undefined> = [];
  fail = false;
  async enqueue(message: Message, options?: MessageQueueEnqueueOptions) {
    if (this.fail) throw new Error("queue offline");
    this.messages.push(message);
    this.options.push(options);
  }
  async listen() {}
  take(name: string) {
    const index = this.messages.findIndex(
      (message) => message.type === "task" && message.taskName === name,
    );
    if (index < 0) throw new Error(`No message ${name}`);
    return this.messages.splice(index, 1)[0];
  }
}
function fixture() {
  const queue = new TestQueue();
  const federation = createFederation<void>({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
  });
  const jobs = registerBackgroundJobs(
    federation,
    async () => queue.messages.length,
  );
  const ctx = federation.createContext(
    new URL("https://hollo.test"),
    undefined,
  );
  const dispatch = () =>
    federation.processQueuedTask(
      undefined,
      queue.take("hollo.cleanup-dispatch.v1"),
    );
  const item = () =>
    federation.processQueuedTask(
      undefined,
      queue.take("hollo.cleanup-item.v1"),
    );
  return { queue, federation, jobs, ctx, dispatch, item };
}
async function job(count = 1, status: "pending" | "processing" = "pending") {
  const jobId = uuidv7();
  const items = Array.from({ length: count }, () => ({
    id: uuidv7(),
    jobId,
    status,
    data: { kind: "enumerate_proxy_cache" },
  }));
  await db.transaction(async (tx) => {
    await tx.insert(schema.cleanupJobs).values({
      id: jobId,
      category: "cleanup_thumbnails",
      totalItems: count,
      status,
    });
    await tx.insert(schema.cleanupJobItems).values(items);
  });
  return { jobId, items };
}
async function state(jobId: ReturnType<typeof uuidv7>) {
  return (
    await db
      .select()
      .from(schema.cleanupJobs)
      .where(eq(schema.cleanupJobs.id, jobId))
  )[0];
}

beforeEach(async () => {
  await cleanDatabase();
  vi.restoreAllMocks();
  vi.spyOn(cleanupWorker, "executeCleanupItem").mockResolvedValue(undefined);
});
afterAll(async () => {
  await itemLeases.close();
});

describe("background job tasks", () => {
  it("round-trips IDs through Fedify and counts duplicate tasks only once", async () => {
    const f = fixture();
    const j = await job();
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    const message = f.queue.take("hollo.cleanup-item.v1");
    await f.federation.processQueuedTask(undefined, message);
    await f.federation.processQueuedTask(undefined, message);
    await f.dispatch();
    expect(cleanupWorker.executeCleanupItem).toHaveBeenCalledTimes(1);
    expect(await state(j.jobId)).toMatchObject({
      status: "completed",
      processedItems: 1,
      successfulItems: 1,
      failedItems: 0,
    });
  });

  it("does not reclaim a live attempt during duplicate delivery or recovery", async () => {
    const f = fixture();
    const j = await job(1, "processing");
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(cleanupWorker.executeCleanupItem).mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    const message = f.queue.take("hollo.cleanup-item.v1");
    const first = f.federation.processQueuedTask(undefined, message);
    await entered;
    await f.federation.processQueuedTask(undefined, message);
    await f.jobs.recover(f.ctx);
    await f.dispatch();
    expect(cleanupWorker.executeCleanupItem).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(await state(j.jobId)).toMatchObject({
      processedItems: 1,
      successfulItems: 1,
    });
  });

  it("recovers a commit followed by failed enqueue without TTL deduplication", async () => {
    const f = fixture();
    const j = await job();
    f.queue.fail = true;
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    expect((await state(j.jobId)).status).toBe("pending");
    f.queue.fail = false;
    await f.jobs.recover(f.ctx);
    await f.dispatch();
    await f.item();
    expect((await state(j.jobId)).successfulItems).toBe(1);
  });

  it("recovers lost item messages after dispatch reservations expire", async () => {
    const f = fixture();
    const j = await job();
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    f.queue.messages = [];
    await db
      .update(schema.cleanupJobItems)
      .set({ nextDispatchAt: new Date(0) });
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    await f.item();
    expect((await state(j.jobId)).successfulItems).toBe(1);
  });

  it("retries transient failures and records one terminal failure on exhaustion", async () => {
    const f = fixture();
    const j = await job();
    vi.mocked(cleanupWorker.executeCleanupItem).mockRejectedValue(
      new Error("storage unavailable"),
    );
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    for (let attempt = 0; attempt < 5; attempt++) {
      await db
        .update(schema.cleanupJobItems)
        .set({ nextAttemptAt: new Date(0) });
      await f.item();
      expect((await state(j.jobId)).failedItems).toBe(attempt === 4 ? 1 : 0);
    }
    expect(await state(j.jobId)).toMatchObject({
      processedItems: 1,
      failedItems: 1,
      successfulItems: 0,
    });
    expect(
      f.queue.options.some((options) => options?.delay?.total("seconds") === 5),
    ).toBe(true);
  });

  it("fails terminal input errors immediately", async () => {
    const f = fixture();
    const j = await job();
    vi.mocked(cleanupWorker.executeCleanupItem).mockRejectedValue(
      new TerminalJobItemError("invalid key"),
    );
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    await f.item();
    expect(await state(j.jobId)).toMatchObject({
      failedItems: 1,
      processedItems: 1,
    });
    expect(
      f.queue.messages.filter(
        (message) =>
          message.type === "task" &&
          message.taskName === "hollo.cleanup-item.v1",
      ),
    ).toHaveLength(0);
  });

  it("cancellation stops unstarted work while a running action can finish", async () => {
    const f = fixture();
    const j = await job(2);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(cleanupWorker.executeCleanupItem).mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    const running = f.item();
    await entered;
    await db
      .update(schema.cleanupJobs)
      .set({ status: "cancelled" })
      .where(eq(schema.cleanupJobs.id, j.jobId));
    await f.item();
    release();
    await running;
    expect(cleanupWorker.executeCleanupItem).toHaveBeenCalledTimes(1);
    expect(await state(j.jobId)).toMatchObject({
      status: "cancelled",
      successfulItems: 1,
      processedItems: 1,
    });
  });

  it("shutdown leaves interrupted work recoverable", async () => {
    const f = fixture();
    const j = await job();
    const controller = new AbortController();
    f.jobs.setSignal(controller.signal);
    vi.mocked(cleanupWorker.executeCleanupItem).mockImplementation(
      async (_item, check) => {
        controller.abort();
        await check();
      },
    );
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    await f.item();
    expect(await state(j.jobId)).toMatchObject({
      successfulItems: 0,
      failedItems: 0,
    });
    expect((await db.select().from(schema.cleanupJobItems))[0]).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });

  it("keeps fanout inside a 50-item window and reaches later items", async () => {
    const f = fixture();
    const j = await job(65);
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    expect(f.queue.messages).toHaveLength(50);
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    expect(f.queue.messages).toHaveLength(50);
    await f.item();
    await f.dispatch();
    expect(f.queue.messages).toHaveLength(50);
    expect((await state(j.jobId)).successfulItems).toBe(1);
  });

  it("bounded recovery rotates beyond the first hundred jobs", async () => {
    const f = fixture();
    const values = Array.from({ length: 105 }, () => ({
      id: uuidv7(),
      category: "cleanup_thumbnails" as const,
    }));
    await db.insert(schema.cleanupJobs).values(values);
    await f.jobs.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(100);
    await f.jobs.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(105);
  });

  it("diagnoses a legacy partial batch instead of silently completing", async () => {
    const f = fixture();
    const j = await job();
    await db.update(schema.cleanupJobs).set({ totalItems: 2 });
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    await f.dispatch();
    expect(await state(j.jobId)).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("Incomplete legacy"),
    });
    expect(cleanupWorker.executeCleanupItem).not.toHaveBeenCalled();
  });

  it("dropped malformed/unknown messages leave rows eligible for recovery", async () => {
    const f = fixture();
    const j = await job();
    await f.jobs.enqueueJob(f.ctx, "cleanup", j.jobId);
    const message = f.queue.take("hollo.cleanup-dispatch.v1");
    if (message.type !== "task") throw new Error("Expected task");
    await f.federation.processQueuedTask(undefined, {
      ...message,
      taskName: "unknown",
    });
    await f.federation.processQueuedTask(undefined, {
      ...message,
      data: "invalid codec",
    });
    await f.jobs.recover(f.ctx);
    await f.dispatch();
    await f.item();
    expect((await state(j.jobId)).successfulItems).toBe(1);
  });
});

it("connection loss keeps the lease slot until actual work settles and forbids stale writes", async () => {
  const pool = new ItemLeasePool(1);
  let release!: () => void;
  let entered!: (pid: number) => void;
  let leaseLost!: () => boolean;
  const started = new Promise<number>((resolve) => {
    entered = resolve;
  });
  const first = pool.run(async (lease) => {
    const [row] = await lease.db.execute<{ pid: number }>(
      sql`select pg_backend_pid() as pid`,
    );
    leaseLost = () => lease.lost;
    entered(row.pid);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await lease.db.execute(sql`select 1`);
  });
  const firstResult = first.catch((error: unknown) => error);
  const pid = await started;
  await db.execute(sql`select pg_terminate_backend(${pid})`);
  await vi.waitFor(() => {
    expect(leaseLost()).toBe(true);
  });
  let secondEntered = false;
  const second = pool.run(async (lease) => {
    secondEntered = true;
    await lease.db.execute(sql`select 1`);
  });
  expect(secondEntered).toBe(false);
  release();
  expect(await firstResult).toMatchObject({
    message: "Item lease connection lost",
  });
  await second;
  expect(secondEntered).toBe(true);
  await pool.close();
});

it("rotates recovery priority so sustained import dispatches cannot starve cleanup", async () => {
  const f = fixture();
  const owner = await createAccount();
  const imports = Array.from({ length: 100 }, () => ({
    id: uuidv7(),
    accountOwnerId: owner.id,
    category: "muted_accounts" as const,
  }));
  await db.insert(schema.importJobs).values(imports);
  const cleanup = await job();
  for (let i = 0; i < 100; i++)
    await f.jobs.enqueueJob(f.ctx, "import", uuidv7());
  await f.jobs.recover(f.ctx);
  expect(f.queue.messages).toHaveLength(200);
  expect(
    f.queue.messages.some(
      (m) => m.type === "task" && m.taskName === "hollo.cleanup-dispatch.v1",
    ),
  ).toBe(false);
  f.queue.messages.splice(0, 100);
  await db
    .update(schema.importJobs)
    .set({ nextDispatchAt: sql`clock_timestamp() - interval '1 minute'` });
  await f.jobs.recover(f.ctx);
  expect(
    f.queue.messages.some(
      (m) => m.type === "task" && m.taskName === "hollo.cleanup-dispatch.v1",
    ),
  ).toBe(true);
  expect((await state(cleanup.jobId)).status).toBe("pending");
});

it("backfills legacy counters and diagnoses already-started partial batches once", async () => {
  const owner = await createAccount();
  const importId = uuidv7();
  await db.insert(schema.importJobs).values({
    id: importId,
    accountOwnerId: owner.id,
    category: "muted_accounts",
    status: "processing",
    startedAt: new Date(),
    totalItems: 2,
    processedItems: 8,
    successfulItems: 7,
    failedItems: 1,
  });
  await db.insert(schema.importJobItems).values({
    id: uuidv7(),
    jobId: importId,
    status: "completed",
    data: { handle: "target", notifications: false },
  });
  const cleanup = await job();
  await db.update(schema.cleanupJobs).set({
    status: "processing",
    startedAt: new Date(),
    totalItems: 100,
    processedItems: 9,
    successfulItems: 9,
  });
  const migration = await readFile(
    new URL(
      "../../drizzle/20261002114710_import-cleanup-tasks/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const backfill = migration.slice(migration.indexOf("-- Old workers"));
  for (const statement of backfill.split("--> statement-breakpoint"))
    await db.execute(sql.raw(statement));
  expect((await db.select().from(schema.importJobs))[0]).toMatchObject({
    status: "failed",
    processedItems: 1,
    successfulItems: 1,
    failedItems: 0,
    errorMessage: expect.stringContaining("Incomplete legacy"),
  });
  expect(await state(cleanup.jobId)).toMatchObject({
    status: "processing",
    totalItems: 1,
    processedItems: 0,
    successfulItems: 0,
  });
});

async function preparedImport(kind: "follow" | "block" = "follow") {
  const f = fixture();
  const owner = await createAccount();
  const target = await createAccount({ username: "import-target" });
  const jobId = uuidv7();
  const itemId = uuidv7();
  const actor = new URL("https://hollo.test/@hollo");
  const object = new URL("https://hollo.test/@import-target");
  const iri = `${actor.href}#import-follow/${itemId}`;
  let relationship: import("../import/delivery").ImportRelationship;
  const activity =
    kind === "follow"
      ? new Follow({ id: new URL(iri), actor, object })
      : new Block({ id: new URL(`#block/${target.id}`, actor), actor, object });
  await db.insert(schema.importJobs).values({
    id: jobId,
    accountOwnerId: owner.id,
    category: kind === "follow" ? "following_accounts" : "blocked_accounts",
    totalItems: 2,
  });
  await db.insert(schema.importJobItems).values([
    { id: itemId, jobId, data: { handle: "target" } },
    { id: uuidv7(), jobId, data: { handle: "unstarted" } },
  ]);
  if (kind === "follow") {
    await db
      .insert(schema.follows)
      .values({ iri, followerId: owner.id, followingId: target.id });
    relationship = { kind: "follow", iri };
  } else {
    const [block] = await db
      .insert(schema.blocks)
      .values({ accountId: owner.id, blockedAccountId: target.id })
      .returning();
    relationship = { kind: "block", ...block };
  }
  await db.insert(schema.importJobEffects).values({
    itemId,
    deliveries: [
      {
        sender: "hollo",
        recipients: [
          {
            id: object.href,
            inboxId: object.href + "/inbox",
            sharedInboxId: null,
          },
        ],
        activity: await activity.toJsonLd({ format: "expand" }),
        excludeBaseUris: [],
        relationship,
      },
    ],
  });
  const createContext = vi.spyOn(realFederation, "createContext");
  // @ts-expect-error The worker calls the URL overload, not the Request overload.
  createContext.mockReturnValue(f.ctx);
  const send = vi.spyOn(f.ctx, "sendActivity").mockResolvedValue(undefined);
  const dispatch = () =>
    f.federation.processQueuedTask(
      undefined,
      f.queue.take("hollo.import-dispatch.v1"),
    );
  const item = () =>
    f.federation.processQueuedTask(
      undefined,
      f.queue.take("hollo.import-item.v1"),
    );
  return { ...f, jobId, itemId, send, dispatch, item };
}

it.each(["follow", "block"] as const)(
  "delivers a committed %s after cancellation but leaves unprepared items untouched",
  async (kind) => {
    const f = await preparedImport(kind);
    await db
      .update(schema.importJobs)
      .set({ status: "cancelled" })
      .where(eq(schema.importJobs.id, f.jobId));
    await f.jobs.enqueueJob(f.ctx, "import", f.jobId);
    await f.dispatch();
    expect(f.queue.messages).toHaveLength(1);
    await f.item();
    expect(f.send).toHaveBeenCalledOnce();
    expect((await db.select().from(schema.importJobEffects))[0].delivered).toBe(
      1,
    );
    expect((await db.select().from(schema.importJobs))[0]).toMatchObject({
      status: "cancelled",
      processedItems: 1,
    });
    expect(
      (await db.select().from(schema.importJobItems)).filter(
        (i) => i.status === "pending",
      ),
    ).toHaveLength(1);
  },
);

it("recovers prepared deliveries cancelled during retry even after their queued message is lost", async () => {
  const f = await preparedImport();
  f.send.mockRejectedValueOnce(new Error("queue offline"));
  await f.jobs.enqueueJob(f.ctx, "import", f.jobId);
  await f.dispatch();
  await f.item();
  expect(f.send).toHaveBeenCalledOnce();
  f.queue.messages.length = 0;
  await db.update(schema.importJobs).set({
    status: "cancelled",
    nextDispatchAt: sql`clock_timestamp() - interval '1 minute'`,
  });
  await db.update(schema.importJobItems).set({
    nextDispatchAt: sql`clock_timestamp() - interval '1 minute'`,
    nextAttemptAt: sql`clock_timestamp() - interval '1 minute'`,
  });
  await f.jobs.recover(f.ctx);
  await f.dispatch();
  await f.item();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect((await db.select().from(schema.importJobEffects))[0].delivered).toBe(
    1,
  );
  expect((await db.select().from(schema.importJobs))[0].status).toBe(
    "cancelled",
  );
});

it("rotates registered recovery workloads and invokes them even at queue capacity", async () => {
  await cleanDatabase();
  const queue = new TestQueue();
  const federation = createFederation<void>({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    manuallyStartQueue: true,
  });
  let full = false;
  const jobs = registerBackgroundJobs(federation, async () => (full ? 200 : 0));
  const ctx = federation.createContext(
    new URL("https://hollo.test"),
    undefined,
  );
  const j = await job();
  const seen: number[] = [];
  jobs.addRecovery(async () => {
    seen.push(queue.messages.length);
  });
  await jobs.recoverAll(ctx);
  queue.messages.length = 0;
  await db
    .update(schema.cleanupJobs)
    .set({ nextDispatchAt: new Date(0) })
    .where(eq(schema.cleanupJobs.id, j.jobId));
  await jobs.recoverAll(ctx);
  expect(seen).toEqual([1, 0]);
  full = true;
  await jobs.recoverAll(ctx);
  expect(seen).toHaveLength(3);
});
