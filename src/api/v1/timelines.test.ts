import { beforeEach, describe, expect, it } from "vitest";

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
  follows,
  instances,
  listMembers,
  lists,
  media,
  mentions,
  posts,
} from "../../schema";
import type { Uuid } from "../../uuid";
import { uuidv7 } from "../../uuid";

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
