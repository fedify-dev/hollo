import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import db from "../db";
import { accounts, instances, posts, remoteReplyScrapeJobs } from "../schema";
import type { Uuid } from "../uuid";
import { uuidv7 } from "../uuid";
import {
  countActiveRemoteReplyScrapeJobs,
  enqueueRemoteReplyScrape,
} from "./replies";

async function seedRemotePost() {
  const accountId = crypto.randomUUID() as Uuid;
  await db.insert(instances).values({
    host: "remote.test",
    software: "mastodon",
    softwareVersion: null,
  });
  await db.insert(accounts).values({
    id: accountId,
    iri: "https://remote.test/@author",
    type: "Person",
    name: "author",
    handle: "@author@remote.test",
    bioHtml: "",
    emojis: {},
    fieldHtmls: {},
    aliases: [],
    protected: false,
    inboxUrl: "https://remote.test/@author/inbox",
    followersUrl: "https://remote.test/@author/followers",
    sharedInboxUrl: "https://remote.test/inbox",
    featuredUrl: "https://remote.test/@author/featured",
    instanceHost: "remote.test",
    published: new Date(),
  });

  const postId = uuidv7();
  await db.insert(posts).values({
    id: postId,
    iri: "https://remote.test/@author/posts/1",
    type: "Note",
    accountId,
    visibility: "public",
    contentHtml: "<p>Hello</p>",
    content: "Hello",
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });

  const post = await db.query.posts.findFirst({
    where: { id: { eq: postId } },
  });
  if (post == null) throw new Error("Failed to seed post");
  return post;
}

describe("enqueueRemoteReplyScrape", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("deduplicates concurrent jobs for the same replies collection", async () => {
    expect.assertions(1);
    const post = await seedRemotePost();
    const repliesIri = new URL("https://remote.test/@author/posts/1/replies");

    await Promise.all(
      Array.from({ length: 20 }, () =>
        enqueueRemoteReplyScrape(db, {
          baseUrl: "https://hollo.test",
          post,
          repliesIri,
        }),
      ),
    );

    const jobs = await db
      .select()
      .from(remoteReplyScrapeJobs)
      .where(eq(remoteReplyScrapeJobs.repliesIri, repliesIri.href));
    expect(jobs).toHaveLength(1);
  });

  it("counts active jobs for a replies collection", async () => {
    expect.assertions(1);
    const post = await seedRemotePost();
    const repliesIri = new URL("https://remote.test/@author/posts/1/replies");
    const otherRepliesIri = new URL(
      "https://remote.test/@author/posts/2/replies",
    );

    await db.insert(remoteReplyScrapeJobs).values([
      {
        id: uuidv7(),
        postId: post.id,
        postIri: post.iri,
        repliesIri: repliesIri.href,
        baseUrl: "https://hollo.test",
        originHost: repliesIri.host,
        status: "processing",
      },
      {
        id: uuidv7(),
        postId: post.id,
        postIri: post.iri,
        repliesIri: otherRepliesIri.href,
        baseUrl: "https://hollo.test",
        originHost: otherRepliesIri.host,
        status: "completed",
      },
      {
        id: uuidv7(),
        postId: post.id,
        postIri: post.iri,
        repliesIri: "https://remote.test/@author/posts/3/replies",
        baseUrl: "https://hollo.test",
        originHost: "remote.test",
        status: "pending",
      },
    ]);

    await expect(
      countActiveRemoteReplyScrapeJobs(db, repliesIri),
    ).resolves.toBe(1);
  });

  it("re-enqueues recently failed jobs without completed cooldown", async () => {
    expect.assertions(4);
    const post = await seedRemotePost();
    const repliesIri = new URL("https://remote.test/@author/posts/1/replies");
    const failedAt = new Date();

    await db.insert(remoteReplyScrapeJobs).values({
      id: uuidv7(),
      postId: post.id,
      postIri: post.iri,
      repliesIri: repliesIri.href,
      baseUrl: "https://hollo.test",
      originHost: repliesIri.host,
      status: "failed",
      attempts: 2,
      errorMessage: "temporary failure",
      completedAt: failedAt,
      startedAt: failedAt,
      fetchedItems: 3,
    });

    await enqueueRemoteReplyScrape(db, {
      baseUrl: "https://hollo.test",
      post,
      repliesIri,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { repliesIri: { eq: repliesIri.href } },
    });
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(0);
    expect(job?.completedAt).toBeNull();
    expect(job?.errorMessage).toBeNull();
  });

  it("keeps recently completed jobs in cooldown", async () => {
    expect.assertions(2);
    const post = await seedRemotePost();
    const repliesIri = new URL("https://remote.test/@author/posts/1/replies");
    const completedAt = new Date();

    await db.insert(remoteReplyScrapeJobs).values({
      id: uuidv7(),
      postId: post.id,
      postIri: post.iri,
      repliesIri: repliesIri.href,
      baseUrl: "https://hollo.test",
      originHost: repliesIri.host,
      status: "completed",
      attempts: 2,
      completedAt,
      fetchedItems: 3,
    });

    await enqueueRemoteReplyScrape(db, {
      baseUrl: "https://hollo.test",
      post,
      repliesIri,
    });

    const job = await db.query.remoteReplyScrapeJobs.findFirst({
      where: { repliesIri: { eq: repliesIri.href } },
    });
    expect(job?.status).toBe("completed");
    expect(job?.attempts).toBe(2);
  });
});

it("commits creation even if post-commit dispatch fails", async () => {
  await cleanDatabase();
  const post = await seedRemotePost();
  const { replyScrapes } = await import("./federation");
  const enqueue = vi
    .spyOn(replyScrapes, "enqueue")
    .mockRejectedValue(new Error("queue offline"));
  try {
    await enqueueRemoteReplyScrape(db, {
      baseUrl: "https://hollo.test",
      post,
      repliesIri: new URL(post.iri + "/replies"),
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await db.query.remoteReplyScrapeJobs.findFirst()).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  } finally {
    enqueue.mockRestore();
  }
});

it("concurrent cooldown refreshes cannot reset an active generation", async () => {
  await cleanDatabase();
  const post = await seedRemotePost();
  const iri = new URL(post.iri + "/replies");
  await db.insert(remoteReplyScrapeJobs).values({
    id: uuidv7(),
    postId: post.id,
    postIri: post.iri,
    repliesIri: iri.href,
    baseUrl: "https://hollo.test",
    originHost: iri.host,
    status: "completed",
    completedAt: new Date(0),
    attempts: 7,
  });
  const { replyScrapes } = await import("./federation");
  const enqueue = vi
    .spyOn(replyScrapes, "enqueue")
    .mockResolvedValue(undefined);
  try {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        enqueueRemoteReplyScrape(db, {
          baseUrl: "https://hollo.test",
          post,
          repliesIri: iri,
        }),
      ),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await db.query.remoteReplyScrapeJobs.findFirst()).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  } finally {
    enqueue.mockRestore();
  }
});
