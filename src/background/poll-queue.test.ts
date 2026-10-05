import {
  createFederation,
  MemoryKvStore,
  type Message,
  type MessageQueueEnqueueOptions,
} from "@fedify/fedify";
import { Temporal } from "@js-temporal/polyfill";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import { createExpiredPollPost } from "../../tests/helpers/poll";
import * as cleanupWorker from "../cleanup/worker";
import db, { postgres } from "../db";
import { registerRemoteReplyScrapes } from "../federation/replies-tasks";
import * as importWorker from "../import/worker";
import { registerPollNotifications } from "../poll-notification-tasks";
import * as schema from "../schema";
import { type Uuid, uuidv7 } from "../uuid";
import { registerBackgroundJobs } from "./jobs";
import { itemLeases } from "./lease";
import {
  POLL_ADMISSION_LOCK,
  POLL_QUEUE_LIMIT,
  PollMessageQueue,
} from "./poll-queue";
import { TaskMessageQueue } from "./queue";

const tableName = "hollo_poll_queue_test";
const channelName = "hollo_poll_queue_test";
const taskName = "hollo.poll-notification.v1";
const key = (id: string) => `hollo.poll-notification:${id}`;
const delay = (seconds: number): MessageQueueEnqueueOptions => ({
  // The installed polyfills share the queue's total()/toString() interface.
  delay: Temporal.Duration.from({
    milliseconds: seconds * 1000,
  }) as unknown as NonNullable<MessageQueueEnqueueOptions["delay"]>,
});

function fixture(raw = false) {
  const queue = new PollMessageQueue(postgres, {
    tableName,
    channelName,
    pollInterval: { milliseconds: 20 },
    handlerTimeout: { seconds: 0 },
  });
  const source = raw ? queue.queue : queue;
  const federation = createFederation<void>({
    kv: new MemoryKvStore(),
    queue: { task: new TaskMessageQueue(source) },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
  });
  let now: Date | undefined;
  const tasks = registerPollNotifications(
    federation,
    async () => (await source.getDepth()).ready!,
    { clock: () => now ?? new Date() },
  );
  const ctx = federation.createContext(
    new URL("https://hollo.test"),
    undefined,
  );
  return {
    queue,
    federation,
    tasks,
    ctx,
    setNow(value: Date) {
      now = value;
    },
    async run() {
      const [row] = await postgres`
        DELETE FROM ${postgres(tableName)} WHERE id = (
          SELECT id FROM ${postgres(tableName)} ORDER BY created LIMIT 1
        ) RETURNING message
      `;
      await federation.processQueuedTask(undefined, row.message);
    },
  };
}

async function seed(expires = new Date(Date.now() + 60_000), author?: Uuid) {
  const authorId = author ?? ((await createAccount()).id as Uuid);
  return {
    ...(await createExpiredPollPost(authorId, expires)),
    authorId,
    expires,
  };
}

async function rows() {
  return await postgres`
    SELECT *, (created + delay)::text AS due, xmin::text AS version,
      extract(day FROM delay) AS days, extract(month FROM delay) AS months,
      jsonb_typeof(message) AS shape,
      extract(microseconds FROM created)::integer % 1000 AS micros
    FROM ${postgres(tableName)} ORDER BY created
  `;
}

async function notifications() {
  return await db.query.notifications.findMany({
    where: { type: { eq: "poll" } },
  });
}

function envelope(
  id = uuidv7(),
  orderingKey: string | undefined = key(id),
): Extract<Message, { type: "task" }> {
  return {
    type: "task",
    id: crypto.randomUUID(),
    taskName,
    data: "unused",
    baseUrl: "https://hollo.test",
    started: new Date().toISOString(),
    attempt: 0,
    orderingKey,
    traceContext: {},
  };
}

beforeEach(cleanDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(() => itemLeases.close());

describe("PostgreSQL poll admission", () => {
  it("measures repeated scheduling against the raw backend and emits no delayed NOTIFYs", async () => {
    const p = await seed();
    const raw = fixture(true);
    let notices = 0;
    const listener = await postgres.listen(channelName, () => {
      notices++;
    });
    try {
      for (let i = 0; i < 1000; i++) await raw.tasks.enqueue(raw.ctx, p.pollId);
      expect(await raw.queue.getPollDepth()).toBe(1000);
      await vi.waitFor(() => expect(notices).toBe(1000));
      await postgres`TRUNCATE ${postgres(tableName)}`;
      notices = 0;
      const bounded = fixture();
      const started = performance.now();
      for (let i = 0; i < 1000; i++)
        await bounded.tasks.enqueue(bounded.ctx, p.pollId);
      expect(await bounded.queue.getDepth()).toMatchObject({
        queued: 1,
        ready: 0,
        delayed: 1,
      });
      expect(notices).toBe(0);
      console.info("poll queue repeated schedules", {
        attempts: 1000,
        rawDepth: 1000,
        boundedDepth: 1,
        rawDelayedNotifies: 1000,
        boundedDelayedNotifies: notices,
        boundedMilliseconds: Math.round(performance.now() - started),
      });
    } finally {
      await listener.unlisten();
    }
  }, 30_000);

  it("coalesces votes and expiry edits across producers, sampling both bounds", async () => {
    const a = fixture();
    const b = fixture();
    const p = await seed();
    const voter = await createAccount({ username: "voter" });
    await db.insert(schema.pollVotes).values({
      pollId: p.pollId,
      accountId: voter.id as Uuid,
      optionIndex: 0,
    });
    await a.tasks.enqueue(a.ctx, p.pollId);
    let maximum = 0;
    for (let batch = 0; batch < 20; batch++) {
      await db
        .update(schema.polls)
        .set({ expires: new Date(Date.now() + (batch % 2 ? 120_000 : 60_000)) })
        .where(eq(schema.polls.id, p.pollId));
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          (i % 2 ? a : b).tasks.enqueue(a.ctx, p.pollId),
        ),
      );
      const stored = await rows();
      maximum = Math.max(maximum, stored.length);
      expect(stored).toHaveLength(1);
      expect(stored[0].ordering_key).toBeNull();
    }
    await db
      .update(schema.polls)
      .set({ expires: new Date(0) })
      .where(eq(schema.polls.id, p.pollId));
    await b.tasks.enqueue(b.ctx, p.pollId);
    await a.run();
    expect(await notifications()).toHaveLength(2);
    expect(
      (await db.query.notificationGroups.findMany()).map(
        (g) => g.notificationsCount,
      ),
    ).toEqual([1, 1]);
    console.info("poll queue concurrent edits/votes", {
      attempts: 1000,
      producers: 2,
      maximum,
      notifications: 2,
    });
  }, 30_000);

  it("bounds distinct polls and retries globally across concurrent producers", async () => {
    const a = fixture();
    const b = fixture();
    let maximum = 0;
    for (let batch = 0; batch < 15; batch++) {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => {
          const message = { ...envelope(), attempt: i % 3 };
          return (i % 2 ? a : b).queue.enqueue(message, delay(3600));
        }),
      );
      maximum = Math.max(maximum, await a.queue.getPollDepth());
      expect(maximum).toBeLessThanOrEqual(POLL_QUEUE_LIMIT);
      const [duplicates] = await postgres`
        SELECT count(*) AS count FROM (
          SELECT message->>'orderingKey' FROM ${postgres(tableName)}
          GROUP BY message->>'orderingKey' HAVING count(*) > 1
        ) duplicates
      `;
      expect(Number(duplicates.count)).toBe(0);
    }
    expect(maximum).toBe(POLL_QUEUE_LIMIT);
    console.info("poll queue distinct concurrent schedules", {
      attempts: 300,
      producers: 2,
      maximum,
    });
  }, 15_000);

  it("preserves envelopes, microseconds, FIFO priority and no-op rows", async () => {
    const f = fixture();
    const messages = Array.from({ length: 10 }, () => envelope());
    for (const message of messages)
      await f.queue.enqueue(message, delay(0.125));
    const before = await rows();
    expect(before.some((row) => Number(row.micros) !== 0)).toBe(true);
    expect(before.map((row) => row.message)).toEqual(messages);
    expect(
      before.every(
        (row) =>
          row.shape === "object" &&
          row.ordering_key === null &&
          Number(row.days) === 0 &&
          Number(row.months) === 0,
      ),
    ).toBe(true);
    for (const message of messages) await f.queue.enqueue(message, delay(100));
    expect((await rows()).map((row) => row.version)).toEqual(
      before.map((row) => row.version),
    );
    await f.queue.queue.enqueue(messages[0], delay(0.125));
    expect((await rows()).at(-1)?.message).toEqual(before[0].message);
    const columns = await postgres`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName} ORDER BY ordinal_position
    `;
    expect(columns.map((row) => row.column_name)).toEqual([
      "id",
      "message",
      "delay",
      "created",
      "ordering_key",
    ]);
  });

  it("pulls earlier expiry to now once, retains FIFO time and seconds-only delays", async () => {
    const f = fixture();
    const p = await seed();
    await f.tasks.enqueue(f.ctx, p.pollId);
    const original = (await rows())[0];
    let notices = 0;
    const listener = await postgres.listen(channelName, () => {
      notices++;
    });
    try {
      await db
        .update(schema.polls)
        .set({ expires: new Date(0) })
        .where(eq(schema.polls.id, p.pollId));
      await f.tasks.enqueue(f.ctx, p.pollId);
      await vi.waitFor(() => expect(notices).toBe(1));
      const pulled = (await rows())[0];
      expect(pulled.created).toEqual(original.created);
      expect(Number(pulled.days)).toBe(0);
      expect(Number(pulled.months)).toBe(0);
      await f.tasks.enqueue(f.ctx, p.pollId);
      expect((await rows())[0].version).toBe(pulled.version);
      await f.run();
      expect(await notifications()).toHaveLength(1);
      expect(notices).toBe(1);
      await f.queue.enqueue(envelope());
      await vi.waitFor(() => expect(notices).toBe(2));
    } finally {
      await listener.unlisten();
    }
  });

  it("admits expired work by replacing only later polls, even with legacy overload", async () => {
    const f = fixture();
    for (let i = 0; i < 120; i++)
      await f.queue.queue.enqueue(
        { ...envelope(), orderingKey: undefined },
        delay(604800),
      );
    const p = await seed(new Date("2026-01-01"));
    await f.tasks.recover(f.ctx);
    expect(await f.queue.getPollDepth()).toBe(120);
    const [row] = await postgres`
      DELETE FROM ${postgres(tableName)} WHERE message->>'orderingKey' = ${key(p.pollId)} RETURNING message
    `;
    expect(row).toBeDefined();
    await f.federation.processQueuedTask(undefined, row.message);
    expect(await notifications()).toHaveLength(1);
    expect(await f.queue.getPollDepth()).toBe(119);
    // Consumption drains the legacy surplus; admissions never add to it.
    await postgres`DELETE FROM ${postgres(tableName)} WHERE id IN (SELECT id FROM ${postgres(tableName)} LIMIT 20)`;
    await f.queue.enqueue(envelope(), delay(1));
    expect(await f.queue.getPollDepth()).toBe(POLL_QUEUE_LIMIT);
  });

  it("defers later work at the cap and rolls eviction back when insertion fails", async () => {
    const f = fixture();
    for (let i = 0; i < POLL_QUEUE_LIMIT; i++)
      await f.queue.enqueue(envelope(), delay(3600));
    const before = (await rows()).map((row) => row.id);
    await f.queue.enqueue(envelope(), delay(7200));
    expect((await rows()).map((row) => row.id)).toEqual(before);
    const rejected = { ...envelope(), data: "reject" };
    let notices = 0;
    const listener = await postgres.listen(channelName, () => {
      notices++;
    });
    await postgres.unsafe(`CREATE OR REPLACE FUNCTION hollo_poll_queue_reject() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.message->>'data' = 'reject' THEN RAISE EXCEPTION 'forced insert failure'; END IF; RETURN NEW; END $$`);
    await postgres.unsafe(
      `CREATE TRIGGER reject_poll BEFORE INSERT ON "${tableName}" FOR EACH ROW EXECUTE FUNCTION hollo_poll_queue_reject()`,
    );
    try {
      await expect(f.queue.enqueue(rejected)).rejects.toThrow(
        "forced insert failure",
      );
      expect((await rows()).map((row) => row.id)).toEqual(before);
      expect(notices).toBe(0);
    } finally {
      await postgres.unsafe(`DROP TRIGGER reject_poll ON "${tableName}"`);
      await postgres.unsafe("DROP FUNCTION hollo_poll_queue_reject()");
      await listener.unlisten();
    }
  });

  it("defers a held admission lock within a second and recovers the missed enqueue", async () => {
    const f = fixture();
    const p = await seed(new Date("2026-01-01"));
    await f.queue.queue.initialize();
    const held = await postgres.reserve();
    await held`SELECT pg_advisory_lock(${POLL_ADMISSION_LOCK}::bigint)`;
    try {
      const started = performance.now();
      await f.tasks.enqueue(f.ctx, p.pollId);
      expect(performance.now() - started).toBeGreaterThanOrEqual(900);
      expect(performance.now() - started).toBeLessThan(2500);
      expect(await f.queue.getPollDepth()).toBe(0);
    } finally {
      await held`SELECT pg_advisory_unlock(${POLL_ADMISSION_LOCK}::bigint)`;
      held.release();
    }
    await f.tasks.recover(f.ctx);
    await f.run();
    expect(await notifications()).toHaveLength(1);
  });

  it("recovers 250 expired polls through bounded pages without duplicate counts", async () => {
    const f = fixture();
    const author = (await createAccount()).id as Uuid;
    for (let i = 0; i < 250; i++)
      await seed(new Date(1767225600000 + i), author);
    let passes = 0;
    let maximum = 0;
    while ((await notifications()).length < 250 && passes < 10) {
      await f.tasks.recover(f.ctx);
      const depth = await f.queue.getPollDepth();
      maximum = Math.max(maximum, depth);
      expect(depth).toBeLessThanOrEqual(POLL_QUEUE_LIMIT);
      for (let i = 0; i < depth; i++) await f.run();
      passes++;
    }
    expect(await notifications()).toHaveLength(250);
    expect(
      (await db.query.notificationGroups.findMany()).every(
        (g) => g.notificationsCount === 1,
      ),
    ).toBe(true);
    console.info("poll queue recovery backlog", {
      polls: 250,
      passes,
      maximum,
    });
  }, 30_000);

  it("does not lose wakeups when consumption races with coalescing", async () => {
    const a = fixture();
    const b = fixture();
    const p = await seed();
    await a.tasks.enqueue(a.ctx, p.pollId);
    for (let i = 0; i < 50; i++) {
      await Promise.all([
        b.tasks.enqueue(b.ctx, p.pollId),
        postgres`DELETE FROM ${postgres(tableName)} WHERE message->>'orderingKey' = ${key(p.pollId)}`,
      ]);
      expect(await a.queue.getPollDepth()).toBeLessThanOrEqual(1);
      // A lost handler is repaired by a subsequent schedule/recovery, rather
      // than suppressed by a reservation left behind after consumption.
      await a.tasks.enqueue(a.ctx, p.pollId);
      expect(await a.queue.getPollDepth()).toBe(1);
    }
    await db
      .update(schema.polls)
      .set({ expires: new Date("2026-01-01") })
      .where(eq(schema.polls.id, p.pollId));
    await b.tasks.enqueue(b.ctx, p.pollId);
    await a.run();
    expect(await notifications()).toHaveLength(1);
  });

  it("coalesces with elapsed seconds across a daylight-saving transition", async () => {
    const f = fixture();
    const message = envelope();
    await f.queue.enqueue(message, delay(604800));
    // Keep the original FIFO timestamp, spanning the New York spring change.
    await postgres`
      UPDATE ${postgres(tableName)} SET created = '2026-03-07 12:00:00+00'::timestamptz,
        delay = make_interval(secs => extract(epoch FROM
          (clock_timestamp() + interval '1 hour' - '2026-03-07 12:00:00+00'::timestamptz))::double precision)
    `;
    await f.queue.enqueue(message, delay(60));
    const [row] = await postgres.begin(async (tx) => {
      await tx`SET LOCAL TIME ZONE 'America/New_York'`;
      return await tx`
        SELECT extract(day FROM delay) AS days,
          extract(month FROM delay) AS months,
          extract(epoch FROM (created + delay - clock_timestamp())) AS remaining
        FROM ${tx(tableName)}
      `;
    });
    expect(Number(row.days)).toBe(0);
    expect(Number(row.months)).toBe(0);
    expect(Number(row.remaining)).toBeGreaterThan(55);
    expect(Number(row.remaining)).toBeLessThanOrEqual(60);
  });

  it("keeps retries capped, recovers exhaustion and restarts after consumed-message loss", async () => {
    const f = fixture();
    const p = await seed(new Date("2026-01-01"));
    await f.tasks.enqueue(f.ctx, p.pollId);
    const failure = vi
      .spyOn(db, "transaction")
      .mockRejectedValue(new Error("notification database offline"));
    for (let i = 0; i < 3; i++) {
      await f.run();
      expect(await f.queue.getPollDepth()).toBeLessThanOrEqual(1);
    }
    expect(failure).toHaveBeenCalledTimes(3);
    expect(await f.queue.getPollDepth()).toBe(0);
    failure.mockRestore();
    await f.tasks.recover(f.ctx);
    // PostgreSQL deletes before calling the handler; emulate exit in that gap.
    await postgres`DELETE FROM ${postgres(tableName)}`;
    const restarted = fixture();
    await restarted.tasks.recover(restarted.ctx);
    await restarted.run();
    await restarted.tasks.recover(restarted.ctx);
    expect(await restarted.queue.getPollDepth()).toBe(0);
    expect(await notifications()).toHaveLength(1);
  });

  it.each(["earlier", "later"])(
    "delivers once at the current %s expiry through a real listener",
    async (direction) => {
      const f = fixture();
      const p = await seed(new Date(Date.now() + 400));
      await f.tasks.enqueue(f.ctx, p.pollId);
      const expires = new Date(
        Date.now() + (direction === "earlier" ? 100 : 900),
      );
      await db
        .update(schema.polls)
        .set({ expires })
        .where(eq(schema.polls.id, p.pollId));
      await f.tasks.enqueue(f.ctx, p.pollId);
      const abort = new AbortController();
      const listen = f.federation.startQueue(undefined, {
        queue: "task",
        signal: abort.signal,
      });
      try {
        expect(await notifications()).toHaveLength(0);
        await vi.waitFor(
          async () => expect(await notifications()).toHaveLength(1),
          { timeout: 3000 },
        );
        expect((await notifications())[0].created).toEqual(expires);
        expect(Date.now()).toBeGreaterThanOrEqual(+expires);
      } finally {
        abort.abort();
        await listen;
      }
      expect(await f.queue.getPollDepth()).toBe(0);
    },
  );

  it("keeps admission bounded with a large unrelated delayed backlog", async () => {
    const f = fixture();
    await f.queue.queue.initialize();
    await postgres`
      INSERT INTO ${postgres(tableName)} (message, delay)
      SELECT '{"type":"task","taskName":"hollo.cleanup-item.v1"}'::jsonb,
        interval '1 hour' FROM generate_series(1, 10000)
    `;
    const started = performance.now();
    await f.queue.enqueue(envelope(), delay(60));
    const milliseconds = Math.round(performance.now() - started);
    expect(await f.queue.getPollDepth()).toBe(1);
    expect((await f.queue.getDepth()).queued).toBe(10001);
    console.info("poll admission with unrelated backlog", {
      unrelated: 10000,
      milliseconds,
    });
  });

  it("registers the bounded adapter in the real federation queue", async () => {
    const { taskQueue } = await import("../federation/federation");
    expect(taskQueue.queue).toBeInstanceOf(PollMessageQueue);
    expect("enqueueMany" in taskQueue.queue).toBe(false);
  });

  it.each(["delayed", "ready"])(
    "runs imports, cleanup and replies with two consumers and saturated %s poll work",
    async (load) => {
      const a = fixture();
      const b = fixture();
      vi.spyOn(importWorker, "executeImportItem").mockResolvedValue(undefined);
      vi.spyOn(cleanupWorker, "executeCleanupItem").mockResolvedValue(
        undefined,
      );
      const author = (await createAccount()).id as Uuid;
      // Delayed reservations occupy the cap; expired work displaces them.
      for (let i = 0; i < POLL_QUEUE_LIMIT; i++)
        await a.queue.enqueue(envelope(), delay(604800));
      const jobs = [a, b].map((f) =>
        registerBackgroundJobs(
          f.federation,
          async () => (await f.queue.getDepth()).ready!,
        ),
      );
      let fetched = 0;
      const scrapeOptions = {
        maxDepth: 1,
        intervalSeconds: 0,
        documentLoader: async (url: string) => {
          fetched++;
          return {
            contextUrl: null,
            documentUrl: url,
            document: {
              "@context": "https://www.w3.org/ns/activitystreams",
              id: url,
              type: "OrderedCollection",
              totalItems: 0,
              orderedItems: [],
            },
          };
        },
      };
      const scrapes = [a, b].map((f) =>
        registerRemoteReplyScrapes(
          f.federation,
          async () => (await f.queue.getDepth()).ready!,
          scrapeOptions,
        ),
      );
      const importId = uuidv7();
      const cleanupId = uuidv7();
      await db.insert(schema.importJobs).values({
        id: importId,
        accountOwnerId: author,
        category: "bookmarks",
        totalItems: 1,
      });
      await db
        .insert(schema.importJobItems)
        .values({ id: uuidv7(), jobId: importId, data: {} });
      await db.insert(schema.cleanupJobs).values({
        id: cleanupId,
        category: "cleanup_thumbnails",
        totalItems: 1,
      });
      await db.insert(schema.cleanupJobItems).values({
        id: uuidv7(),
        jobId: cleanupId,
        data: { kind: "enumerate_proxy_cache" },
      });
      const p = await seed(new Date("2026-01-01"), author);
      const scrapeId = uuidv7();
      await db
        .insert(schema.remoteReplyScrapeOrigins)
        .values({ originHost: "remote.test", nextRequestAt: new Date(0) });
      await db.insert(schema.remoteReplyScrapeJobs).values({
        id: scrapeId,
        postId: p.postId,
        postIri: `https://hollo.test/posts/${p.postId}`,
        repliesIri: "https://remote.test/replies",
        baseUrl: "https://hollo.test",
        originHost: "remote.test",
        nextAttemptAt: new Date(0),
        nextDispatchAt: new Date(0),
      });
      await jobs[0].enqueueJob(a.ctx, "import", importId);
      await jobs[1].enqueueJob(b.ctx, "cleanup", cleanupId);
      await scrapes[0].enqueue(a.ctx, scrapeId);
      if (load === "ready") {
        for (let i = 0; i < POLL_QUEUE_LIMIT - 1; i++) {
          const due = await seed(new Date("2026-01-01"), author);
          await b.tasks.enqueue(b.ctx, due.pollId);
        }
      }
      await a.tasks.enqueue(a.ctx, p.pollId);
      const expectedNotifications = load === "ready" ? POLL_QUEUE_LIMIT : 1;
      const startDepth = await a.queue.getDepth();
      expect(startDepth.queued).toBe(103);
      expect(await notifications()).toHaveLength(0); // web-only registration/enqueue
      const abort = new AbortController();
      const started = performance.now();
      const workers = [a, b].map((f) =>
        f.federation.startQueue(undefined, {
          queue: "task",
          signal: abort.signal,
        }),
      );
      try {
        await vi.waitFor(
          async () => {
            expect(
              (
                await db.query.importJobs.findFirst({
                  where: { id: { eq: importId } },
                })
              )?.status,
            ).toBe("completed");
            expect(
              (
                await db.query.cleanupJobs.findFirst({
                  where: { id: { eq: cleanupId } },
                })
              )?.status,
            ).toBe("completed");
            expect(
              (await db.query.remoteReplyScrapeJobs.findFirst())?.status,
            ).toBe("completed");
            expect(await notifications()).toHaveLength(expectedNotifications);
          },
          { timeout: 5000 },
        );
        expect(importWorker.executeImportItem).toHaveBeenCalledTimes(1);
        expect(cleanupWorker.executeCleanupItem).toHaveBeenCalledTimes(1);
        expect(fetched).toBe(1);
        expect(await a.queue.getPollDepth()).toBe(load === "ready" ? 0 : 99);
        console.info("poll queue mixed workload", {
          consumers: 2,
          startDepth,
          endDepth: await a.queue.getDepth(),
          milliseconds: Math.round(performance.now() - started),
        });
      } finally {
        abort.abort();
        await Promise.all(workers);
      }
    },
    15_000,
  );
});
