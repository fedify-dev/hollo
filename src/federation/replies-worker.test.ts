import {
  createFederation,
  MemoryKvStore,
  type Message,
  type MessageQueue,
  type MessageQueueEnqueueOptions,
} from "@fedify/fedify";
import { Note, Person, type RemoteDocument } from "@fedify/vocab";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import {
  createAccount,
  createOAuthApplication,
  getAccessToken,
  bearerAuthorization,
} from "../../tests/helpers/oauth";
import db from "../db";
import {
  accounts,
  follows,
  lists,
  listMembers,
  blocks,
  mutes,
  instances,
  posts,
  remoteReplyScrapeJobs,
  remoteReplyScrapeOrigins,
} from "../schema";
import type { Uuid } from "../uuid";
import { uuidv7 } from "../uuid";
import { enqueueRemoteReplyScrape } from "./replies";
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

  it("reschedules long cooldowns without sleeping or advancing slots", async () => {
    const { jobId, postIri, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00Z");
    const sleep = vi.fn(async () => undefined);
    await seedRemoteAccount("replyer");
    await processDueRemoteReplyScrapeJobs({
      now,
      intervalSeconds: 120,
      sleep,
      documentLoader: async (url) => {
        if (url === repliesIri)
          await db
            .update(remoteReplyScrapeOrigins)
            .set({ cooldownUntil: new Date(+now + 1200_000) })
            .where(eq(remoteReplyScrapeOrigins.originHost, "remote.test"));
        return makeLoader({
          [repliesIri]: collection(repliesIri, [
            reply({ id: "https://remote.test/posts/1", replyTarget: postIri }),
          ]),
          "https://remote.test/@replyer": actor("replyer"),
        })(url);
      },
    });
    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { id: { eq: jobId } },
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(job?.status).toBe("pending");
    expect(job?.nextAttemptAt).toEqual(new Date(+now + 1200_000));
    expect(origin?.nextRequestAt).toEqual(new Date(+now + 1200_000));
    expect(origin?.processingJobId).toBeNull();
    expect(sleep).not.toHaveBeenCalled();
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
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst({
      where: { originHost: { eq: "remote.test" } },
    });
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

  it("spaces actual document requests and records their completion times", async () => {
    const { postIri, repliesIri } = await seedPostWithScrapeJob();
    const now = new Date("2026-04-25T00:00:00Z");
    let time = +now;
    const times: number[] = [];
    await seedRemoteAccount("replyer");
    await processDueRemoteReplyScrapeJobs({
      now,
      clock: () => new Date(time),
      intervalSeconds: 10,
      sleep: async (ms) => {
        time += ms;
      },
      documentLoader: makeLoader(
        {
          [repliesIri]: collection(repliesIri, [
            reply({ id: "https://remote.test/posts/1", replyTarget: postIri }),
          ]),
          "https://remote.test/@replyer": actor("replyer"),
        },
        () => times.push(time),
      ),
    });
    const origin = await db.query.remoteReplyScrapeOrigins.findFirst();
    expect(times).toEqual([+now, +now + 10_000]);
    expect(origin?.lastRequestAt).toEqual(new Date(times.at(-1)!));
    expect(origin?.nextRequestAt).toEqual(new Date(time + 10_000));
    expect(origin?.updated).toEqual(new Date(time));
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
      const transaction = vi.spyOn(db, "transaction");
      const f = fixture({
        now,
        intervalSeconds: 0,
        documentLoader: async () => {
          transaction.mockRejectedValueOnce(new Error("connection reset"));
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

async function seedContextJob() {
  const seed = await seedPostWithScrapeJob({
    repliesIri: "https://remote.test/conversation/1",
  });
  await db
    .update(remoteReplyScrapeJobs)
    .set({ kind: "context" })
    .where(eq(remoteReplyScrapeJobs.id, seed.jobId));
  return seed;
}
function documentReply(options: Parameters<typeof reply>[0]) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    ...reply(options),
  };
}
async function gateReplies(
  seed: Awaited<ReturnType<typeof seedContextJob>>,
  repliesIri = "https://remote.test/fallback",
) {
  const post = await db.query.posts.findFirst({
    where: { id: { eq: seed.postId } },
  });
  await db.transaction((tx) =>
    enqueueRemoteReplyScrape(tx, {
      baseUrl: "https://hollo.test",
      post: post!,
      contextIri: new URL(seed.repliesIri),
      repliesIri: new URL(repliesIri),
    }),
  );
  return db.query.remoteReplyScrapeJobs.findFirst({
    where: { kind: { eq: "replies" }, repliesIri: { eq: repliesIri } },
  });
}
const contextOptions = { intervalSeconds: 0, sleep: async () => undefined };

describe("FEP-f228 conversation backfill", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.restoreAllMocks();
  });

  it("enqueues context-only seeds and gates each seed's distinct replies", async () => {
    const seed = await seedContextJob();
    const first = await gateReplies(seed);
    const second = await gateReplies(
      seed,
      "https://remote.test/fallback/second",
    );
    expect(first?.status).toBe("waiting");
    expect(second?.blockedByJobId).toBe(seed.jobId);
    expect(
      await db.query.remoteReplyScrapeJobs.findMany({
        where: { kind: { eq: "context" } },
      }),
    ).toHaveLength(1);
  });

  it("reads paginated contexts, reconciles out-of-order parents, and leaves missing ancestors unfetched", async () => {
    const seed = await seedContextJob();
    await gateReplies(seed);
    await seedRemoteAccount("replyer");
    const parent = "https://remote.test/posts/parent";
    const child = "https://remote.test/posts/child";
    const orphan = "https://remote.test/posts/orphan";
    const missing = "https://remote.test/posts/deleted";
    const page = `${seed.repliesIri}?page=1`;
    const documents = {
      [seed.repliesIri]: { ...collection(seed.repliesIri, []), first: page },
      [page]: {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: page,
        type: "OrderedCollectionPage",
        partOf: seed.repliesIri,
        orderedItems: [
          reply({ id: child, replyTarget: parent }),
          reply({ id: parent, replyTarget: seed.postIri }),
          reply({ id: orphan, replyTarget: missing }),
        ],
      },
      [child]: documentReply({ id: child, replyTarget: parent }),
      [parent]: documentReply({ id: parent, replyTarget: seed.postIri }),
      [orphan]: documentReply({ id: orphan, replyTarget: missing }),
      "https://remote.test/@replyer": actor("replyer"),
    };
    const urls: string[] = [];
    expect(
      await processDueRemoteReplyScrapeJobs({
        ...contextOptions,
        documentLoader: makeLoader(documents, (url) => urls.push(url)),
      }),
    ).toBe(3);
    const parentPost = await db.query.posts.findFirst({
      where: { iri: { eq: parent } },
    });
    const childPost = await db.query.posts.findFirst({
      where: { iri: { eq: child } },
    });
    const orphanPost = await db.query.posts.findFirst({
      where: { iri: { eq: orphan } },
    });
    expect(childPost?.replyTargetId).toBe(parentPost?.id);
    expect(parentPost?.repliesCount).toBe(1);
    expect(orphanPost?.replyTargetId).toBeNull();
    expect(urls).not.toContain(missing);
    expect(urls.filter((url) => url === child)).toHaveLength(1);
    expect(
      (
        await db.query.remoteReplyScrapeJobs.findFirst({
          where: { kind: { eq: "replies" } },
        })
      )?.status,
    ).toBe("completed");
  });

  it("covers waiting replies after a fully read empty context", async () => {
    const seed = await seedContextJob();
    await gateReplies(seed);
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader({
        [seed.repliesIri]: collection(seed.repliesIri, []),
      }),
    });
    const jobs = await db.query.remoteReplyScrapeJobs.findMany();
    expect(jobs.every((job) => job.status === "completed")).toBe(true);
    expect(jobs.find((job) => job.kind === "context")?.partial).toBe(false);
  });

  it("releases replies when the context is missing and recovers orphaned gates", async () => {
    const seed = await seedContextJob();
    await gateReplies(seed);
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader({}),
    });
    expect(
      (
        await db.query.remoteReplyScrapeJobs.findFirst({
          where: { kind: { eq: "replies" } },
        })
      )?.status,
    ).toBe("pending");
    await db
      .update(remoteReplyScrapeJobs)
      .set({ status: "waiting", blockedByJobId: null })
      .where(eq(remoteReplyScrapeJobs.kind, "replies"));
    await fixture().tasks.reclaim();
    expect(
      (
        await db.query.remoteReplyScrapeJobs.findFirst({
          where: { kind: { eq: "replies" } },
        })
      )?.status,
    ).toBe("pending");
  });

  it("counts existing objects against the yielded-item cap without changing their content", async () => {
    const seed = await seedContextJob();
    await gateReplies(seed);
    const knownIri = "https://remote.test/posts/known";
    const seedPost = await db.query.posts.findFirst({
      where: { id: { eq: seed.postId } },
    });
    await db.insert(posts).values({
      ...seedPost!,
      id: uuidv7(),
      iri: knownIri,
      replyTargetId: seed.postId,
    });
    const unseen = "https://remote.test/posts/unseen";
    const loader = vi.fn(
      makeLoader({
        [seed.repliesIri]: collection(seed.repliesIri, [
          reply({
            id: knownIri,
            replyTarget: seed.postIri,
            content: "Forged replacement",
          }),
          reply({ id: unseen, replyTarget: seed.postIri }),
        ]),
      }),
    );
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      maxItems: 1,
      documentLoader: loader,
    });
    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { kind: { eq: "context" } },
    });
    expect(job).toMatchObject({
      partial: true,
      yieldedItems: 1,
      fetchedItems: 1,
      requestCount: 1,
    });
    expect(
      (await db.query.posts.findFirst({ where: { iri: { eq: knownIri } } }))
        ?.content,
    ).toBe("Root");
    expect(
      await db.query.posts.findFirst({ where: { iri: { eq: unseen } } }),
    ).toBeUndefined();
    expect(
      (
        await db.query.remoteReplyScrapeJobs.findFirst({
          where: { kind: { eq: "replies" } },
        })
      )?.status,
    ).toBe("pending");
  });

  it("shares the request cap with actor persistence and rolls back incomplete items", async () => {
    const seed = await seedContextJob();
    const id = "https://remote.test/posts/budget";
    const loader = vi.fn(
      makeLoader({
        [seed.repliesIri]: collection(seed.repliesIri, [
          reply({ id, replyTarget: seed.postIri }),
        ]),
        [id]: documentReply({ id, replyTarget: seed.postIri }),
        "https://remote.test/@replyer": actor("replyer"),
      }),
    );
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      maxRequests: 2,
      documentLoader: loader,
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(
      await db.query.posts.findFirst({ where: { iri: { eq: id } } }),
    ).toBeUndefined();
    expect((await db.query.remoteReplyScrapeJobs.findFirst())!).toMatchObject({
      status: "completed",
      partial: true,
      requestCount: 2,
    });
  });

  it("refetches embedded objects and rejects forged, local, and mismatched identities", async () => {
    const seed = await seedContextJob();
    const id = "https://remote.test/posts/forged";
    const local = "https://hollo.test/posts/local";
    const wrongActor = "https://remote.test/posts/foreign-author";
    const good = "https://remote.test/posts/good";
    await seedRemoteAccount("replyer");
    const documents = {
      [seed.repliesIri]: collection(seed.repliesIri, [
        reply({ id, replyTarget: seed.postIri }),
        reply({ id: local, replyTarget: seed.postIri }),
        reply({ id: wrongActor, replyTarget: seed.postIri }),
        reply({ id: good, replyTarget: seed.postIri, content: "Forged" }),
      ]),
      [id]: documentReply({
        id: "https://foreign.test/posts/forged",
        replyTarget: seed.postIri,
      }),
      [wrongActor]: documentReply({
        id: wrongActor,
        replyTarget: seed.postIri,
        host: "foreign.test",
      }),
      [good]: documentReply({
        id: good,
        replyTarget: seed.postIri,
        content: "Authoritative",
      }),
      "https://remote.test/@replyer": actor("replyer"),
    };
    const urls: string[] = [];
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader(documents, (url) => urls.push(url)),
    });
    const saved = await db.query.posts.findMany();
    expect(saved.map((post) => post.iri).sort()).toEqual(
      [seed.postIri, good].sort(),
    );
    expect(saved.find((post) => post.iri === good)?.contentHtml).toBe(
      "<p>Authoritative</p>",
    );
    expect(urls).not.toContain(local);
  });

  it.each([
    ["120", 120],
    ["10000000000000", 7 * 24 * 60 * 60],
    ["9".repeat(400), 7 * 24 * 60 * 60],
    ["Fri, 01 Jan 9999 00:00:00 GMT", 7 * 24 * 60 * 60],
  ] as const)(
    "backs off own-host Retry-After %s and keeps fallbacks gated",
    async (header, seconds) => {
      const seed = await seedContextJob();
      await gateReplies(seed);
      const now = new Date();
      const error = Object.assign(new Error("limited"), {
        response: new Response(null, {
          status: 429,
          headers: { "Retry-After": header },
        }),
      });
      await processDueRemoteReplyScrapeJobs({
        ...contextOptions,
        now,
        documentLoader: async () => {
          throw error;
        },
      });
      const job = await db.query.remoteReplyScrapeJobs.findFirst({
        where: { kind: { eq: "context" } },
      });
      expect(job).toMatchObject({ status: "pending", requestCount: 1 });
      expect(job?.nextAttemptAt).toEqual(new Date(+now + seconds * 1000));
      expect(
        (
          await db.query.remoteReplyScrapeJobs.findFirst({
            where: { kind: { eq: "replies" } },
          })
        )?.status,
      ).toBe("waiting");
    },
  );

  it("skips a foreign host after 429, caches failures, and continues healthy items", async () => {
    const seed = await seedContextJob();
    await gateReplies(seed);
    const bad = "https://foreign.test/posts/bad";
    const later = "https://foreign.test/posts/later";
    const good = "https://remote.test/posts/good";
    await seedRemoteAccount("replyer");
    const base = makeLoader({
      [seed.repliesIri]: collection(seed.repliesIri, [
        reply({ id: bad, replyTarget: seed.postIri }),
        reply({ id: later, replyTarget: seed.postIri }),
        reply({ id: good, replyTarget: seed.postIri }),
      ]),
      [good]: documentReply({ id: good, replyTarget: seed.postIri }),
      "https://remote.test/@replyer": actor("replyer"),
    });
    const urls: string[] = [];
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: async (url) => {
        urls.push(url);
        if (new URL(url).host === "foreign.test")
          throw Object.assign(new Error("foreign limited"), {
            response: new Response(null, {
              status: 429,
              headers: { "Retry-After": "300" },
            }),
          });
        return base(url);
      },
    });
    expect(urls.filter((url) => new URL(url).host === "foreign.test")).toEqual([
      bad,
    ]);
    expect(
      await db.query.posts.findFirst({ where: { iri: { eq: good } } }),
    ).toBeDefined();
    expect(
      (await db.query.remoteReplyScrapeJobs.findFirst({
        where: { kind: { eq: "context" } },
      }))!,
    ).toMatchObject({ status: "completed", partial: true });
  });

  it("merges resolved aliases into a fresh completed job and settles late seed gates", async () => {
    const seed = await seedContextJob();
    const canonical = "https://remote.test/conversation/canonical";
    const winnerId = uuidv7();
    await db.insert(remoteReplyScrapeJobs).values({
      id: winnerId,
      kind: "context",
      postId: seed.postId,
      postIri: seed.postIri,
      repliesIri: canonical,
      originHost: "remote.test",
      baseUrl: "https://hollo.test",
      status: "completed",
      completedAt: new Date(),
    });
    await gateReplies(seed);
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader({
        [seed.repliesIri]: collection(canonical, []),
      }),
    });
    expect(
      await db.query.remoteReplyScrapeJobs.findMany({
        where: { kind: { eq: "context" } },
      }),
    ).toHaveLength(1);
    const alias = await db.query.remoteContextScrapeAliases.findFirst({
      where: { iri: { eq: seed.repliesIri } },
    });
    expect(alias?.jobId).toBe(winnerId);
    expect(
      (
        await db.query.remoteReplyScrapeJobs.findFirst({
          where: { kind: { eq: "replies" } },
        })
      )?.status,
    ).toBe("completed");
  });

  it("replaces expired canonical jobs instead of suppressing a new traversal", async () => {
    const seed = await seedContextJob();
    const canonical = "https://remote.test/conversation/canonical";
    await db.insert(remoteReplyScrapeJobs).values({
      id: uuidv7(),
      kind: "context",
      postId: seed.postId,
      postIri: seed.postIri,
      repliesIri: canonical,
      originHost: "remote.test",
      baseUrl: "https://hollo.test",
      status: "completed",
      completedAt: new Date(0),
    });
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader({
        [seed.repliesIri]: collection(canonical, []),
      }),
    });
    const jobs = await db.query.remoteReplyScrapeJobs.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: seed.jobId,
      repliesIri: canonical,
      status: "completed",
    });
  });
  it("does not hold actor host locks while fetching persistence dependencies", async () => {
    const seed = await seedContextJob();
    const id = "https://remote.test/posts/new-author";
    const followingIri = "https://remote.test/@fresh/following";
    let checked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    try {
      const base = makeLoader({
        [seed.repliesIri]: collection(seed.repliesIri, [
          reply({ id, replyTarget: seed.postIri, username: "fresh" }),
        ]),
        [id]: documentReply({
          id,
          replyTarget: seed.postIri,
          username: "fresh",
        }),
        "https://remote.test/@fresh": {
          ...actor("fresh"),
          preferredUsername: "fresh",
          following: followingIri,
        },
        [followingIri]: collection(followingIri, []),
        "https://remote.test/@fresh/followers": collection(
          "https://remote.test/@fresh/followers",
          [],
        ),
      });
      await processDueRemoteReplyScrapeJobs({
        ...contextOptions,
        documentLoader: async (url) => {
          if (url === followingIri) {
            await db.transaction(async (tx) => {
              await tx.execute(
                sql`select host from ${instances} where host = 'remote.test' for update nowait`,
              );
            });
            checked = true;
          }
          return base(url);
        },
      });
      expect(checked).toBe(true);
      expect(
        await db.query.posts.findFirst({ where: { iri: { eq: id } } }),
      ).toBeDefined();
      expect((await db.query.remoteReplyScrapeJobs.findFirst())?.partial).toBe(
        false,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("leaves an interrupted poll unsaved and retries it completely", async () => {
    const seed = await seedContextJob();
    const id = "https://remote.test/posts/poll";
    const option = "https://remote.test/posts/poll/choice";
    await seedRemoteAccount("replyer");
    const controller = new AbortController();
    const documents = {
      [seed.repliesIri]: collection(seed.repliesIri, [
        reply({ id, replyTarget: seed.postIri }),
      ]),
      [id]: {
        ...documentReply({ id, replyTarget: seed.postIri }),
        type: "Question",
        oneOf: option,
        endTime: "2030-01-01T00:00:00Z",
      },
      [option]: {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: option,
        type: "Note",
        name: "Yes",
      },
      "https://remote.test/@replyer": actor("replyer"),
    };
    const base = makeLoader(documents);
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      signal: controller.signal,
      documentLoader: async (url) => {
        if (url === option)
          controller.abort(new Error("shutdown during preparation"));
        return base(url);
      },
    });
    expect(
      await db.query.posts.findFirst({ where: { iri: { eq: id } } }),
    ).toBeUndefined();
    expect((await db.query.remoteReplyScrapeJobs.findFirst())?.status).toBe(
      "pending",
    );
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: base,
    });
    const post = await db.query.posts.findFirst({ where: { iri: { eq: id } } });
    expect(post?.pollId).toBeTruthy();
    expect(await db.query.pollOptions.findMany()).toHaveLength(1);
  });
  it("exposes reconstructed context through the API with privacy, mute, and block filtering", async () => {
    const { default: app } = await import("../index");
    const viewer = await createAccount();
    const client = await createOAuthApplication({ scopes: ["read:statuses"] });
    const token = await getAccessToken(client, viewer, ["read:statuses"]);
    const seed = await seedContextJob();
    const author = await seedRemoteAccount("replyer");
    const visible = "https://remote.test/posts/public";
    const privateIri = "https://remote.test/posts/private";
    const documents = {
      [seed.repliesIri]: collection(seed.repliesIri, [
        reply({ id: visible, replyTarget: seed.postIri }),
        reply({ id: privateIri, replyTarget: seed.postIri }),
      ]),
      [visible]: documentReply({ id: visible, replyTarget: seed.postIri }),
      [privateIri]: {
        ...documentReply({ id: privateIri, replyTarget: seed.postIri }),
        to: "https://remote.test/@replyer/followers",
      },
      "https://remote.test/@replyer": actor("replyer"),
    };
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader(documents),
    });
    const publicPost = await db.query.posts.findFirst({
      where: { iri: { eq: visible } },
    });
    const path = `/api/v1/statuses/${seed.postId}/context`;
    const headers = { authorization: bearerAuthorization(token) };
    const anonymous = await app.request(path);
    expect(anonymous.status).toBe(200);
    expect(
      (await anonymous.json()).descendants.map(
        (post: { id: string }) => post.id,
      ),
    ).toEqual([publicPost!.id]);
    const authenticated = await app.request(path, { headers });
    expect((await authenticated.json()).descendants).toHaveLength(1);
    const childContext = await app.request(
      `/api/v1/statuses/${publicPost!.id}/context`,
    );
    expect((await childContext.json()).ancestors[0].id).toBe(seed.postId);
    await db.insert(mutes).values({
      id: uuidv7(),
      accountId: viewer.id,
      mutedAccountId: author.id,
    });
    expect(
      (await (await app.request(path, { headers })).json()).descendants,
    ).toHaveLength(0);
    await db.delete(mutes);
    await db
      .insert(blocks)
      .values({ accountId: viewer.id, blockedAccountId: author.id });
    expect(
      (await (await app.request(path, { headers })).json()).descendants,
    ).toHaveLength(0);
    const timelineBefore = await db.query.timelinePosts.findMany();
    await db
      .update(remoteReplyScrapeJobs)
      .set({
        status: "pending",
        completedAt: null,
        nextAttemptAt: new Date(0),
        nextDispatchAt: new Date(0),
      })
      .where(eq(remoteReplyScrapeJobs.id, seed.jobId));
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader(documents),
    });
    expect(await db.query.timelinePosts.findMany()).toEqual(timelineBefore);
    expect(await db.query.notifications.findMany()).toHaveLength(0);
    expect(
      (await db.query.posts.findFirst({ where: { id: { eq: seed.postId } } }))
        ?.repliesCount,
    ).toBe(2);
  });
  it.each(["child-first", "parent-first"])(
    "applies home and list reply policies with %s context items",
    async (order) => {
      const seed = await seedContextJob();
      const viewer = await createAccount();
      const childAuthor = await seedRemoteAccount("replyer");
      const parentAuthor = await seedRemoteAccount("parent");
      await db.insert(follows).values({
        iri: `https://local.test/follows/${uuidv7()}`,
        followerId: viewer.id,
        followingId: childAuthor.id,
        approved: new Date(),
      });
      const excludedList = uuidv7();
      const includedList = uuidv7();
      await db.insert(lists).values([
        {
          id: excludedList,
          accountOwnerId: viewer.id,
          title: "No replies",
          repliesPolicy: "none",
        },
        {
          id: includedList,
          accountOwnerId: viewer.id,
          title: "Member replies",
          repliesPolicy: "list",
        },
      ]);
      await db.insert(listMembers).values([
        { listId: excludedList, accountId: childAuthor.id },
        { listId: includedList, accountId: childAuthor.id },
        { listId: includedList, accountId: parentAuthor.id },
      ]);
      const childIri = "https://remote.test/posts/child";
      const parentIri = "https://remote.test/posts/parent";
      const child = reply({ id: childIri, replyTarget: parentIri });
      const parent = {
        ...reply({ id: parentIri, replyTarget: seed.postIri }),
        attributedTo: parentAuthor.iri,
      };
      await processDueRemoteReplyScrapeJobs({
        ...contextOptions,
        documentLoader: makeLoader({
          [seed.repliesIri]: collection(
            seed.repliesIri,
            order === "child-first" ? [child, parent] : [parent, child],
          ),
          [childIri]: {
            "@context": "https://www.w3.org/ns/activitystreams",
            ...child,
          },
          [parentIri]: {
            "@context": "https://www.w3.org/ns/activitystreams",
            ...parent,
          },
          [childAuthor.iri]: actor("replyer"),
          [parentAuthor.iri]: actor("parent"),
        }),
      });
      const savedChild = await db.query.posts.findFirst({
        where: { iri: { eq: childIri } },
      });
      const savedParent = await db.query.posts.findFirst({
        where: { iri: { eq: parentIri } },
      });
      expect(savedChild?.replyTargetId).toBe(savedParent?.id);
      expect(
        await db.query.timelinePosts.findMany({
          where: { postId: { eq: savedChild!.id } },
        }),
      ).toEqual([]);
      expect(
        (
          await db.query.listPosts.findMany({
            where: { postId: { eq: savedChild!.id } },
          })
        ).map((row) => row.listId),
      ).toEqual([includedList]);
    },
  );
  it("terminates cached quote cycles within the shared request budget", async () => {
    const seed = await seedContextJob();
    await seedRemoteAccount("replyer");
    const first = "https://remote.test/posts/quote-a";
    const second = "https://remote.test/posts/quote-b";
    const quoted = async (id: string, other: string) =>
      new Note({
        id: new URL(id),
        attribution: new URL("https://remote.test/@replyer"),
        replyTarget: new URL(seed.postIri),
        quote: new URL(other),
        to: new URL(PUBLIC_COLLECTION),
        content: "Quote",
      }).toJsonLd();
    const loader = vi.fn(
      makeLoader({
        [seed.repliesIri]: collection(seed.repliesIri, [
          reply({ id: first, replyTarget: seed.postIri }),
        ]),
        [first]: await quoted(first, second),
        [second]: await quoted(second, first),
        "https://remote.test/@replyer": actor("replyer"),
      }),
    );
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      maxRequests: 4,
      documentLoader: loader,
    });
    expect((await db.query.remoteReplyScrapeJobs.findFirst())?.status).toBe(
      "completed",
    );
    expect(loader).toHaveBeenCalledTimes(4);
    expect(await db.query.posts.findMany()).toHaveLength(3);
  });

  it("terminates actor successor cycles with a successful document cache", async () => {
    const seed = await seedContextJob();
    const id = "https://remote.test/posts/actor-cycle";
    const first = "https://remote.test/@cycle-a";
    const second = "https://remote.test/@cycle-b";
    const person = async (iri: string, successor: string, username: string) =>
      new Person({
        id: new URL(iri),
        name: username,
        preferredUsername: username,
        inbox: new URL(`${iri}/inbox`),
        successor: new URL(successor),
      }).toJsonLd();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    try {
      const loader = vi.fn(
        makeLoader({
          [seed.repliesIri]: collection(seed.repliesIri, [
            reply({ id, replyTarget: seed.postIri, username: "cycle-a" }),
          ]),
          [id]: documentReply({
            id,
            replyTarget: seed.postIri,
            username: "cycle-a",
          }),
          [first]: await person(first, second, "cycle-a"),
          [second]: await person(second, first, "cycle-b"),
        }),
      );
      await processDueRemoteReplyScrapeJobs({
        ...contextOptions,
        maxRequests: 4,
        documentLoader: loader,
      });
      expect((await db.query.remoteReplyScrapeJobs.findFirst())?.status).toBe(
        "completed",
      );
      expect(
        await db.query.posts.findFirst({ where: { iri: { eq: id } } }),
      ).toBeDefined();
      expect(loader).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hands redirected context identity to its canonical host before traversal", async () => {
    const seed = await seedContextJob();
    await gateReplies(seed);
    const canonical = "https://canonical.test/conversation/1";
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: async () => ({
        contextUrl: null,
        documentUrl: canonical,
        document: collection(canonical, []),
      }),
    });
    expect(
      (await db.query.remoteReplyScrapeJobs.findFirst({
        where: { id: { eq: seed.jobId } },
      }))!,
    ).toMatchObject({
      status: "pending",
      originHost: "canonical.test",
      hostRequeues: 1,
    });
    expect(
      (
        await db.query.remoteReplyScrapeOrigins.findFirst({
          where: { originHost: { eq: "remote.test" } },
        })
      )?.processingJobId,
    ).toBeNull();
    const urls: string[] = [];
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader(
        { [canonical]: collection(canonical, []) },
        (url) => urls.push(url),
      ),
    });
    expect(urls).toEqual([canonical]);
    expect(
      (
        await db.query.remoteReplyScrapeJobs.findFirst({
          where: { kind: { eq: "replies" } },
        })
      )?.status,
    ).toBe("completed");
  });
  it("accepts Create wrappers, deduplicates posts, and skips other activities", async () => {
    const seed = await seedContextJob();
    await seedRemoteAccount("replyer");
    const id = "https://remote.test/posts/created";
    const updated = "https://remote.test/posts/update-only";
    const note = reply({ id, replyTarget: seed.postIri });
    const urls: string[] = [];
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader(
        {
          [seed.repliesIri]: collection(seed.repliesIri, [
            {
              id: `${id}#create`,
              type: "Create",
              actor: "https://remote.test/@replyer",
              object: note,
            },
            note,
            {
              id: `${updated}#update`,
              type: "Update",
              actor: "https://remote.test/@replyer",
              object: reply({ id: updated, replyTarget: seed.postIri }),
            },
            {
              id: `${updated}#delete`,
              type: "Delete",
              actor: "https://remote.test/@replyer",
              object: updated,
            },
          ]),
          [id]: documentReply({ id, replyTarget: seed.postIri }),
          "https://remote.test/@replyer": actor("replyer"),
        },
        (url) => urls.push(url),
      ),
    });
    expect(
      await db.query.posts.findFirst({ where: { iri: { eq: id } } }),
    ).toBeDefined();
    expect(
      await db.query.posts.findFirst({ where: { iri: { eq: updated } } }),
    ).toBeUndefined();
    expect(urls).not.toContain(updated);
    expect(urls.filter((url) => url === id)).toHaveLength(1);
    expect((await db.query.remoteReplyScrapeJobs.findFirst())!).toMatchObject({
      status: "completed",
      fetchedItems: 1,
    });
  });

  it("falls back for a resolved non-collection context", async () => {
    const seed = await seedContextJob();
    await gateReplies(seed);
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader({
        [seed.repliesIri]: documentReply({
          id: seed.repliesIri,
          replyTarget: seed.postIri,
        }),
      }),
    });
    expect(
      (
        await db.query.remoteReplyScrapeJobs.findFirst({
          where: { kind: { eq: "context" } },
        })
      )?.status,
    ).toBe("failed");
    expect(
      (
        await db.query.remoteReplyScrapeJobs.findFirst({
          where: { kind: { eq: "replies" } },
        })
      )?.status,
    ).toBe("pending");
  });
  it("repairs the stored seed when its missing parent is in the collection", async () => {
    const seed = await seedContextJob();
    const parent = "https://remote.test/posts/seed-parent";
    await seedRemoteAccount("replyer");
    const documents = {
      [seed.repliesIri]: collection(seed.repliesIri, [
        reply({ id: seed.postIri, replyTarget: parent, username: "author" }),
        reply({ id: parent, replyTarget: "https://remote.test/posts/deleted" }),
      ]),
      [seed.postIri]: documentReply({
        id: seed.postIri,
        replyTarget: parent,
        username: "author",
      }),
      [parent]: documentReply({
        id: parent,
        replyTarget: "https://remote.test/posts/deleted",
      }),
      "https://remote.test/@replyer": actor("replyer"),
    };
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader(documents),
    });
    const parentPost = await db.query.posts.findFirst({
      where: { iri: { eq: parent } },
    });
    const seedPost = await db.query.posts.findFirst({
      where: { id: { eq: seed.postId } },
    });
    expect(seedPost?.replyTargetId).toBe(parentPost?.id);
    expect(seedPost?.content).toBe("Root");
    expect(parentPost?.repliesCount).toBe(1);
  });

  it("repairs verified orphan links locally when the request cap stops traversal", async () => {
    const seed = await seedContextJob();
    await seedRemoteAccount("replyer");
    const child = "https://remote.test/posts/capped-child";
    const parent = "https://remote.test/posts/capped-parent";
    const unseen = "https://remote.test/posts/capped-unseen";
    const loader = vi.fn(
      makeLoader({
        [seed.repliesIri]: collection(seed.repliesIri, [
          reply({ id: child, replyTarget: parent }),
          reply({ id: parent, replyTarget: seed.postIri }),
          reply({ id: unseen, replyTarget: seed.postIri }),
        ]),
        [child]: documentReply({ id: child, replyTarget: parent }),
        [parent]: documentReply({ id: parent, replyTarget: seed.postIri }),
        "https://remote.test/@replyer": actor("replyer"),
      }),
    );
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      maxRequests: 4,
      documentLoader: loader,
    });
    const parentPost = await db.query.posts.findFirst({
      where: { iri: { eq: parent } },
    });
    expect(
      (await db.query.posts.findFirst({ where: { iri: { eq: child } } }))
        ?.replyTargetId,
    ).toBe(parentPost?.id);
    expect(parentPost?.repliesCount).toBe(1);
    expect(loader).toHaveBeenCalledTimes(4);
    expect((await db.query.remoteReplyScrapeJobs.findFirst())!).toMatchObject({
      status: "completed",
      partial: true,
    });
  });

  it.each(["first", "next", "embedded"])(
    "releases fallback when a %s page is a Note",
    async (kind) => {
      const seed = await seedContextJob();
      await gateReplies(seed);
      const invalid = `${seed.repliesIri}/invalid`;
      const badPage = documentReply({ id: invalid, replyTarget: seed.postIri });
      const root =
        kind === "next"
          ? {
              ...collection(seed.repliesIri, []),
              first: {
                id: `${seed.repliesIri}/first`,
                type: "OrderedCollectionPage",
                next: invalid,
                orderedItems: [],
              },
            }
          : {
              ...collection(seed.repliesIri, []),
              first: kind === "embedded" ? badPage : invalid,
            };
      await processDueRemoteReplyScrapeJobs({
        ...contextOptions,
        documentLoader: makeLoader({
          [seed.repliesIri]: root,
          [invalid]: badPage,
        }),
      });
      expect(
        (await db.query.remoteReplyScrapeJobs.findFirst({
          where: { kind: { eq: "context" } },
        }))!,
      ).toMatchObject({
        status: kind === "embedded" ? "failed" : "completed",
        partial: true,
      });
      expect(
        (
          await db.query.remoteReplyScrapeJobs.findFirst({
            where: { kind: { eq: "replies" } },
          })
        )?.status,
      ).toBe("pending");
    },
  );
  it("still follows valid next pages after inspecting their references", async () => {
    const seed = await seedContextJob();
    await seedRemoteAccount("replyer");
    const first = `${seed.repliesIri}/first`;
    const second = `${seed.repliesIri}/second`;
    const id = "https://remote.test/posts/next-page";
    const urls: string[] = [];
    await processDueRemoteReplyScrapeJobs({
      ...contextOptions,
      documentLoader: makeLoader(
        {
          [seed.repliesIri]: { ...collection(seed.repliesIri, []), first },
          [first]: {
            "@context": "https://www.w3.org/ns/activitystreams",
            id: first,
            type: "OrderedCollectionPage",
            next: second,
            orderedItems: [],
          },
          [second]: {
            "@context": "https://www.w3.org/ns/activitystreams",
            id: second,
            type: "OrderedCollectionPage",
            orderedItems: [reply({ id, replyTarget: seed.postIri })],
          },
          [id]: documentReply({ id, replyTarget: seed.postIri }),
          "https://remote.test/@replyer": actor("replyer"),
        },
        (url) => urls.push(url),
      ),
    });
    expect(urls).toContain(second);
    expect(
      await db.query.posts.findFirst({ where: { iri: { eq: id } } }),
    ).toBeDefined();
    expect((await db.query.remoteReplyScrapeJobs.findFirst())!).toMatchObject({
      status: "completed",
      partial: false,
    });
  });
  it.each(["replies", "context"] as const)(
    "completes %s jobs with intervals above 60 seconds while keeping the lease fresh",
    async (kind) => {
      const seed =
        kind === "context"
          ? await seedContextJob()
          : await seedPostWithScrapeJob();
      await seedRemoteAccount("replyer");
      const now = new Date("2026-04-25T00:00:00Z");
      let time = +now;
      const clock = () => new Date(time);
      const recovery = fixture({ clock, staleProcessingSeconds: 15 });
      const id = "https://remote.test/posts/long-spacing";
      const times: number[] = [];
      const leaseStates: (string | undefined)[] = [];
      await processDueRemoteReplyScrapeJobs({
        now,
        clock,
        intervalSeconds: 120,
        staleProcessingSeconds: 15,
        sleep: async (ms) => {
          time += ms;
          if ((time - +now) % 60_000 === 0) {
            await recovery.tasks.reclaim();
            leaseStates.push(
              (
                await db.query.remoteReplyScrapeJobs.findFirst({
                  where: { id: { eq: seed.jobId } },
                })
              )?.status,
            );
          }
        },
        documentLoader: makeLoader(
          {
            [seed.repliesIri]: collection(seed.repliesIri, [
              reply({ id, replyTarget: seed.postIri }),
            ]),
            [id]: documentReply({ id, replyTarget: seed.postIri }),
            "https://remote.test/@replyer": actor("replyer"),
          },
          () => times.push(time),
        ),
      });
      expect(
        (await db.query.remoteReplyScrapeJobs.findFirst({
          where: { id: { eq: seed.jobId } },
        }))!,
      ).toMatchObject({ status: "completed", fetchedItems: 1, attempts: 1 });
      expect(
        await db.query.posts.findFirst({ where: { iri: { eq: id } } }),
      ).toBeDefined();
      expect(leaseStates.length).toBeGreaterThan(0);
      expect(new Set(leaseStates)).toEqual(new Set(["processing"]));
      for (let i = 1; i < times.length; i++)
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(120_000);
    },
  );
});
