import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../../tests/helpers/oauth";
import db from "../../db";
import app from "../../index";
import {
  accounts,
  blocks,
  follows,
  instances,
  listMembers,
  listPosts,
  lists,
  media,
  mentions,
  mutes,
  posts,
  timelinePosts,
} from "../../schema";
import type { Uuid } from "../../uuid";
import { uuidv7 } from "../../uuid";
import { timelineQuerySchema } from "./timelines";

const timelineInboxMode = vi.hoisted(() => ({
  override: undefined as boolean | undefined,
}));

vi.mock("../../federation/timeline", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../federation/timeline")>();
  return {
    ...original,
    get TIMELINE_INBOXES() {
      return timelineInboxMode.override ?? original.TIMELINE_INBOXES;
    },
  };
});

describe("timelineQuerySchema", () => {
  it("caps large limits and keeps the lower bound at one", () => {
    expect.assertions(3);

    expect(timelineQuerySchema.parse({}).limit).toBe(20);
    expect(timelineQuerySchema.parse({ limit: "0" }).limit).toBe(1);
    expect(timelineQuerySchema.parse({ limit: "100000" }).limit).toBe(1000);
  });
});

describe.sequential("/api/v1/timelines/list/:list_id", () => {
  let owner: Awaited<ReturnType<typeof createAccount>>;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    owner = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:lists", "write"],
    });
    accessToken = await getAccessToken(client, owner, ["read:lists"]);
  });

  it("serializes mention URLs and attachment types compatibly for list timelines", async () => {
    expect.assertions(8);

    const listId = uuidv7();
    const authorId = crypto.randomUUID() as Uuid;
    const mentionedId = crypto.randomUUID() as Uuid;
    const postId = uuidv7();
    const mediaId = uuidv7();

    await db
      .insert(instances)
      .values({ host: "remote.test" })
      .onConflictDoNothing();

    await db.insert(lists).values({
      id: listId,
      accountOwnerId: owner.id,
      title: "Remote list",
      repliesPolicy: "list",
      exclusive: false,
    });

    await db.insert(accounts).values([
      {
        id: authorId,
        iri: "https://remote.test/users/author",
        instanceHost: "remote.test",
        type: "Person",
        name: "Remote author",
        emojis: {},
        handle: "@author@remote.test",
        bioHtml: "",
        url: "https://remote.test/@author",
        protected: false,
        inboxUrl: "https://remote.test/users/author/inbox",
      },
      {
        id: mentionedId,
        iri: "https://remote.test/users/mentioned",
        instanceHost: "remote.test",
        type: "Person",
        name: "Remote mentioned",
        emojis: {},
        handle: "@mentioned@remote.test",
        bioHtml: "",
        url: null,
        protected: false,
        inboxUrl: "https://remote.test/users/mentioned/inbox",
      },
    ]);

    await db.insert(listMembers).values({
      listId,
      accountId: authorId,
    });

    await db.insert(posts).values({
      id: postId,
      iri: `https://remote.test/notes/${postId}`,
      type: "Note",
      accountId: authorId,
      visibility: "public",
      content: "Post with mention and unsupported attachment",
      contentHtml: "<p>Post with mention and unsupported attachment</p>",
      published: new Date(),
    });

    await db.insert(mentions).values({
      postId,
      accountId: mentionedId,
    });

    await db.insert(media).values({
      id: mediaId,
      postId,
      type: "application/pdf",
      url: `https://remote.test/media/${mediaId}.pdf`,
      width: 640,
      height: 480,
      thumbnailType: "image/png",
      thumbnailUrl: `https://remote.test/media/${mediaId}.png`,
      thumbnailWidth: 320,
      thumbnailHeight: 240,
    });

    await db.insert(listPosts).values({ listId, postId });

    const response = await app.request(`/api/v1/timelines/list/${listId}`, {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const json = await response.json();

    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0].mentions[0].url).toBe("https://remote.test/users/mentioned");
    expect(json[0].mentions[0].acct).toBe("mentioned@remote.test");
    expect(json[0].media_attachments[0].type).toBe("unknown");
  });

  it("returns an empty list page above the newest post", async () => {
    expect.assertions(4);

    const listId = uuidv7();
    const authorId = crypto.randomUUID() as Uuid;
    const postId = uuidv7();

    await db
      .insert(instances)
      .values({ host: "remote.test" })
      .onConflictDoNothing();

    await db.insert(lists).values({
      id: listId,
      accountOwnerId: owner.id,
      title: "Remote list",
      repliesPolicy: "list",
      exclusive: false,
    });

    await db.insert(accounts).values({
      id: authorId,
      iri: "https://remote.test/users/author",
      instanceHost: "remote.test",
      type: "Person",
      name: "Remote author",
      emojis: {},
      handle: "@author@remote.test",
      bioHtml: "",
      url: "https://remote.test/@author",
      protected: false,
      inboxUrl: "https://remote.test/users/author/inbox",
    });

    await db.insert(listMembers).values({
      listId,
      accountId: authorId,
    });

    await db.insert(posts).values({
      id: postId,
      iri: `https://remote.test/notes/${postId}`,
      type: "Note",
      accountId: authorId,
      visibility: "public",
      content: "Newest list post",
      contentHtml: "<p>Newest list post</p>",
      published: new Date(),
    });

    const response = await app.request(
      `/api/v1/timelines/list/${listId}?since_id=${postId}`,
      {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Link")).toBeNull();

    const json = await response.json();

    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(0);
  });

  it("fills list inbox pages after filtering muted posts", async () => {
    expect.assertions(4);

    const listId = uuidv7();
    const visibleAuthor = await createAccount({ username: "list-visible" });
    const mutedAuthor = await createAccount({ username: "list-muted" });
    const visiblePostId = uuidv7();
    const mutedPostId = uuidv7();

    await db.insert(lists).values({
      id: listId,
      accountOwnerId: owner.id,
      title: "Filtered list",
      repliesPolicy: "list",
      exclusive: false,
    });

    await db.insert(listMembers).values([
      { listId, accountId: visibleAuthor.id },
      { listId, accountId: mutedAuthor.id },
    ]);

    await db.insert(mutes).values({
      id: uuidv7(),
      accountId: owner.id,
      mutedAccountId: mutedAuthor.id,
    });

    await db.insert(posts).values([
      {
        id: visiblePostId,
        iri: `https://hollo.test/@list-visible/${visiblePostId}`,
        type: "Note",
        accountId: visibleAuthor.id,
        visibility: "public",
        content: "Visible list post",
        contentHtml: "<p>Visible list post</p>",
        published: new Date(),
      },
      {
        id: mutedPostId,
        iri: `https://hollo.test/@list-muted/${mutedPostId}`,
        type: "Note",
        accountId: mutedAuthor.id,
        visibility: "public",
        content: "Muted list post",
        contentHtml: "<p>Muted list post</p>",
        published: new Date(),
      },
    ]);

    await db.insert(listPosts).values([
      { listId, postId: visiblePostId },
      { listId, postId: mutedPostId },
    ]);

    const response = await app.request(
      `/api/v1/timelines/list/${listId}?limit=1`,
      {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      },
    );

    expect(response.status).toBe(200);

    const json = await response.json();

    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe(visiblePostId);
  });
});
describe.sequential("/api/v1/timelines/home", () => {
  let owner: Awaited<ReturnType<typeof createAccount>>;
  let approvedAuthor: Awaited<ReturnType<typeof createAccount>>;
  let pendingAuthor: Awaited<ReturnType<typeof createAccount>>;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    owner = await createAccount({ username: "timeline-owner" });
    approvedAuthor = await createAccount({ username: "timeline-approved" });
    pendingAuthor = await createAccount({ username: "timeline-pending" });
    client = await createOAuthApplication({
      scopes: ["read:statuses"],
    });
    accessToken = await getAccessToken(client, owner, ["read:statuses"]);

    await db.insert(follows).values([
      {
        iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
        followingId: approvedAuthor.id,
        followerId: owner.id,
        approved: new Date(),
      },
      {
        iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
        followingId: pendingAuthor.id,
        followerId: owner.id,
        approved: null,
      },
    ]);
  });

  it("includes private posts from approved follows only", async () => {
    expect.assertions(4);

    const approvedPostId = uuidv7();
    const pendingPostId = uuidv7();

    await db.insert(posts).values([
      {
        id: approvedPostId,
        iri: `https://hollo.test/@timeline-approved/${approvedPostId}`,
        type: "Note",
        accountId: approvedAuthor.id,
        visibility: "private",
        content: "Approved timeline post",
        contentHtml: "<p>Approved timeline post</p>",
        published: new Date(),
      },
      {
        id: pendingPostId,
        iri: `https://hollo.test/@timeline-pending/${pendingPostId}`,
        type: "Note",
        accountId: pendingAuthor.id,
        visibility: "private",
        content: "Pending timeline post",
        contentHtml: "<p>Pending timeline post</p>",
        published: new Date(),
      },
    ]);

    await db
      .insert(timelinePosts)
      .values({ accountId: owner.id, postId: approvedPostId });

    const response = await app.request("/api/v1/timelines/home", {
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();
    const ids = json.map((status: { id: string }) => status.id);

    expect(json).toHaveLength(1);
    expect(ids).toEqual([approvedPostId]);
  });

  it("fills home inbox pages after filtering muted posts", async () => {
    expect.assertions(4);

    const visiblePostId = uuidv7();
    const mutedPostId = uuidv7();

    await db.insert(mutes).values({
      id: uuidv7(),
      accountId: owner.id,
      mutedAccountId: pendingAuthor.id,
    });

    await db.insert(posts).values([
      {
        id: visiblePostId,
        iri: `https://hollo.test/@timeline-approved/${visiblePostId}`,
        type: "Note",
        accountId: approvedAuthor.id,
        visibility: "public",
        content: "Visible timeline post",
        contentHtml: "<p>Visible timeline post</p>",
        published: new Date(),
      },
      {
        id: mutedPostId,
        iri: `https://hollo.test/@timeline-pending/${mutedPostId}`,
        type: "Note",
        accountId: pendingAuthor.id,
        visibility: "public",
        content: "Muted timeline post",
        contentHtml: "<p>Muted timeline post</p>",
        published: new Date(),
      },
    ]);

    await db.insert(timelinePosts).values([
      { accountId: owner.id, postId: visiblePostId },
      { accountId: owner.id, postId: mutedPostId },
    ]);

    const response = await app.request("/api/v1/timelines/home?limit=1", {
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);

    const json = await response.json();

    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe(visiblePostId);
  });
});

describe.sequential("/api/v1/timelines/home", () => {
  let owner: Awaited<ReturnType<typeof createAccount>>;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();

    owner = await createAccount();
    client = await createOAuthApplication({
      scopes: ["read:statuses"],
    });
    accessToken = await getAccessToken(client, owner, ["read:statuses"]);
  });

  it("serializes quotes using the Mastodon Quote entity format", async () => {
    expect.assertions(9);

    const authorId = crypto.randomUUID() as Uuid;
    const quotedPostId = uuidv7();
    const quotePostId = uuidv7();

    await db
      .insert(instances)
      .values({ host: "remote.test" })
      .onConflictDoNothing();

    await db.insert(accounts).values({
      id: authorId,
      iri: "https://remote.test/users/author",
      instanceHost: "remote.test",
      type: "Person",
      name: "Remote author",
      emojis: {},
      handle: "@author@remote.test",
      bioHtml: "",
      url: "https://remote.test/@author",
      protected: false,
      inboxUrl: "https://remote.test/users/author/inbox",
    });

    await db.insert(follows).values({
      iri: "https://hollo.test/follows/author",
      followingId: authorId,
      followerId: owner.id,
      approved: new Date(),
    });

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: `https://remote.test/notes/${quotedPostId}`,
        type: "Note",
        accountId: authorId,
        visibility: "public",
        content: "Quoted post",
        contentHtml: "<p>Quoted post</p>",
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: `https://remote.test/notes/${quotePostId}`,
        type: "Note",
        accountId: authorId,
        quoteTargetId: quotedPostId,
        visibility: "public",
        content: "Quote post",
        contentHtml:
          "<p>Quote post</p>" +
          `<p class="quote-inline">RE: <a href="https://remote.test/notes/${quotedPostId}">` +
          `https://remote.test/notes/${quotedPostId}</a></p>`,
        published: new Date(),
      },
    ]);

    await db
      .insert(timelinePosts)
      .values({ accountId: owner.id, postId: quotePostId });

    const response = await app.request("/api/v1/timelines/home", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const json = await response.json();

    expect(Array.isArray(json)).toBe(true);
    expect(json[0].id).toBe(quotePostId);
    expect(json[0].content).toBe("<p>Quote post</p>");
    expect(json[0].content).not.toContain("quote-inline");
    expect(json[0].quote_id).toBe(quotedPostId);
    expect(json[0].quote.state).toBe("accepted");
    expect(json[0].quote.quoted_status.id).toBe(quotedPostId);
  });

  it("serializes boosted quoted posts in timeline responses", async () => {
    expect.assertions(9);

    const authorId = crypto.randomUUID() as Uuid;
    const quotedPostId = uuidv7();
    const quotePostId = uuidv7();
    const boostPostId = uuidv7();

    await db
      .insert(instances)
      .values({ host: "remote.test" })
      .onConflictDoNothing();

    await db.insert(accounts).values({
      id: authorId,
      iri: "https://remote.test/users/author",
      instanceHost: "remote.test",
      type: "Person",
      name: "Remote author",
      emojis: {},
      handle: "@author@remote.test",
      bioHtml: "",
      url: "https://remote.test/@author",
      protected: false,
      inboxUrl: "https://remote.test/users/author/inbox",
    });

    await db.insert(follows).values({
      iri: "https://hollo.test/follows/author",
      followingId: authorId,
      followerId: owner.id,
      approved: new Date(),
    });

    await db.insert(posts).values([
      {
        id: quotedPostId,
        iri: `https://remote.test/notes/${quotedPostId}`,
        type: "Note",
        accountId: authorId,
        visibility: "public",
        content: "Quoted post",
        contentHtml: "<p>Quoted post</p>",
        published: new Date(),
      },
      {
        id: quotePostId,
        iri: `https://remote.test/notes/${quotePostId}`,
        type: "Note",
        accountId: authorId,
        quoteTargetId: quotedPostId,
        visibility: "public",
        content: "Quote post",
        contentHtml:
          "<p>Quote post</p>" +
          `<p class="quote-inline">RE: <a href="https://remote.test/notes/${quotedPostId}">` +
          `https://remote.test/notes/${quotedPostId}</a></p>`,
        published: new Date(),
      },
      {
        id: boostPostId,
        iri: `https://hollo.test/@timeline-owner/${boostPostId}`,
        type: "Note",
        accountId: owner.id,
        sharingId: quotePostId,
        visibility: "public",
        content: null,
        contentHtml: null,
        published: new Date(),
      },
    ]);

    await db
      .insert(timelinePosts)
      .values({ accountId: owner.id, postId: boostPostId });

    const response = await app.request("/api/v1/timelines/home", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);

    const json = await response.json();

    expect(Array.isArray(json)).toBe(true);
    expect(json[0].id).toBe(boostPostId);
    expect(json[0].quote_id).toBeNull();
    expect(json[0].quote).toBeNull();
    expect(json[0].reblog.id).toBe(quotePostId);
    expect(json[0].reblog.content).toBe("<p>Quote post</p>");
    expect(json[0].reblog.quote_id).toBe(quotedPostId);
    expect(json[0].reblog.quote.quoted_status.id).toBe(quotedPostId);
  });

  it("keeps quote-inline fallback content without a structured quote", async () => {
    expect.assertions(6);

    const authorId = crypto.randomUUID() as Uuid;
    const postId = uuidv7();
    const quotedPostUrl = "https://remote.test/notes/missing";
    const contentHtml =
      "<p>Quote post</p>" +
      `<p class="quote-inline">RE: <a href="${quotedPostUrl}">` +
      `${quotedPostUrl}</a></p>`;

    await db
      .insert(instances)
      .values({ host: "remote.test" })
      .onConflictDoNothing();

    await db.insert(accounts).values({
      id: authorId,
      iri: "https://remote.test/users/author",
      instanceHost: "remote.test",
      type: "Person",
      name: "Remote author",
      emojis: {},
      handle: "@author@remote.test",
      bioHtml: "",
      url: "https://remote.test/@author",
      protected: false,
      inboxUrl: "https://remote.test/users/author/inbox",
    });

    await db.insert(follows).values({
      iri: "https://hollo.test/follows/author",
      followingId: authorId,
      followerId: owner.id,
      approved: new Date(),
    });

    await db.insert(posts).values({
      id: postId,
      iri: `https://remote.test/notes/${postId}`,
      type: "Note",
      accountId: authorId,
      visibility: "public",
      content: "Quote post",
      contentHtml,
      published: new Date(),
    });

    await db.insert(timelinePosts).values({ accountId: owner.id, postId });

    const response = await app.request("/api/v1/timelines/home", {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });

    expect(response.status).toBe(200);

    const json = await response.json();

    expect(Array.isArray(json)).toBe(true);
    expect(json[0].id).toBe(postId);
    expect(json[0].quote).toBeNull();
    expect(json[0].content).toContain("quote-inline");
    expect(json[0].content).toContain(quotedPostUrl);
  });
});

describe.sequential("/api/v1/timelines/public (pagination)", () => {
  let owner: Awaited<ReturnType<typeof createAccount>>;
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;
  // postIds[0] is the oldest; postIds[24] is the newest.
  let postIds: Uuid[];

  beforeEach(async () => {
    await cleanDatabase();

    owner = await createAccount();
    client = await createOAuthApplication({ scopes: ["read:statuses"] });
    accessToken = await getAccessToken(client, owner, ["read:statuses"]);

    postIds = [];
    for (let i = 0; i < 25; i++) {
      const id = uuidv7();
      postIds.push(id);
      await db.insert(posts).values({
        id,
        iri: `https://hollo.test/@hollo/${id}`,
        type: "Note",
        accountId: owner.id,
        visibility: "public",
        content: `Post ${i}`,
        contentHtml: `<p>Post ${i}</p>`,
        published: new Date(),
      });
    }
  });

  async function fetchTimeline(qs: string): Promise<Response> {
    return await app.request(`/api/v1/timelines/public${qs}`, {
      method: "GET",
      headers: {
        authorization: bearerAuthorization(accessToken),
      },
    });
  }

  it("returns the newest posts with bidirectional Link headers", async () => {
    expect.assertions(6);

    const response = await fetchTimeline("?limit=10");
    expect(response.status).toBe(200);

    const json = (await response.json()) as { id: string }[];
    expect(json).toHaveLength(10);
    expect(json[0].id).toBe(postIds[24]);
    expect(json[9].id).toBe(postIds[15]);

    const link = response.headers.get("Link") ?? "";
    expect(link).toContain(`max_id=${postIds[15]}>; rel="next"`);
    expect(link).toContain(`min_id=${postIds[24]}>; rel="prev"`);
  });

  it("walks up a large gap with min_id (Mastodon gap-loading)", async () => {
    expect.assertions(4);

    // Cursor sits 19 posts below the top. With limit=5, gap-loading must
    // return the 5 posts *immediately* above the cursor — postIds[6..10] —
    // ordered newest-first.  Naïve `since_id`-style logic would instead
    // return postIds[24..20] and the gap would never close.
    const response = await fetchTimeline(`?limit=5&min_id=${postIds[5]}`);
    expect(response.status).toBe(200);

    const json = (await response.json()) as { id: string }[];
    expect(json.map((p) => p.id)).toEqual([
      postIds[10],
      postIds[9],
      postIds[8],
      postIds[7],
      postIds[6],
    ]);

    // The rel="prev" cursor must point at the newest returned post so a
    // follow-up request continues walking up the gap.
    const link = response.headers.get("Link") ?? "";
    expect(link).toContain(`min_id=${postIds[10]}>; rel="prev"`);
    expect(link).toContain(`max_id=${postIds[6]}>; rel="next"`);
  });

  it('keeps rel="next" on non-empty partial gap pages', async () => {
    expect.assertions(5);

    const response = await fetchTimeline(
      `?limit=10&max_id=${postIds[12]}&min_id=${postIds[5]}`,
    );
    expect(response.status).toBe(200);

    const json = (await response.json()) as { id: string }[];
    expect(json.map((p) => p.id)).toEqual([
      postIds[11],
      postIds[10],
      postIds[9],
      postIds[8],
      postIds[7],
      postIds[6],
    ]);

    const link = response.headers.get("Link") ?? "";
    expect(link).toContain(`max_id=${postIds[6]}>; rel="next"`);
    expect(link).toContain(`min_id=${postIds[11]}>; rel="prev"`);
    expect(link).not.toContain("since_id=");
  });

  it("returns the newest posts above the cursor when only since_id is set", async () => {
    expect.assertions(2);

    const response = await fetchTimeline(`?limit=5&since_id=${postIds[5]}`);
    expect(response.status).toBe(200);

    const json = (await response.json()) as { id: string }[];
    expect(json.map((p) => p.id)).toEqual([
      postIds[24],
      postIds[23],
      postIds[22],
      postIds[21],
      postIds[20],
    ]);
  });

  it("lets min_id win over since_id when both are supplied", async () => {
    expect.assertions(1);

    const response = await fetchTimeline(
      `?limit=5&min_id=${postIds[5]}&since_id=${postIds[20]}`,
    );
    const json = (await response.json()) as { id: string }[];
    expect(json.map((p) => p.id)).toEqual([
      postIds[10],
      postIds[9],
      postIds[8],
      postIds[7],
      postIds[6],
    ]);
  });

  it("drops conflicting cursors when generating Link headers", async () => {
    expect.assertions(2);

    // Passing every cursor at once should not propagate into the next/prev
    // links — each link must contain exactly one of max_id/min_id and no
    // stale since_id.
    const response = await fetchTimeline(
      `?limit=5&max_id=${postIds[24]}&min_id=${postIds[0]}&since_id=${postIds[10]}`,
    );
    const link = response.headers.get("Link") ?? "";
    expect(link).not.toContain("since_id=");
    // rel="next" carries max_id only; rel="prev" carries min_id only.
    const matches = link.match(/(max_id|min_id|since_id)=/g) ?? [];
    expect(matches).toHaveLength(2);
  });
});

describe.each([true, false])("shared post filters (inboxes=%s)", (inboxes) => {
  describe.each(["home", "public", "list"] as const)(
    "/api/v1/timelines/%s (shared post filters)",
    (timeline) => {
      beforeEach(async () => {
        timelineInboxMode.override = inboxes;
        await cleanDatabase();
      });

      afterEach(() => {
        timelineInboxMode.override = undefined;
      });

      it("preserves ordinary posts and only shares of unfiltered authors", async () => {
        const owner = await createAccount({ username: "share-owner" });
        const client = await createOAuthApplication({ scopes: ["read"] });
        const accessToken = await getAccessToken(client, owner, ["read"]);
        const listId = uuidv7();
        await db.insert(lists).values({
          id: listId,
          accountOwnerId: owner.id,
          title: "Shared posts",
          repliesPolicy: "list",
          exclusive: false,
        });
        await db.insert(listMembers).values({ listId, accountId: owner.id });

        const lowerBound = uuidv7();
        const visibleIds: Uuid[] = [];
        const candidateIds: Uuid[] = [];
        const ordinaryPostId = uuidv7();
        await db.insert(posts).values({
          id: ordinaryPostId,
          iri: `https://hollo.test/posts/${ordinaryPostId}`,
          type: "Note",
          accountId: owner.id,
          visibility: "public",
          published: new Date(),
        });
        visibleIds.push(ordinaryPostId);
        candidateIds.push(ordinaryPostId);

        for (const filter of [
          "none",
          "indefinite-mute",
          "active-mute",
          "expired-mute",
          "blocked",
          "blocked-by",
        ] as const) {
          const author = await createAccount({ username: `share-${filter}` });
          if (filter.endsWith("mute")) {
            await db.insert(mutes).values({
              id: uuidv7(),
              accountId: owner.id,
              mutedAccountId: author.id,
              duration: filter === "indefinite-mute" ? null : "1 hour",
              created: new Date(
                Date.now() - (filter === "expired-mute" ? 7200000 : 60000),
              ),
            });
          } else if (filter === "blocked" || filter === "blocked-by") {
            await db.insert(blocks).values({
              accountId: filter === "blocked" ? owner.id : author.id,
              blockedAccountId: filter === "blocked" ? author.id : owner.id,
            });
          }
          const originalId = uuidv7();
          const shareId = uuidv7();
          await db.insert(posts).values([
            {
              id: originalId,
              iri: `https://hollo.test/posts/${originalId}`,
              type: "Note",
              accountId: author.id,
              visibility: "unlisted",
              published: new Date(),
            },
            {
              id: shareId,
              iri: `https://hollo.test/posts/${shareId}`,
              type: "Note",
              accountId: owner.id,
              sharingId: originalId,
              visibility: "public",
              published: new Date(),
            },
          ]);
          candidateIds.push(shareId);
          if (filter === "none" || filter === "expired-mute") {
            visibleIds.push(shareId);
          }
        }
        const upperBound = uuidv7();
        await db
          .insert(timelinePosts)
          .values(
            candidateIds.map((postId) => ({ accountId: owner.id, postId })),
          );
        await db
          .insert(listPosts)
          .values(candidateIds.map((postId) => ({ listId, postId })));

        const path = timeline === "list" ? `list/${listId}` : timeline;
        for (const query of [
          "",
          `?min_id=${lowerBound}`,
          `?max_id=${upperBound}`,
        ]) {
          const response = await app.request(
            `/api/v1/timelines/${path}${query}`,
            {
              headers: { authorization: bearerAuthorization(accessToken) },
            },
          );
          expect(response.status).toBe(200);
          const json: { id: string }[] = await response.json();
          expect(json.map((post) => post.id)).toEqual(
            [...visibleIds].reverse(),
          );
        }
      });
    },
  );
});
