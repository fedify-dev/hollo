import {
  createFederation,
  MemoryKvStore,
  type Message,
  type MessageQueue,
  type MessageQueueEnqueueOptions,
} from "@fedify/fedify";
import type { RemoteDocument } from "@fedify/vocab";
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import {
  accounts,
  instances,
  posts,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
} from "../schema";
import type { Uuid } from "../uuid";
import { uuidv7 } from "../uuid";
import { registerRemoteReplyScrapes } from "./replies-tasks";
import {
  claimRemoteReplyScrapeJob as claimById,
  type ProcessRemoteReplyScrapeJobsOptions,
} from "./replies-worker";

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
function fixture(
  options: ProcessRemoteReplyScrapeJobsOptions = {},
  depth?: () => Promise<number>,
) {
  const queue = new TestQueue();
  const federation = createFederation<void>({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
  });
  const tasks = registerRemoteReplyScrapes(
    federation,
    depth ?? (async () => 0),
    options,
  );
  const ctx = federation.createContext(
    new URL("https://enqueuer.test"),
    undefined,
  );
  return {
    queue,
    federation,
    tasks,
    ctx,
    run: (message = queue.messages.shift()!) =>
      federation.processQueuedTask(undefined, message),
  };
}
async function candidates(now = new Date()) {
  return await db
    .select({ job: remoteReplyScrapeJobs })
    .from(remoteReplyScrapeJobs)
    .innerJoin(
      remoteReplyScrapeOrigins,
      eq(remoteReplyScrapeOrigins.originHost, remoteReplyScrapeJobs.originHost),
    )
    .where(
      and(
        eq(remoteReplyScrapeJobs.status, "pending"),
        lte(remoteReplyScrapeJobs.nextAttemptAt, now),
        isNull(remoteReplyScrapeOrigins.processingJobId),
        lte(remoteReplyScrapeOrigins.nextRequestAt, now),
      ),
    )
    .orderBy(remoteReplyScrapeJobs.created);
}
async function claimRemoteReplyScrapeJob(
  now = new Date(),
  staleProcessingSeconds = 900,
) {
  const f = fixture({ now, staleProcessingSeconds });
  await f.tasks.reclaim();
  for (const { job } of await candidates(now)) {
    const claimed = await claimById(job.id, now);
    if (claimed) return claimed;
  }
  return null;
}
// Every baseline scrape now crosses Fedify's payload validation/codec and
// task dispatcher.  This helper only chooses fixtures, never executes work.
async function processDueRemoteReplyScrapeJobs(
  options: ProcessRemoteReplyScrapeJobsOptions = {},
) {
  if (options.maxDepth === 0) return 0;
  const f = fixture(options);
  await f.tasks.reclaim();
  let fetched = 0;
  for (const { job } of (await candidates(options.now)).slice(
    0,
    options.maxJobs ?? 1,
  )) {
    await f.ctx.enqueueTask(f.tasks.task, { jobId: job.id });
    await f.run();
    const state = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: job.id } },
    });
    if (state?.status === "completed") fetched += state.fetchedItems;
  }
  return fetched;
}

const PUBLIC_COLLECTION = "https://www.w3.org/ns/activitystreams#Public";

async function seedRemoteAccount(username: string, host = "remote.test") {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://${host}/@${username}`;
  await db
    .insert(instances)
    .values({
      host,
      software: "mastodon",
      softwareVersion: null,
    })
    .onConflictDoNothing();
  await db
    .insert(accounts)
    .values({
      id,
      iri,
      type: "Person",
      name: username,
      handle: `@${username}@${host}`,
      bioHtml: "",
      emojis: {},
      fieldHtmls: {},
      aliases: [],
      protected: false,
      inboxUrl: `${iri}/inbox`,
      followersUrl: `${iri}/followers`,
      sharedInboxUrl: `https://${host}/inbox`,
      featuredUrl: `${iri}/featured`,
      instanceHost: host,
      published: new Date(),
    })
    .onConflictDoNothing();
  const account = await db.query.accounts.findFirst({
    where: { iri: { eq: iri } },
  });
  if (account == null) throw new Error("Failed to seed remote account");
  return account;
}

async function seedPostWithScrapeJob({
  host = "remote.test",
  postIri = `https://${host}/@author/posts/root`,
  repliesIri = `https://${host}/@author/posts/root/replies`,
}: {
  host?: string;
  postIri?: string;
  repliesIri?: string;
} = {}) {
  const author = await seedRemoteAccount("author", host);
  const postId = uuidv7();
  await db.insert(posts).values({
    id: postId,
    iri: postIri,
    type: "Note",
    accountId: author.id,
    visibility: "public",
    contentHtml: "<p>Root</p>",
    content: "Root",
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  await db
    .insert(remoteReplyScrapeOrigins)
    .values({
      originHost: new URL(repliesIri).host,
      nextRequestAt: new Date(0),
    })
    .onConflictDoNothing();
  const jobId = uuidv7();
  await db.insert(remoteReplyScrapeJobs).values({
    id: jobId,
    postId,
    postIri,
    repliesIri,
    baseUrl: "https://hollo.test",
    originHost: new URL(repliesIri).host,
    nextAttemptAt: new Date(0),
    nextDispatchAt: new Date(0),
  });
  return { jobId, postId, postIri, repliesIri };
}

function makeLoader(
  documents: Record<string, unknown>,
  onLoad?: (url: string) => void,
) {
  return async (url: string): Promise<RemoteDocument> => {
    onLoad?.(url);
    const document = documents[url];
    if (document == null) throw new Error(`Unexpected fetch: ${url}`);
    return {
      contextUrl: null,
      document,
      documentUrl: url,
    };
  };
}

function actor(username: string, host = "remote.test") {
  const iri = `https://${host}/@${username}`;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: iri,
    type: "Person",
    name: username,
    inbox: `${iri}/inbox`,
    followers: `${iri}/followers`,
  };
}

function reply({
  content = "Reply",
  host = "remote.test",
  id,
  replyTarget,
  replies,
  username = "replyer",
}: {
  content?: string;
  host?: string;
  id: string;
  replyTarget: string;
  replies?: string;
  username?: string;
}) {
  return {
    id,
    type: "Note",
    attributedTo: `https://${host}/@${username}`,
    content: `<p>${content}</p>`,
    inReplyTo: replyTarget,
    to: PUBLIC_COLLECTION,
    replies,
  };
}

function collection(id: string, orderedItems: unknown[]) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id,
    type: "OrderedCollection",
    totalItems: orderedItems.length,
    orderedItems,
  };
}

describe("remote replies scrape worker", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("uses the local actor's authenticated loader by default", async () => {
    await createAccount({ generateKeyPair: true });
    const { postIri, repliesIri } = await seedPostWithScrapeJob();
    await seedRemoteAccount("replyer");
    const replyIri = "https://remote.test/@replyer/posts/1";
    const authenticatedLoader = makeLoader({
      [repliesIri]: collection(repliesIri, [
        reply({ id: replyIri, replyTarget: postIri }),
      ]),
      "https://remote.test/@replyer": actor("replyer"),
    });
    const anonymousLoader = vi.fn();
    const getDocumentLoader = vi.fn(async () => authenticatedLoader);
    const f = fixture({ maxItems: 1, sleep: async () => undefined });
    const { federation } = f;
    const createContext = vi
      .spyOn(federation, "createContext")
      .mockReturnValue({
        documentLoader: anonymousLoader,
        getDocumentLoader,
      } as never);

    try {
      const job = await db.query.remoteReplyScrapeJobs.findFirst();
      await f.ctx.enqueueTask(f.tasks.task, { jobId: job!.id });
      await f.run();
      const processed = (await db.query.remoteReplyScrapeJobs.findFirst())
        ?.fetchedItems;

      const persistedReply = await db.query.posts.findFirst({
        where: { iri: { eq: replyIri } },
      });
      expect(processed).toBe(1);
      expect(persistedReply?.iri).toBe(replyIri);
      expect(createContext).toHaveBeenCalledWith(
        new URL("https://hollo.test"),
        undefined,
      );
      expect(getDocumentLoader).toHaveBeenCalledWith({ username: "hollo" });
      expect(anonymousLoader).not.toHaveBeenCalled();
    } finally {
      createContext.mockRestore();
    }
  });

  it("limits how many reply items a single job persists", async () => {
    expect.assertions(4);
    const { postId, postIri, repliesIri } = await seedPostWithScrapeJob();
    await seedRemoteAccount("replyer");

    const firstReply = "https://remote.test/@replyer/posts/1";
    const secondReply = "https://remote.test/@replyer/posts/2";
    const processed = await processDueRemoteReplyScrapeJobs({
      documentLoader: makeLoader({
        [repliesIri]: collection(repliesIri, [
          reply({ id: firstReply, replyTarget: postIri }),
          reply({ id: secondReply, replyTarget: postIri }),
        ]),
        "https://remote.test/@replyer": actor("replyer"),
      }),
      maxItems: 1,
      sleep: async () => undefined,
    });

    const replyPosts = await db.query.posts.findMany({
      where: { replyTargetId: { isNotNull: true } },
      orderBy: (posts) => [posts.iri],
    });
    const job = await db.query.remoteReplyScrapeJobs.findFirst();
    const post = await db.query.posts.findFirst({
      where: { id: { eq: postId } },
    });
    expect(processed).toBe(1);
    expect(replyPosts.map((post) => post.iri)).toEqual([firstReply]);
    expect(job?.fetchedItems).toBe(1);
    expect(post?.repliesCount).toBe(1);
  });

  it("scrapes replies to replies up to the configured depth", async () => {
    expect.assertions(3);
    const { postIri, repliesIri } = await seedPostWithScrapeJob();
    await seedRemoteAccount("replyer");

    const directReply = "https://remote.test/@replyer/posts/1";
    const directReplyReplies = "https://remote.test/@replyer/posts/1/replies";
    const nestedReply = "https://remote.test/@replyer/posts/1-1";
    const nestedReplyReplies = "https://remote.test/@replyer/posts/1-1/replies";
    const documentLoader = makeLoader({
      [repliesIri]: collection(repliesIri, [
        reply({
          id: directReply,
          replyTarget: postIri,
          replies: directReplyReplies,
        }),
      ]),
      [directReplyReplies]: collection(directReplyReplies, [
        reply({
          id: nestedReply,
          replyTarget: directReply,
          replies: nestedReplyReplies,
        }),
      ]),
      "https://remote.test/@replyer": actor("replyer"),
    });

    await processDueRemoteReplyScrapeJobs({
      documentLoader,
      intervalSeconds: 0,
      maxDepth: 2,
      sleep: async () => undefined,
    });
    await processDueRemoteReplyScrapeJobs({
      documentLoader,
      intervalSeconds: 0,
      maxDepth: 2,
      sleep: async () => undefined,
    });

    const replyPosts = await db.query.posts.findMany({
      where: { replyTargetId: { isNotNull: true } },
      orderBy: (posts) => [posts.iri],
    });
    const jobs = await db.query.remoteReplyScrapeJobs.findMany({
      orderBy: (remoteReplyScrapeJobs) => [remoteReplyScrapeJobs.depth],
    });
    expect(replyPosts.map((post) => post.iri)).toEqual([
      directReply,
      nestedReply,
    ]);
    expect(jobs.map((job) => job.repliesIri)).toEqual([
      repliesIri,
      directReplyReplies,
    ]);
    expect(jobs.map((job) => job.status)).toEqual(["completed", "completed"]);
  });

  it("does not claim another job for an origin that is already processing", async () => {
    expect.assertions(2);
    const first = await seedPostWithScrapeJob();
    await seedPostWithScrapeJob({
      postIri: "https://remote.test/@author/posts/second",
      repliesIri: "https://remote.test/@author/posts/second/replies",
    });

    const claimed = await claimRemoteReplyScrapeJob();
    const skipped = await claimRemoteReplyScrapeJob();

    expect(claimed?.id).toBe(first.jobId);
    expect(skipped).toBeNull();
  });

  it("does not process queued jobs when scraping is disabled", async () => {
    expect.assertions(3);
    const { jobId, repliesIri } = await seedPostWithScrapeJob();
    let fetches = 0;

    const processed = await processDueRemoteReplyScrapeJobs({
      documentLoader: async (url): Promise<RemoteDocument> => {
        fetches++;
        throw new Error(`Unexpected fetch: ${url}`);
      },
      maxDepth: 0,
      sleep: async () => undefined,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(processed).toBe(0);
    expect(fetches).toBe(0);
    expect(job?.repliesIri).toBe(repliesIri);
  });

  it("reclaims stale processing jobs and origin locks", async () => {
    expect.assertions(4);
    const first = await seedPostWithScrapeJob();
    await seedPostWithScrapeJob({
      postIri: "https://remote.test/@author/posts/second",
      repliesIri: "https://remote.test/@author/posts/second/replies",
    });
    const startedAt = new Date("2026-04-25T00:00:00.000Z");
    const reclaimedAt = new Date("2026-04-25T00:01:01.000Z");

    const claimed = await claimRemoteReplyScrapeJob(startedAt);
    const reclaimed = await claimRemoteReplyScrapeJob(reclaimedAt, 60);

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: first.jobId } },
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(claimed?.id).toBe(first.jobId);
    expect(reclaimed?.id).toBe(first.jobId);
    expect(job?.attempts).toBe(2);
    expect(origin?.processingJobId).toBe(first.jobId);
  });

  it("does not reclaim processing jobs with recent request heartbeats", async () => {
    expect.assertions(4);
    const { jobId, postIri, repliesIri } = await seedPostWithScrapeJob();
    await seedRemoteAccount("replyer");
    const startedAt = new Date("2026-04-25T00:00:00.000Z");
    const heartbeatAt = new Date("2026-04-25T00:00:30.000Z");
    const reclaimAt = new Date("2026-04-25T00:01:01.000Z");
    const requestTimes = [
      heartbeatAt,
      new Date("2026-04-25T00:01:02.000Z"),
      new Date("2026-04-25T00:01:03.000Z"),
    ];
    let reclaimedDuringSleep = false;

    const processed = await processDueRemoteReplyScrapeJobs({
      clock: () => requestTimes.shift() ?? new Date("2026-04-25T00:01:04.000Z"),
      documentLoader: makeLoader({
        [repliesIri]: collection(repliesIri, [
          reply({
            id: "https://remote.test/@replyer/posts/1",
            replyTarget: postIri,
          }),
        ]),
        "https://remote.test/@replyer": actor("replyer"),
      }),
      intervalSeconds: 10,
      now: startedAt,
      sleep: async () => {
        const reclaimed = await claimRemoteReplyScrapeJob(reclaimAt, 60);
        reclaimedDuringSleep = reclaimed != null;
      },
      staleProcessingSeconds: 60,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(processed).toBe(1);
    expect(reclaimedDuringSleep).toBe(false);
    expect(job?.status).toBe("completed");
    expect(job?.attempts).toBe(1);
  });

  it("does not reclaim processing jobs during long throttling sleeps", async () => {
    expect.assertions(4);
    const { jobId, postIri, repliesIri } = await seedPostWithScrapeJob();
    await seedRemoteAccount("replyer");
    const startedAt = new Date("2026-04-25T00:00:00.000Z");
    const requestTimes = [
      startedAt,
      new Date("2026-04-25T00:00:01.000Z"),
      new Date("2026-04-25T00:07:31.000Z"),
      new Date("2026-04-25T00:15:01.000Z"),
      new Date("2026-04-25T00:20:02.000Z"),
      new Date("2026-04-25T00:20:03.000Z"),
    ];
    const reclaimTimes = [
      new Date("2026-04-25T00:07:31.000Z"),
      new Date("2026-04-25T00:16:00.000Z"),
      new Date("2026-04-25T00:20:01.000Z"),
    ];
    let reclaimedDuringSleep = false;
    const sleepMilliseconds: number[] = [];

    const processed = await processDueRemoteReplyScrapeJobs({
      clock: () => requestTimes.shift() ?? new Date("2026-04-25T00:20:04.000Z"),
      documentLoader: makeLoader({
        [repliesIri]: collection(repliesIri, [
          reply({
            id: "https://remote.test/@replyer/posts/1",
            replyTarget: postIri,
          }),
        ]),
        "https://remote.test/@replyer": actor("replyer"),
      }),
      intervalSeconds: 20 * 60,
      now: startedAt,
      sleep: async (milliseconds) => {
        sleepMilliseconds.push(milliseconds);
        const reclaimed = await claimRemoteReplyScrapeJob(
          reclaimTimes.shift() ?? new Date("2026-04-25T00:20:01.000Z"),
          15 * 60,
        );
        reclaimedDuringSleep = reclaimed != null;
      },
      staleProcessingSeconds: 15 * 60,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(processed).toBe(1);
    expect(reclaimedDuringSleep).toBe(false);
    expect(sleepMilliseconds).toEqual([450_000, 450_000, 300_000]);
    expect(job?.attempts).toBe(1);
  });

  it("does not reclaim jobs during long remote fetches", async () => {
    expect.assertions(4);
    const { jobId, repliesIri } = await seedPostWithScrapeJob();
    const startedAt = new Date("2026-04-25T00:00:00.000Z");
    const fetchStartedAt = new Date("2026-04-25T00:00:30.000Z");
    const reclaimAt = new Date("2026-04-25T00:01:01.000Z");
    const requestTimes = [
      fetchStartedAt,
      new Date("2026-04-25T00:01:02.000Z"),
      new Date("2026-04-25T00:01:03.000Z"),
    ];
    let reclaimedDuringFetch = false;

    const processed = await processDueRemoteReplyScrapeJobs({
      clock: () => requestTimes.shift() ?? new Date("2026-04-25T00:01:04.000Z"),
      documentLoader: async (url): Promise<RemoteDocument> => {
        if (url !== repliesIri) throw new Error(`Unexpected fetch: ${url}`);
        const reclaimed = await claimRemoteReplyScrapeJob(reclaimAt, 60);
        reclaimedDuringFetch = reclaimed != null;
        return {
          contextUrl: null,
          document: collection(repliesIri, []),
          documentUrl: url,
        };
      },
      now: startedAt,
      sleep: async () => undefined,
      staleProcessingSeconds: 60,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(processed).toBe(0);
    expect(reclaimedDuringFetch).toBe(false);
    expect(job?.status).toBe("completed");
    expect(job?.attempts).toBe(1);
  });

  it("does not reclaim jobs during long reply persistence steps", async () => {
    expect.assertions(4);
    const { jobId, postIri, repliesIri } = await seedPostWithScrapeJob();
    await seedRemoteAccount("replyer");
    const startedAt = new Date("2026-04-25T00:00:00.000Z");
    const persistenceStartedAt = new Date("2026-04-25T00:00:30.000Z");
    const reclaimAt = new Date("2026-04-25T00:01:01.000Z");
    const requestTimes = [
      startedAt,
      persistenceStartedAt,
      new Date("2026-04-25T00:01:02.000Z"),
      new Date("2026-04-25T00:01:03.000Z"),
    ];
    let reclaimedDuringPersistence = false;

    const processed = await processDueRemoteReplyScrapeJobs({
      clock: () => requestTimes.shift() ?? new Date("2026-04-25T00:01:04.000Z"),
      documentLoader: async (url): Promise<RemoteDocument> => {
        if (url === repliesIri) {
          return {
            contextUrl: null,
            document: collection(repliesIri, [
              reply({
                id: "https://remote.test/@replyer/posts/1",
                replyTarget: postIri,
              }),
            ]),
            documentUrl: url,
          };
        }
        if (url === "https://remote.test/@replyer") {
          const reclaimed = await claimRemoteReplyScrapeJob(reclaimAt, 60);
          reclaimedDuringPersistence = reclaimed != null;
          return {
            contextUrl: null,
            document: actor("replyer"),
            documentUrl: url,
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      intervalSeconds: 0,
      now: startedAt,
      sleep: async () => undefined,
      staleProcessingSeconds: 60,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(processed).toBe(1);
    expect(reclaimedDuringPersistence).toBe(false);
    expect(job?.status).toBe("completed");
    expect(job?.attempts).toBe(1);
  });

  it("does not reclaim processing jobs after cross-origin heartbeats", async () => {
    expect.assertions(3);
    const { jobId, postIri, repliesIri } = await seedPostWithScrapeJob();
    const startedAt = new Date("2026-04-25T00:00:00.000Z");
    const crossOriginHeartbeatAt = new Date("2026-04-25T00:00:30.000Z");
    const reclaimAt = new Date("2026-04-25T00:01:01.000Z");
    const requestTimes = [
      startedAt,
      crossOriginHeartbeatAt,
      new Date("2026-04-25T00:01:02.000Z"),
      new Date("2026-04-25T00:01:03.000Z"),
    ];
    let reclaimedDuringCrossOriginFetch = false;
    const firstCrossOriginReply = reply({
      host: "other.test",
      id: "https://other.test/@replyer/posts/1",
      replyTarget: postIri,
    });
    const secondCrossOriginReply = reply({
      host: "other2.test",
      id: "https://other2.test/@replyer/posts/2",
      replyTarget: postIri,
    });

    await processDueRemoteReplyScrapeJobs({
      clock: () => requestTimes.shift() ?? new Date("2026-04-25T00:01:04.000Z"),
      documentLoader: async (url): Promise<RemoteDocument> => {
        if (url === repliesIri) {
          return {
            contextUrl: null,
            document: collection(repliesIri, [
              firstCrossOriginReply,
              secondCrossOriginReply,
            ]),
            documentUrl: url,
          };
        }
        if (url === "https://other.test/@replyer/posts/1") {
          return {
            contextUrl: null,
            document: firstCrossOriginReply,
            documentUrl: url,
          };
        }
        if (url === "https://other2.test/@replyer/posts/2") {
          const reclaimed = await claimRemoteReplyScrapeJob(reclaimAt, 60);
          reclaimedDuringCrossOriginFetch = reclaimed != null;
          return {
            contextUrl: null,
            document: secondCrossOriginReply,
            documentUrl: url,
          };
        }
        if (url === "https://other.test/@replyer") {
          return {
            contextUrl: null,
            document: actor("replyer", "other.test"),
            documentUrl: url,
          };
        }
        if (url === "https://other2.test/@replyer") {
          return {
            contextUrl: null,
            document: actor("replyer", "other2.test"),
            documentUrl: url,
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      intervalSeconds: 10,
      now: startedAt,
      sleep: async () => undefined,
      staleProcessingSeconds: 60,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(reclaimedDuringCrossOriginFetch).toBe(false);
    expect(job?.status).toBe("completed");
    expect(job?.attempts).toBe(1);
  });

  it("skips unavailable origins without starving later claimable jobs", async () => {
    expect.assertions(1);
    const now = new Date("2026-04-25T00:00:00.000Z");
    const future = new Date("2026-04-25T01:00:00.000Z");

    for (let i = 0; i < 10; i++) {
      const host = `blocked-${i}.test`;
      await seedPostWithScrapeJob({
        host,
        postIri: `https://${host}/@author/posts/root`,
        repliesIri: `https://${host}/@author/posts/root/replies`,
      });
      await db
        .update(remoteReplyScrapeOrigins)
        .set({ nextRequestAt: future })
        .where(eq(remoteReplyScrapeOrigins.originHost, host));
    }

    const available = await seedPostWithScrapeJob({
      host: "available.test",
      postIri: "https://available.test/@author/posts/root",
      repliesIri: "https://available.test/@author/posts/root/replies",
    });

    const claimed = await claimRemoteReplyScrapeJob(now);

    expect(claimed?.id).toBe(available.jobId);
  });

  it("backs off jobs and origins when a replies collection returns HTTP 429", async () => {
    expect.assertions(6);
    const { jobId, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00.000Z");
    const error = new Error("rate limited") as Error & {
      response: Response;
    };
    error.response = new Response(null, {
      status: 429,
      headers: { "Retry-After": "120" },
    });

    const processed = await processDueRemoteReplyScrapeJobs({
      documentLoader: async (url) => {
        if (url === repliesIri) throw error;
        throw new Error(`Unexpected fetch: ${url}`);
      },
      now,
      sleep: async () => undefined,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(processed).toBe(0);
    expect(job?.status).toBe("pending");
    expect(job?.nextAttemptAt.getTime()).toBe(now.getTime() + 120_000);
    expect(job?.startedAt).toBeNull();
    expect(job?.completedAt).toBeNull();
    expect(origin?.nextRequestAt.getTime()).toBe(now.getTime() + 120_000);
  });

  it("does not back off the job origin for cross-origin HTTP 429s", async () => {
    expect.assertions(5);
    const { jobId, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00.000Z");
    const failedAt = new Date("2026-04-25T00:01:00.000Z");
    const crossOriginPage =
      "https://other.test/@author/posts/root/replies?page=1";
    const crossOriginError = new Error("cross-origin rate limited") as Error & {
      response: Response;
    };
    crossOriginError.response = new Response(null, {
      status: 429,
      headers: { "Retry-After": "120" },
    });

    const processed = await processDueRemoteReplyScrapeJobs({
      clock: () => failedAt,
      documentLoader: async (url): Promise<RemoteDocument> => {
        if (url === repliesIri) {
          return {
            contextUrl: null,
            document: {
              "@context": "https://www.w3.org/ns/activitystreams",
              id: repliesIri,
              type: "OrderedCollection",
              totalItems: 1,
              first: crossOriginPage,
            },
            documentUrl: url,
          };
        }
        if (url === crossOriginPage) throw crossOriginError;
        throw new Error(`Unexpected fetch: ${url}`);
      },
      intervalSeconds: 0,
      now,
      sleep: async () => undefined,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(processed).toBe(0);
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toBe("cross-origin rate limited");
    expect(job?.nextAttemptAt.getTime()).toBe(0);
    expect(origin?.nextRequestAt.getTime()).toBe(failedAt.getTime());
  });

  it("updates scraped replies count before backing off partial jobs", async () => {
    expect.assertions(3);
    const { jobId, postId, postIri, repliesIri } =
      await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00.000Z");
    const failureTime = new Date("2026-04-25T00:01:00.000Z");
    const firstPage = `${repliesIri}?page=1`;
    const secondPage = `${repliesIri}?page=2`;
    const error = new Error("rate limited") as Error & {
      response: Response;
    };
    error.response = new Response(null, { status: 429 });

    await processDueRemoteReplyScrapeJobs({
      clock: () => failureTime,
      documentLoader: async (url): Promise<RemoteDocument> => {
        if (url === repliesIri) {
          return {
            contextUrl: null,
            document: {
              "@context": "https://www.w3.org/ns/activitystreams",
              id: repliesIri,
              type: "OrderedCollection",
              totalItems: 2,
              first: {
                id: firstPage,
                type: "OrderedCollectionPage",
                partOf: repliesIri,
                next: secondPage,
                orderedItems: [
                  reply({
                    id: "https://remote.test/@replyer/posts/1",
                    replyTarget: postIri,
                  }),
                ],
              },
            },
            documentUrl: url,
          };
        }
        if (url === firstPage) {
          return {
            contextUrl: null,
            document: {
              "@context": "https://www.w3.org/ns/activitystreams",
              id: firstPage,
              type: "OrderedCollectionPage",
              partOf: repliesIri,
              next: secondPage,
              orderedItems: [
                reply({
                  id: "https://remote.test/@replyer/posts/1",
                  replyTarget: postIri,
                }),
              ],
            },
            documentUrl: url,
          };
        }
        if (url === "https://remote.test/@replyer") {
          return {
            contextUrl: null,
            document: actor("replyer"),
            documentUrl: url,
          };
        }
        if (url === secondPage) {
          const replyer = await seedRemoteAccount("replyer");
          await db
            .insert(posts)
            .values({
              id: uuidv7(),
              iri: "https://remote.test/@replyer/posts/1",
              type: "Note",
              accountId: replyer.id,
              replyTargetId: postId,
              visibility: "public",
              contentHtml: "<p>Reply</p>",
              content: "Reply",
              tags: {},
              emojis: {},
              sensitive: false,
              published: new Date(),
              updated: new Date(),
            })
            .onConflictDoNothing({
              target: posts.iri,
            });
          throw error;
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      maxDepth: 2,
      now,
      sleep: async () => undefined,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const post = await db.query.posts.findFirst({
      where: { id: { eq: postId } },
    });
    expect(job?.status).toBe("pending");
    expect(job?.fetchedItems).toBe(0);
    expect(post?.repliesCount).toBe(1);
  });

  it("uses fallback backoff when Retry-After has negative seconds", async () => {
    expect.assertions(4);
    const { jobId, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00.000Z");
    const error = new Error("rate limited") as Error & {
      response: Response;
    };
    error.response = new Response(null, {
      status: 429,
      headers: { "Retry-After": "-1" },
    });

    const processed = await processDueRemoteReplyScrapeJobs({
      backoffSeconds: 60,
      documentLoader: async (url) => {
        if (url === repliesIri) throw error;
        throw new Error(`Unexpected fetch: ${url}`);
      },
      now,
      sleep: async () => undefined,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(processed).toBe(0);
    expect(job?.status).toBe("pending");
    expect(job?.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
    expect(origin?.nextRequestAt.getTime()).toBe(now.getTime() + 60_000);
  });

  it("records a clear failure when replies collection lookup returns null", async () => {
    expect.assertions(3);
    const { jobId, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00.000Z");

    const processed = await processDueRemoteReplyScrapeJobs({
      documentLoader: async (url): Promise<RemoteDocument> => ({
        contextUrl: null,
        document: url === repliesIri ? null : {},
        documentUrl: url,
      }),
      now,
      sleep: async () => undefined,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    expect(processed).toBe(0);
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toBe(
      `Replies collection not found: ${repliesIri}`,
    );
  });

  it("bases 429 backoff on the actual failure time", async () => {
    expect.assertions(3);
    const { jobId, postIri, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00.000Z");
    const failureTime = new Date("2026-04-25T00:10:00.000Z");
    const error = new Error("rate limited") as Error & {
      response: Response;
    };
    error.response = new Response(null, {
      status: 429,
      headers: { "Retry-After": "120" },
    });

    await processDueRemoteReplyScrapeJobs({
      clock: () => failureTime,
      documentLoader: async (url): Promise<RemoteDocument> => {
        if (url === repliesIri) {
          return {
            contextUrl: null,
            document: collection(repliesIri, [
              reply({
                id: "https://remote.test/@replyer/posts/1",
                replyTarget: postIri,
              }),
            ]),
            documentUrl: url,
          };
        }
        if (url === "https://remote.test/@replyer") throw error;
        throw new Error(`Unexpected fetch: ${url}`);
      },
      now,
      sleep: async () => undefined,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(job?.status).toBe("pending");
    expect(job?.nextAttemptAt.getTime()).toBe(failureTime.getTime() + 120_000);
    expect(origin?.nextRequestAt.getTime()).toBe(
      failureTime.getTime() + 120_000,
    );
  });

  it("does not clear another worker's origin lock when finishing stale work", async () => {
    expect.assertions(3);
    const { jobId, repliesIri } = await seedPostWithScrapeJob();
    const replacement = await seedPostWithScrapeJob({
      postIri: "https://remote.test/@author/posts/replacement",
      repliesIri: "https://remote.test/@author/posts/replacement/replies",
    });
    const replacementStartedAt = new Date("2026-04-25T00:02:00.000Z");
    const completedAt = new Date("2026-04-25T00:02:01.000Z");

    await processDueRemoteReplyScrapeJobs({
      clock: () => completedAt,
      documentLoader: async (url): Promise<RemoteDocument> => {
        if (url !== repliesIri) throw new Error(`Unexpected fetch: ${url}`);
        await db
          .update(remoteReplyScrapeJobs)
          .set({
            status: "processing",
            updated: replacementStartedAt,
          })
          .where(eq(remoteReplyScrapeJobs.id, replacement.jobId));
        await db
          .update(remoteReplyScrapeOrigins)
          .set({
            processingJobId: replacement.jobId,
            processingStartedAt: replacementStartedAt,
          })
          .where(eq(remoteReplyScrapeOrigins.originHost, "remote.test"));
        return {
          contextUrl: null,
          document: collection(repliesIri, []),
          documentUrl: url,
        };
      },
      now: completedAt,
      sleep: async () => undefined,
    });

    const staleJob = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(staleJob?.status).toBe("processing");
    expect(origin?.processingJobId).toBe(replacement.jobId);
    expect(origin?.processingStartedAt?.toISOString()).toBe(
      replacementStartedAt.toISOString(),
    );
  });

  it("does not let stale attempts overwrite newer terminal state", async () => {
    expect.assertions(5);
    const { jobId, repliesIri } = await seedPostWithScrapeJob();
    const secondStartedAt = new Date("2026-04-25T00:02:00.000Z");
    const firstCompletedAt = new Date("2026-04-25T00:02:01.000Z");

    await processDueRemoteReplyScrapeJobs({
      clock: () => firstCompletedAt,
      documentLoader: async (url): Promise<RemoteDocument> => {
        if (url !== repliesIri) throw new Error(`Unexpected fetch: ${url}`);
        await db
          .update(remoteReplyScrapeJobs)
          .set({
            attempts: 2,
            startedAt: secondStartedAt,
            status: "processing",
            updated: secondStartedAt,
          })
          .where(eq(remoteReplyScrapeJobs.id, jobId));
        await db
          .update(remoteReplyScrapeOrigins)
          .set({
            processingJobId: jobId,
            processingStartedAt: secondStartedAt,
          })
          .where(eq(remoteReplyScrapeOrigins.originHost, "remote.test"));
        return {
          contextUrl: null,
          document: collection(repliesIri, []),
          documentUrl: url,
        };
      },
      now: firstCompletedAt,
      sleep: async () => undefined,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(job?.status).toBe("processing");
    expect(job?.attempts).toBe(2);
    expect(job?.startedAt?.toISOString()).toBe(secondStartedAt.toISOString());
    expect(origin?.processingJobId).toBe(jobId);
    expect(origin?.processingStartedAt?.toISOString()).toBe(
      secondStartedAt.toISOString(),
    );
  });

  it("releases origin locks when processing jobs are deleted", async () => {
    expect.assertions(4);
    const { jobId, postId, repliesIri } = await seedPostWithScrapeJob();
    const next = await seedPostWithScrapeJob({
      postIri: "https://remote.test/@author/posts/second",
      repliesIri: "https://remote.test/@author/posts/second/replies",
    });
    const startedAt = new Date("2026-04-25T00:00:00.000Z");
    const deletedAt = new Date("2026-04-25T00:00:01.000Z");
    const completedAt = new Date("2026-04-25T00:00:02.000Z");
    const requestTimes = [
      deletedAt,
      new Date("2026-04-25T00:00:03.000Z"),
      completedAt,
    ];

    const processed = await processDueRemoteReplyScrapeJobs({
      clock: () => requestTimes.shift() ?? completedAt,
      documentLoader: async (url): Promise<RemoteDocument> => {
        if (url !== repliesIri) throw new Error(`Unexpected fetch: ${url}`);
        await db.delete(posts).where(eq(posts.id, postId));
        return {
          contextUrl: null,
          document: collection(repliesIri, []),
          documentUrl: url,
        };
      },
      intervalSeconds: 0,
      now: startedAt,
      sleep: async () => undefined,
    });

    const deletedJob = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const claimed = await claimRemoteReplyScrapeJob(completedAt);
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(processed).toBe(0);
    expect(deletedJob).toBeUndefined();
    expect(claimed?.id).toBe(next.jobId);
    expect(origin?.processingJobId).toBe(next.jobId);
  });

  it("records per-request timestamps for throttled origin request fields", async () => {
    expect.assertions(3);
    const { postIri, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00.000Z");
    const requestTimes = [
      new Date("2026-04-25T00:00:01.000Z"),
      new Date("2026-04-25T00:00:02.000Z"),
      new Date("2026-04-25T00:00:03.000Z"),
      new Date("2026-04-25T00:00:04.000Z"),
      new Date("2026-04-25T00:00:05.000Z"),
      new Date("2026-04-25T00:00:06.000Z"),
      new Date("2026-04-25T00:00:07.000Z"),
      new Date("2026-04-25T00:00:08.000Z"),
    ];
    await seedRemoteAccount("replyer");

    await processDueRemoteReplyScrapeJobs({
      clock: () => requestTimes.shift() ?? new Date("2026-04-25T00:00:04.000Z"),
      documentLoader: makeLoader({
        [repliesIri]: collection(repliesIri, [
          reply({
            id: "https://remote.test/@replyer/posts/1",
            replyTarget: postIri,
          }),
        ]),
        "https://remote.test/@replyer": actor("replyer"),
      }),
      intervalSeconds: 10,
      now,
      sleep: async () => undefined,
    });

    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(origin?.lastRequestAt?.toISOString()).toBe(
      "2026-04-25T00:00:06.000Z",
    );
    expect(origin?.nextRequestAt.toISOString()).toBe(
      "2026-04-25T00:00:16.000Z",
    );
    expect(origin?.updated.toISOString()).toBe("2026-04-25T00:00:08.000Z");
  });
});

describe("remote replies task delivery", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.restoreAllMocks();
  });

  it("round-trips IDs and ignores duplicate completed messages", async () => {
    const j = await seedPostWithScrapeJob();
    const loader = vi.fn(
      makeLoader({ [j.repliesIri]: collection(j.repliesIri, []) }),
    );
    const f = fixture({ documentLoader: loader });
    await f.tasks.enqueue(f.ctx, j.jobId);
    const message = f.queue.messages.shift()!;
    await f.run(message);
    await f.run(message);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await db.query.remoteReplyScrapeJobs.findFirst()).toMatchObject({
      status: "completed",
      attempts: 1,
    });
    expect(f.queue.messages).toHaveLength(0);
  });

  it("rearms an early message even with a live reservation", async () => {
    const j = await seedPostWithScrapeJob();
    const now = new Date();
    const due = new Date(now.getTime() + 120_000);
    await db.update(remoteReplyScrapeJobs).set({
      nextAttemptAt: due,
      nextDispatchAt: new Date(due.getTime() + 60_000),
    });
    const loader = vi.fn();
    const f = fixture({ now, documentLoader: loader });
    await f.ctx.enqueueTask(f.tasks.task, { jobId: j.jobId });
    await f.run();
    expect(loader).not.toHaveBeenCalled();
    expect(f.queue.messages).toHaveLength(1);
    expect(f.queue.delays.at(-1)).toBe(120_000);
    expect((await db.query.remoteReplyScrapeJobs.findFirst())?.attempts).toBe(
      0,
    );
  });

  it("keeps application 429 rescheduling separate from Fedify retries", async () => {
    const j = await seedPostWithScrapeJob();
    const error = Object.assign(new Error("limited"), {
      response: new Response(null, {
        status: 429,
        headers: { "Retry-After": "300" },
      }),
    });
    const f = fixture({
      now: new Date(),
      documentLoader: async () => {
        throw error;
      },
    });
    await f.tasks.enqueue(f.ctx, j.jobId);
    await f.run();
    expect(f.queue.messages).toHaveLength(1);
    expect(f.queue.messages[0]).toMatchObject({ type: "task", attempt: 0 });
    expect(f.queue.delays.at(-1)).toBe(300_000);
    expect((await db.query.remoteReplyScrapeJobs.findFirst())?.status).toBe(
      "pending",
    );
  });

  it.each([false, true])(
    "preserves scrape error handling after a heartbeat failure (rate limited: %s)",
    async (rateLimited) => {
      const j = await seedPostWithScrapeJob();
      const initial = await db.query.remoteReplyScrapeJobs.findFirst();
      const now = new Date();
      const error = Object.assign(new Error("fetch failed"), {
        response: new Response(null, {
          status: rateLimited ? 429 : 500,
          headers: { "Retry-After": "300" },
        }),
      });
      const originalTransaction = db.transaction.bind(db);
      const transaction = vi.spyOn(db, "transaction");
      const f = fixture({
        now,
        intervalSeconds: 0,
        documentLoader: async () => {
          transaction
            .mockImplementationOnce(originalTransaction)
            .mockRejectedValueOnce(new Error("connection reset"));
          throw error;
        },
      });
      try {
        await f.tasks.enqueue(f.ctx, j.jobId);
        await f.run();
      } finally {
        transaction.mockRestore();
      }
      const job = await db.query.remoteReplyScrapeJobs.findFirst();
      const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
      expect(job?.status).toBe(rateLimited ? "pending" : "failed");
      expect(job?.errorMessage).not.toContain("connection reset");
      expect(origin?.processingJobId).toBeNull();
      expect(job?.errorMessage).toBe(
        rateLimited
          ? "fetch failed"
          : `Replies collection not found: ${j.repliesIri}`,
      );
      expect(job?.nextAttemptAt.getTime()).toBe(
        rateLimited
          ? now.getTime() + 300_000
          : initial?.nextAttemptAt.getTime(),
      );
      expect(origin?.nextRequestAt.getTime()).toBe(
        now.getTime() + (rateLimited ? 300_000 : 0),
      );
      expect(f.queue.delays).toEqual(rateLimited ? [0, 300_000] : [0]);
    },
  );

  it("does not apply backoff after the error checkpoint loses ownership", async () => {
    const j = await seedPostWithScrapeJob();
    const now = new Date();
    const f = fixture({
      now,
      documentLoader: async () => {
        await db
          .update(remoteReplyScrapeJobs)
          .set({ attempts: 2 })
          .where(eq(remoteReplyScrapeJobs.id, j.jobId));
        throw Object.assign(new Error("limited"), {
          response: new Response(null, {
            status: 429,
            headers: { "Retry-After": "300" },
          }),
        });
      },
    });
    await f.tasks.enqueue(f.ctx, j.jobId);
    await f.run();
    expect(await db.query.remoteReplyScrapeJobs.findFirst()).toMatchObject({
      status: "processing",
      attempts: 2,
    });
    expect(
      (await db.query.remoteReplyScrapeOrigins.findFirst())?.processingJobId,
    ).toBe(j.jobId);
    expect(f.queue.messages).toHaveLength(0);
  });

  it("recovers a committed job after enqueue failure", async () => {
    const j = await seedPostWithScrapeJob();
    let now = new Date();
    const f = fixture({
      clock: () => now,
      documentLoader: makeLoader({
        [j.repliesIri]: collection(j.repliesIri, []),
      }),
    });
    f.queue.fail = true;
    await f.tasks.enqueue(f.ctx, j.jobId);
    expect(f.queue.messages).toHaveLength(0);
    f.queue.fail = false;
    now = new Date(now.getTime() + 60_001);
    await f.tasks.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(1);
    await f.run();
    expect((await db.query.remoteReplyScrapeJobs.findFirst())?.status).toBe(
      "completed",
    );
  });

  it("does not dispatch work from an uncommitted transaction", async () => {
    const j = await seedPostWithScrapeJob();
    const post = (await db.query.posts.findFirst({
      where: { id: { eq: j.postId } },
    }))!;
    const { enqueueRemoteReplyScrape } = await import("./replies");
    const { replyScrapes } = await import("./federation");
    const dispatch = vi.spyOn(replyScrapes, "enqueue");
    const iri = new URL(j.repliesIri + "/rolled-back");
    await expect(
      db.transaction(async (tx) => {
        await enqueueRemoteReplyScrape(tx, {
          baseUrl: "https://hollo.test",
          post,
          repliesIri: iri,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      await db.query.remoteReplyScrapeJobs.findFirst({
        where: { repliesIri: { eq: iri.href } },
      }),
    ).toBeUndefined();
    await db.transaction(async (tx) => {
      await enqueueRemoteReplyScrape(tx, {
        baseUrl: "https://hollo.test",
        post,
        repliesIri: iri,
      });
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      await db.query.remoteReplyScrapeJobs.findFirst({
        where: { repliesIri: { eq: iri.href } },
      }),
    ).toMatchObject({ status: "pending" });
    dispatch.mockRestore();
  });

  it("coalesces future wakeups per origin without blocking a healthy host", async () => {
    const now = new Date();
    const f = fixture({ now }, async () => 100); // Two busy import windows.
    for (let i = 0; i < 10; i++) {
      const j = await seedPostWithScrapeJob({
        postIri: `https://remote.test/posts/${i}`,
        repliesIri: `https://remote.test/posts/${i}/replies`,
      });
      await db
        .update(remoteReplyScrapeOrigins)
        .set({ nextRequestAt: new Date(now.getTime() + 86_400_000) });
      await f.tasks.enqueue(f.ctx, j.jobId);
    }
    expect(f.queue.messages).toHaveLength(1);
    const healthy = await seedPostWithScrapeJob({ host: "healthy.test" });
    await f.tasks.enqueue(f.ctx, healthy.jobId);
    expect(f.queue.messages).toHaveLength(2);
    expect(f.queue.delays.at(-1)).toBe(0);
  });

  it("bounded recovery rotates through more than one hundred origins", async () => {
    const now = new Date();
    const f = fixture({ now });
    for (let i = 0; i < 105; i++)
      await seedPostWithScrapeJob({ host: `host-${i}.test` });
    const seen = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      await f.tasks.recover(f.ctx);
      expect(f.queue.messages.length).toBeLessThanOrEqual(50);
      for (const message of f.queue.messages)
        seen.add(message.type === "task" ? message.data : "unexpected");
      // Delivery at capacity releases reservations without claiming work.
      const ids = await db.query.remoteReplyScrapeJobs.findMany({
        where: { nextDispatchAt: { gt: now } },
      });
      await db
        .update(remoteReplyScrapeJobs)
        .set({ nextDispatchAt: now })
        .where(
          inArray(
            remoteReplyScrapeJobs.id,
            ids.map((row) => row.id),
          ),
        );
      expect(ids.length).toBeLessThanOrEqual(50);
      f.queue.messages.length = 0;
    }
    expect(seen.size).toBe(105);
  });

  it("leaves an aborted first fetch pending and releases its own lease", async () => {
    const j = await seedPostWithScrapeJob();
    const controller = new AbortController();
    const f = fixture({
      signal: controller.signal,
      documentLoader: async () => {
        controller.abort(new Error("shutdown"));
        throw controller.signal.reason;
      },
    });
    await f.tasks.enqueue(f.ctx, j.jobId);
    await f.run();
    expect(await db.query.remoteReplyScrapeJobs.findFirst()).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    expect(
      (await db.query.remoteReplyScrapeOrigins.findFirst())?.processingJobId,
    ).toBeNull();
    expect(f.queue.messages).toHaveLength(0);
  });

  it("refreshes the lease while a fetch is still awaiting", async () => {
    const j = await seedPostWithScrapeJob();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = fixture({
      staleProcessingSeconds: 0.1,
      documentLoader: async (url) => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          contextUrl: null,
          documentUrl: url,
          document: collection(url, []),
        };
      },
    });
    await f.tasks.enqueue(f.ctx, j.jobId);
    const running = f.run();
    await entered;
    const initial = (await db.query.remoteReplyScrapeJobs.findFirst())!.updated;
    try {
      await vi.waitFor(async () => {
        expect(
          (await db.query.remoteReplyScrapeJobs.findFirst())!.updated.getTime(),
        ).toBeGreaterThan(initial.getTime());
      });
    } finally {
      release();
      await running;
    }
    expect((await db.query.remoteReplyScrapeJobs.findFirst())?.status).toBe(
      "completed",
    );
  });

  it("continues after a transient timer heartbeat failure", async () => {
    const j = await seedPostWithScrapeJob();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = fixture({
      staleProcessingSeconds: 0.1,
      documentLoader: async (url) => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          contextUrl: null,
          documentUrl: url,
          document: collection(url, []),
        };
      },
    });
    await f.tasks.enqueue(f.ctx, j.jobId);
    const running = f.run();
    await entered;
    const transaction = vi
      .spyOn(db, "transaction")
      .mockRejectedValueOnce(new Error("connection reset"));
    try {
      await vi.waitFor(() => {
        expect(transaction).toHaveBeenCalled();
      });
    } finally {
      transaction.mockRestore();
      release();
      await running;
    }
    expect((await db.query.remoteReplyScrapeJobs.findFirst())?.status).toBe(
      "completed",
    );
    expect(
      (await db.query.remoteReplyScrapeOrigins.findFirst())?.processingJobId,
    ).toBeNull();
  });

  it("stops dispatch and execution when scraping is disabled", async () => {
    const j = await seedPostWithScrapeJob();
    const loader = vi.fn();
    const f = fixture({ maxDepth: 0, documentLoader: loader });
    await f.tasks.enqueue(f.ctx, j.jobId);
    await f.tasks.recover(f.ctx);
    expect(f.queue.messages).toHaveLength(0);
    await f.ctx.enqueueTask(f.tasks.task, { jobId: j.jobId });
    await f.run();
    expect(loader).not.toHaveBeenCalled();
    expect((await db.query.remoteReplyScrapeJobs.findFirst())?.attempts).toBe(
      0,
    );
  });
});

it("duplicate tasks on independent workers cannot acquire the same origin", async () => {
  await cleanDatabase();
  const j = await seedPostWithScrapeJob();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const loader = vi.fn(async (url: string): Promise<RemoteDocument> => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      contextUrl: null,
      documentUrl: url,
      document: collection(url, []),
    };
  });
  const first = fixture({ documentLoader: loader });
  const second = fixture({ documentLoader: loader });
  await first.tasks.enqueue(first.ctx, j.jobId);
  const message = first.queue.messages.shift()!;
  const running = first.run(message);
  await started;
  try {
    await second.run(message);
    await second.tasks.recover(second.ctx);
    expect(loader).toHaveBeenCalledTimes(1);
    expect((await db.query.remoteReplyScrapeJobs.findFirst())?.attempts).toBe(
      1,
    );
    expect(second.queue.messages).toHaveLength(0);
  } finally {
    release();
    await running;
  }
  expect((await db.query.remoteReplyScrapeJobs.findFirst())?.status).toBe(
    "completed",
  );
});

it("a capacity drop is picked up by the next finished attempt", async () => {
  await cleanDatabase();
  const roots = await Promise.all(
    ["one.test", "two.test", "three.test"].map((host) =>
      seedPostWithScrapeJob({ host }),
    ),
  );
  const releases: Array<() => void> = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    documentLoader: async (url) => {
      if (releases.length < 2 && !url.includes("three.test")) {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
          if (releases.length === 2) entered();
        });
      }
      return {
        contextUrl: null,
        documentUrl: url,
        document: collection(url, []),
      };
    },
  });
  for (const root of roots) await f.tasks.enqueue(f.ctx, root.jobId);
  const first = f.run();
  const second = f.run();
  await started;
  try {
    await f.run();
    expect(
      await db.query.remoteReplyScrapeJobs.findFirst({
        where: { id: { eq: roots[2].jobId } },
      }),
    ).toMatchObject({ status: "pending", attempts: 0 });
  } finally {
    for (const release of releases) release();
    await Promise.all([first, second]);
  }
  expect(f.queue.messages).toHaveLength(1);
  await f.run();
  expect(
    await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: roots[2].jobId } },
    }),
  ).toMatchObject({ status: "completed", attempts: 1 });
});

it("a terminal scrape failure schedules its same-host sibling with spacing", async () => {
  await cleanDatabase();
  const first = await seedPostWithScrapeJob();
  const sibling = await seedPostWithScrapeJob({
    postIri: "https://remote.test/posts/sibling",
    repliesIri: "https://remote.test/posts/sibling/replies",
  });
  const now = new Date();
  const f = fixture({
    now,
    intervalSeconds: 5,
    documentLoader: async () => {
      throw new Error("not found");
    },
  });
  await f.tasks.enqueue(f.ctx, first.jobId);
  await f.run();
  expect(f.queue.messages).toHaveLength(1);
  expect(f.queue.delays.at(-1)).toBe(5000);
  expect(
    await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: sibling.jobId } },
    }),
  ).toMatchObject({ status: "pending", attempts: 0 });
});
