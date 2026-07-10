import type { RemoteDocument } from "@fedify/vocab";
import { eq } from "drizzle-orm";
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
import {
  claimRemoteReplyScrapeJob,
  processDueRemoteReplyScrapeJobs,
  runRemoteReplyScrapeWorkerPoll,
} from "./replies-worker";

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
    const { federation } = await import("./index");
    const createContext = vi
      .spyOn(federation, "createContext")
      .mockReturnValue({
        documentLoader: anonymousLoader,
        getDocumentLoader,
      } as never);

    try {
      const processed = await processDueRemoteReplyScrapeJobs({
        maxItems: 1,
        sleep: async () => undefined,
      });

      const persistedReply = await db.query.posts.findFirst({
        where: { iri: { eq: replyIri } },
      });
      expect(processed).toBe(1);
      expect(persistedReply?.iri).toBe(replyIri);
      expect(createContext.mock.calls[0]?.[0].url).toBe("https://hollo.test/");
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
    expect(staleJob?.status).toBe("completed");
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

  it("skips overlapping worker polls in the same process", async () => {
    expect.assertions(2);
    let releasePoll: (() => void) | undefined;
    let calls = 0;

    const firstPoll = runRemoteReplyScrapeWorkerPoll(async () => {
      calls++;
      await new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
    });
    await Promise.resolve();

    await runRemoteReplyScrapeWorkerPoll(async () => {
      calls++;
    });
    expect(calls).toBe(1);

    releasePoll?.();
    await firstPoll;
    await runRemoteReplyScrapeWorkerPoll(async () => {
      calls++;
    });
    expect(calls).toBe(2);
  });
});
