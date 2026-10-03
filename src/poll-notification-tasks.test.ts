import {
  createFederation,
  MemoryKvStore,
  type Message,
  type MessageQueue,
  type MessageQueueEnqueueOptions,
} from "@fedify/fedify";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../tests/helpers";
import { createAccount } from "../tests/helpers/oauth";
import { createExpiredPollPost } from "../tests/helpers/poll";
import db from "./db";
import { findMissingPollNotifications } from "./notification";
import {
  enqueuePollNotification,
  registerPollNotifications,
} from "./poll-notification-tasks";
import { accountOwners, polls, pollVotes, posts } from "./schema";
import { type Uuid, uuidv7 } from "./uuid";

class TestQueue implements MessageQueue {
  messages: Message[] = [];
  delays: number[] = [];
  fail = false;
  async enqueue(message: Message, options?: MessageQueueEnqueueOptions) {
    if (this.fail) throw new Error("queue offline");
    this.messages.push(message);
    this.delays.push(options?.delay?.total("milliseconds") ?? 0);
  }
  async listen() {}
}

function fixture(batchSize = 100, depth = async () => 0) {
  const queue = new TestQueue();
  const federation = createFederation<void>({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
  });
  let now = new Date("2026-01-01T00:00:00Z");
  const tasks = registerPollNotifications(federation, depth, {
    clock: () => now,
    batchSize,
  });
  const ctx = federation.createContext(
    new URL("https://hollo.test"),
    undefined,
  );
  return {
    queue,
    tasks,
    ctx,
    setNow(value: Date) {
      now = value;
    },
    run(message = queue.messages.shift()!) {
      return federation.processQueuedTask(undefined, message);
    },
  };
}

beforeEach(cleanDatabase);
afterEach(() => vi.restoreAllMocks());

async function seed(expires = new Date("2026-01-01T00:01:00Z")) {
  const author = await createAccount();
  return {
    author,
    ...(await createExpiredPollPost(author.id as Uuid, expires)),
    expires,
  };
}

async function stored() {
  return await db.query.notifications.findMany({
    where: { type: { eq: "poll" } },
  });
}

describe("Poll notification tasks", () => {
  it("schedules a local author, never notifies early, and preserves expiry timestamps", async () => {
    const f = fixture();
    const p = await seed();
    await f.tasks.enqueue(f.ctx, p.pollId);
    expect(f.queue.delays).toEqual([60_000]);
    expect(await stored()).toHaveLength(0);
    await f.run();
    expect(await stored()).toHaveLength(0);
    expect(f.queue.delays).toEqual([60_000, 60_000]);
    f.setNow(p.expires);
    await f.run();
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountOwnerId: p.author.id,
      targetPostId: p.postId,
      created: p.expires,
    });
    expect(await findMissingPollNotifications({ now: p.expires })).toEqual([]);
  });

  it("reloads local voters, deduplicating multiple choices and the author", async () => {
    const f = fixture();
    const p = await seed();
    await f.tasks.enqueue(f.ctx, p.pollId);
    const voter = await createAccount({ username: "voter" });
    await db.insert(pollVotes).values([
      { pollId: p.pollId, accountId: p.author.id as Uuid, optionIndex: 0 },
      { pollId: p.pollId, accountId: voter.id as Uuid, optionIndex: 0 },
      { pollId: p.pollId, accountId: voter.id as Uuid, optionIndex: 1 },
    ]);
    f.setNow(p.expires);
    const message = f.queue.messages.shift()!;
    await Promise.all([f.run(message), f.run(message), f.run(message)]);
    expect((await stored()).map((row) => row.accountOwnerId).sort()).toEqual(
      [p.author.id, voter.id].sort(),
    );
    expect(
      (await db.query.notificationGroups.findMany()).map(
        (g) => g.notificationsCount,
      ),
    ).toEqual([1, 1]);
    await f.tasks.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(0);
  });

  it("schedules remote polls only after a local vote, including late expired eligibility", async () => {
    const f = fixture();
    const p = await seed(new Date("2025-12-31T23:00:00Z"));
    // Keep the account, making the author remote to this node.
    await db
      .delete(accountOwners)
      .where(eq(accountOwners.id, p.author.id as Uuid));
    await f.tasks.enqueue(f.ctx, p.pollId);
    expect(f.queue.messages).toHaveLength(0);
    await f.ctx.enqueueTask(f.tasks.task, { pollId: p.pollId });
    await f.run();
    expect(await stored()).toHaveLength(0);
    const voter = await createAccount({ username: "voter" });
    await db.insert(pollVotes).values({
      pollId: p.pollId,
      accountId: voter.id as Uuid,
      optionIndex: 0,
    });
    await f.tasks.enqueue(f.ctx, p.pollId);
    expect(f.queue.delays.at(-1)).toBe(0);
    await f.run();
    expect((await stored()).map((n) => n.accountOwnerId)).toEqual([voter.id]);
  });

  it("handles expiry extensions and shortening without a TTL suppression window", async () => {
    const f = fixture();
    const p = await seed();
    await f.tasks.enqueue(f.ctx, p.pollId);
    const old = f.queue.messages.shift()!;
    const extended = new Date("2026-01-01T00:02:00Z");
    await db
      .update(polls)
      .set({ expires: extended })
      .where(eq(polls.id, p.pollId));
    f.setNow(p.expires);
    await f.run(old);
    expect(await stored()).toHaveLength(0);
    expect(f.queue.delays.at(-1)).toBe(60_000);
    await db
      .update(polls)
      .set({ expires: p.expires })
      .where(eq(polls.id, p.pollId));
    await f.tasks.enqueue(f.ctx, p.pollId);
    expect(f.queue.delays.at(-1)).toBe(0);
    await f.run();
    await f.run();
    expect(await stored()).toHaveLength(1);
    expect(
      (await db.query.notificationGroups.findMany())[0].notificationsCount,
    ).toBe(1);
  });

  it("clamps far-future wakeups and replaces them until the actual expiry", async () => {
    const f = fixture();
    const p = await seed(new Date("2027-01-01T00:00:00Z"));
    await f.tasks.enqueue(f.ctx, p.pollId);
    await f.run();
    expect(f.queue.delays).toEqual([604_800_000, 604_800_000]);
    expect(await stored()).toHaveLength(0);
    await db
      .delete(accountOwners)
      .where(eq(accountOwners.id, p.author.id as Uuid));
    await f.run();
    expect(f.queue.messages).toHaveLength(0);
  });

  it("ignores deleted polls and posts in old queued messages", async () => {
    const f = fixture();
    const p = await seed();
    await f.tasks.enqueue(f.ctx, p.pollId);
    await db.delete(posts).where(eq(posts.id, p.postId));
    await f.run();
    await f.ctx.enqueueTask(f.tasks.task, { pollId: p.pollId });
    await db.delete(polls).where(eq(polls.id, p.pollId));
    await f.run();
    expect(await stored()).toHaveLength(0);
    expect(f.queue.messages).toHaveLength(0);
  });

  it("retries transient notification failures through the Fedify dispatcher", async () => {
    const f = fixture();
    const p = await seed(new Date("2025-12-31T23:00:00Z"));
    await f.tasks.enqueue(f.ctx, p.pollId);
    vi.spyOn(db, "transaction").mockRejectedValueOnce(
      new Error("transient database failure"),
    );
    await f.run();
    expect(await stored()).toHaveLength(0);
    expect(f.queue.messages[0]).toMatchObject({ type: "task", attempt: 1 });
    await f.run();
    expect(await stored()).toHaveLength(1);
  });

  it("recovers after the three-attempt retry budget is exhausted", async () => {
    const f = fixture();
    const p = await seed(new Date("2025-12-31T23:00:00Z"));
    await f.tasks.enqueue(f.ctx, p.pollId);
    const failure = vi
      .spyOn(db, "transaction")
      .mockRejectedValue(new Error("database offline"));
    for (let i = 0; i < 3; i++) await f.run();
    expect(failure).toHaveBeenCalledTimes(3);
    expect(f.queue.messages).toHaveLength(0);
    failure.mockRestore();
    await f.tasks.recover(f.ctx);
    await f.run();
    expect(await stored()).toHaveLength(1);
  });

  it("recovers after a replacement and its retry enqueue both fail", async () => {
    const f = fixture();
    const p = await seed();
    await f.tasks.enqueue(f.ctx, p.pollId);
    f.queue.fail = true;
    await expect(f.run()).rejects.toThrow(/retry/i);
    f.queue.fail = false;
    f.setNow(p.expires);
    await f.tasks.recover(f.ctx);
    await f.run();
    expect(await stored()).toHaveLength(1);
  });

  it("waits for a committed expiry extension before deciding to notify", async () => {
    const f = fixture();
    const p = await seed(new Date("2025-12-31T23:00:00Z"));
    await f.tasks.enqueue(f.ctx, p.pollId);
    let release!: () => void;
    let updated!: () => void;
    const ready = new Promise<void>((resolve) => {
      updated = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = db.transaction(async (tx) => {
      await tx
        .update(polls)
        .set({ expires: new Date("2026-01-01T01:00:00Z") })
        .where(eq(polls.id, p.pollId));
      updated();
      await gate;
    });
    await ready;
    const run = f.run();
    try {
      let waiting = false;
      // Observe the real PostgreSQL lock rather than relying on sleep timing.
      for (let i = 0; i < 100 && !waiting; i++) {
        const [row] = await db.execute<{ waiting: boolean }>(sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query LIKE '%"polls"%for no key update%'
        ) AS waiting`);
        waiting = row.waiting;
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await hold;
      await run;
    }
    expect(await stored()).toHaveLength(0);
    expect(f.queue.delays.at(-1)).toBe(3_600_000);
  });
});

describe("Poll notification recovery", () => {
  it("registers poll recovery with the shared loop before queue processing", async () => {
    const p = await seed(new Date("2025-12-31T23:00:00Z"));
    const { federation, backgroundJobs, taskQueue } =
      await import("./federation/federation");
    const enqueue = vi.spyOn(taskQueue, "enqueue").mockResolvedValue(undefined);
    const ctx = federation.createContext(
      new URL("https://hollo.test"),
      undefined,
    );
    await backgroundJobs.recoverAll(ctx);
    const message = enqueue.mock.calls
      .map(([message]) => message as Message)
      .find(
        (message) =>
          message.type === "task" &&
          message.taskName === "hollo.poll-notification.v1",
      );
    expect(message).toBeDefined();
    expect(await stored()).toHaveLength(0);
    await federation.processQueuedTask(undefined, message!);
    expect((await stored())[0].targetPollId).toBe(p.pollId);
  });

  it("advances beyond 100 candidates before any queued task completes", async () => {
    const f = fixture();
    const author = await createAccount();
    for (let i = 0; i < 101; i++) {
      await createExpiredPollPost(
        author.id as Uuid,
        new Date(1767225600000 - i),
      );
    }
    await f.tasks.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(100);
    await f.tasks.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(101);
    for (const message of f.queue.messages.splice(0)) await f.run(message);
    expect(await stored()).toHaveLength(101);
    expect(
      await findMissingPollNotifications({ now: new Date("2026-01-01") }),
    ).toEqual([]);
  });

  it("moves past failed dispatches and retries them after wrapping", async () => {
    const f = fixture(1);
    const author = await createAccount();
    await createExpiredPollPost(
      author.id as Uuid,
      new Date("2025-12-31T23:00:00Z"),
    );
    const second = await createExpiredPollPost(
      author.id as Uuid,
      new Date("2025-12-31T23:01:00Z"),
    );
    f.queue.fail = true;
    await f.tasks.recover(f.ctx);
    f.queue.fail = false;
    await f.tasks.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(1);
    await f.run();
    expect((await stored())[0].targetPollId).toBe(second.pollId);
    await f.tasks.recover(f.ctx); // Empty tail wraps the cursor.
    await f.tasks.recover(f.ctx);
    await f.run();
    expect(await stored()).toHaveLength(2);
  });

  it("recovers committed missed enqueues after a restart across expiry", async () => {
    const before = fixture();
    const p = await seed();
    before.queue.fail = true;
    await before.tasks.enqueue(before.ctx, p.pollId);
    const after = fixture();
    after.setNow(p.expires);
    await after.tasks.recover(after.ctx);
    await after.run();
    expect(await stored()).toHaveLength(1);
  });

  it("keeps cursor progress when ready queue pressure postpones a pass", async () => {
    let pressure = 200;
    const f = fixture(1, async () => pressure);
    const p = await seed(new Date("2025-12-31T23:00:00Z"));
    await f.tasks.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(0);
    pressure = 0;
    await f.tasks.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(1);
    await f.run();
    expect((await stored())[0].targetPollId).toBe(p.pollId);
  });

  it("contains a failed recovery lookup so other workloads can still run", async () => {
    const f = fixture(1, async () => {
      throw new Error("depth unavailable");
    });
    await expect(f.tasks.recover(f.ctx)).resolves.toBeUndefined();
  });

  it("recovers a message consumed during shutdown without executing on a web node", async () => {
    const f = fixture();
    const p = await seed(new Date("2025-12-31T23:00:00Z"));
    await f.tasks.enqueue(f.ctx, p.pollId);
    expect(await stored()).toHaveLength(0); // Register/enqueue alone never consumes.
    const abort = new AbortController();
    f.tasks.setSignal(abort.signal);
    abort.abort();
    await f.run();
    await f.tasks.recover(f.ctx);
    expect(await stored()).toHaveLength(0);
    expect(f.queue.messages).toHaveLength(0);
    const restart = fixture();
    await restart.tasks.recover(restart.ctx);
    await restart.run();
    expect(await stored()).toHaveLength(1);
  });

  it("does not dispatch uncommitted work from transaction-capable callers", async () => {
    const { pollNotifications } = await import("./federation/federation");
    const enqueue = vi.spyOn(pollNotifications, "enqueue").mockResolvedValue();
    const id = uuidv7();
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(polls).values({ id, expires: new Date("2025-12-31") });
        await enqueuePollNotification(tx, id, "https://hollo.test");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(enqueue).not.toHaveBeenCalled();
    expect(
      await db.query.polls.findFirst({ where: { id: { eq: id } } }),
    ).toBeUndefined();
  });
});
