import { and, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import db from "../db";
import {
  accounts,
  instances,
  media,
  mentions,
  type NewAccount,
  type NewPost,
  polls,
  posts,
} from "../schema";
import type { Uuid } from "../uuid";
import { buildSearchFilter } from "./builder";
import { parseSearchQuery } from "./parser";

// Helper to ensure instance exists
async function ensureInstance(host: string): Promise<void> {
  await db.insert(instances).values({ host }).onConflictDoNothing();
}

// Helper to create test accounts
async function createTestAccount(
  overrides: Partial<NewAccount> = {},
): Promise<Uuid> {
  const id = crypto.randomUUID() as Uuid;
  const handle = overrides.handle ?? `@testuser_${id.slice(0, 8)}@example.com`;

  // Extract domain from handle or use default
  const domain = handle.includes("@")
    ? handle.split("@").pop() || "example.com"
    : "example.com";

  await ensureInstance(domain);

  await db.insert(accounts).values({
    id,
    iri: `https://${domain}/users/${id}`,
    type: "Person",
    name: overrides.name ?? "Test User",
    handle,
    inboxUrl: `https://${domain}/users/${id}/inbox`,
    instanceHost: domain,
    ...overrides,
  });

  return id;
}

// Helper to create test posts
async function createTestPost(
  accountId: Uuid,
  overrides: Partial<NewPost> = {},
): Promise<Uuid> {
  const id = crypto.randomUUID() as Uuid;

  await db.insert(posts).values({
    id,
    iri: `https://example.com/posts/${id}`,
    type: "Note",
    accountId,
    visibility: "public",
    contentHtml: overrides.contentHtml ?? "<p>Test post content</p>",
    content: overrides.content ?? "Test post content",
    published: overrides.published ?? new Date(),
    ...overrides,
  });

  return id;
}

// Helper to create test media
async function createTestMedia(postId: Uuid): Promise<Uuid> {
  const id = crypto.randomUUID() as Uuid;

  await db.insert(media).values({
    id,
    postId,
    type: "image/png",
    url: `https://example.com/media/${id}.png`,
    width: 100,
    height: 100,
    thumbnailType: "image/png",
    thumbnailUrl: `https://example.com/media/${id}_thumb.png`,
    thumbnailWidth: 50,
    thumbnailHeight: 50,
  });

  return id;
}

// Helper to create test poll
async function createTestPoll(): Promise<Uuid> {
  const id = crypto.randomUUID() as Uuid;

  await db.insert(polls).values({
    id,
    multiple: false,
    votersCount: 0,
    expires: new Date(Date.now() + 86400000), // 24 hours from now
  });

  return id;
}

// Helper to create mention
async function createTestMention(postId: Uuid, accountId: Uuid): Promise<void> {
  await db.insert(mentions).values({
    postId,
    accountId,
  });
}

// Helper to run search and get post IDs
async function searchPosts(query: string): Promise<Uuid[]> {
  const ast = parseSearchQuery(query);
  if (!ast) return [];

  const filter = buildSearchFilter(ast);
  const results = await db.query.posts.findMany({
    where: and(filter, isNull(posts.sharingId)),
    orderBy: (posts, { desc }) => [desc(posts.published)],
  });

  return results.map((p) => p.id);
}

describe("buildSearchFilter", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  describe("text search", () => {
    it("finds posts containing the search term", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const matchingPostId = await createTestPost(accountId, {
        contentHtml: "<p>Hello world, this is a test</p>",
      });
      const nonMatchingPostId = await createTestPost(accountId, {
        contentHtml: "<p>Goodbye universe</p>",
      });

      const results = await searchPosts("hello");
      expect(results).toContain(matchingPostId);
      expect(results).not.toContain(nonMatchingPostId);
    });

    it("is case-insensitive", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const postId = await createTestPost(accountId, {
        contentHtml: "<p>HELLO WORLD</p>",
      });

      const results1 = await searchPosts("hello");
      const results2 = await searchPosts("HELLO");
      expect(results1).toContain(postId);
      expect(results2).toContain(postId);
    });

    it("finds posts with quoted phrase", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const matchingPostId = await createTestPost(accountId, {
        contentHtml: "<p>The exact phrase here</p>",
      });
      const nonMatchingPostId = await createTestPost(accountId, {
        contentHtml: "<p>The phrase is not exact</p>",
      });

      const results = await searchPosts('"exact phrase"');
      expect(results).toContain(matchingPostId);
      expect(results).not.toContain(nonMatchingPostId);
    });
  });

  describe("has:media operator", () => {
    it("finds posts with media attachments", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const postWithMediaId = await createTestPost(accountId);
      await createTestMedia(postWithMediaId);
      const postWithoutMediaId = await createTestPost(accountId);

      const results = await searchPosts("has:media");
      expect(results).toContain(postWithMediaId);
      expect(results).not.toContain(postWithoutMediaId);
    });
  });

  describe("has:poll operator", () => {
    it("finds posts with polls", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const pollId = await createTestPoll();
      const postWithPollId = await createTestPost(accountId, { pollId });
      const postWithoutPollId = await createTestPost(accountId);

      const results = await searchPosts("has:poll");
      expect(results).toContain(postWithPollId);
      expect(results).not.toContain(postWithoutPollId);
    });
  });

  describe("is:reply operator", () => {
    it("finds posts that are replies", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const originalPostId = await createTestPost(accountId);
      const replyPostId = await createTestPost(accountId, {
        replyTargetId: originalPostId,
      });

      const results = await searchPosts("is:reply");
      expect(results).toContain(replyPostId);
      expect(results).not.toContain(originalPostId);
    });
  });

  describe("is:sensitive operator", () => {
    it("finds posts marked as sensitive", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const sensitivePostId = await createTestPost(accountId, {
        sensitive: true,
      });
      const normalPostId = await createTestPost(accountId, {
        sensitive: false,
      });

      const results = await searchPosts("is:sensitive");
      expect(results).toContain(sensitivePostId);
      expect(results).not.toContain(normalPostId);
    });
  });

  describe("language: operator", () => {
    it("finds posts in specific language", async () => {
      expect.assertions(3);

      const accountId = await createTestAccount();
      const englishPostId = await createTestPost(accountId, { language: "en" });
      const koreanPostId = await createTestPost(accountId, { language: "ko" });
      const noLangPostId = await createTestPost(accountId, { language: null });

      const results = await searchPosts("language:ko");
      expect(results).toContain(koreanPostId);
      expect(results).not.toContain(englishPostId);
      expect(results).not.toContain(noLangPostId);
    });
  });

  describe("from: operator", () => {
    it("finds posts from specific user by username", async () => {
      expect.assertions(2);

      const aliceId = await createTestAccount({ handle: "@alice@example.com" });
      const bobId = await createTestAccount({ handle: "@bob@example.com" });
      const alicePostId = await createTestPost(aliceId);
      const bobPostId = await createTestPost(bobId);

      const results = await searchPosts("from:alice");
      expect(results).toContain(alicePostId);
      expect(results).not.toContain(bobPostId);
    });

    it("finds posts from specific user by full handle", async () => {
      expect.assertions(2);

      const aliceId = await createTestAccount({ handle: "@alice@example.com" });
      const aliceOtherId = await createTestAccount({
        handle: "@alice@other.com",
      });
      const alicePostId = await createTestPost(aliceId);
      const aliceOtherPostId = await createTestPost(aliceOtherId);

      const results = await searchPosts("from:alice@example.com");
      expect(results).toContain(alicePostId);
      expect(results).not.toContain(aliceOtherPostId);
    });
  });

  describe("mentions: operator", () => {
    it("finds posts mentioning a specific user", async () => {
      expect.assertions(2);

      const authorId = await createTestAccount({
        handle: "@author@example.com",
      });
      const mentionedId = await createTestAccount({
        handle: "@mentioned@example.com",
      });

      const postWithMentionId = await createTestPost(authorId);
      await createTestMention(postWithMentionId, mentionedId);
      const postWithoutMentionId = await createTestPost(authorId);

      const results = await searchPosts("mentions:mentioned");
      expect(results).toContain(postWithMentionId);
      expect(results).not.toContain(postWithoutMentionId);
    });
  });

  describe("before: operator", () => {
    it("finds posts published before the date (exclusive)", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const oldPostId = await createTestPost(accountId, {
        published: new Date("2024-01-01"),
      });
      const newPostId = await createTestPost(accountId, {
        published: new Date("2024-01-15"),
      });

      const results = await searchPosts("before:2024-01-15");
      expect(results).toContain(oldPostId);
      expect(results).not.toContain(newPostId);
    });
  });

  describe("after: operator", () => {
    it("finds posts published after the date (inclusive)", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const oldPostId = await createTestPost(accountId, {
        published: new Date("2024-01-01"),
      });
      const newPostId = await createTestPost(accountId, {
        published: new Date("2024-01-15"),
      });

      const results = await searchPosts("after:2024-01-15");
      expect(results).toContain(newPostId);
      expect(results).not.toContain(oldPostId);
    });
  });

  describe("negation", () => {
    it("excludes posts matching -has:media", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const postWithMediaId = await createTestPost(accountId);
      await createTestMedia(postWithMediaId);
      const postWithoutMediaId = await createTestPost(accountId);

      const results = await searchPosts("-has:media");
      expect(results).not.toContain(postWithMediaId);
      expect(results).toContain(postWithoutMediaId);
    });

    it("excludes posts matching negated text", async () => {
      expect.assertions(2);

      const accountId = await createTestAccount();
      const spamPostId = await createTestPost(accountId, {
        contentHtml: "<p>This is spam content</p>",
      });
      const normalPostId = await createTestPost(accountId, {
        contentHtml: "<p>This is normal content</p>",
      });

      const results = await searchPosts("-spam");
      expect(results).not.toContain(spamPostId);
      expect(results).toContain(normalPostId);
    });
  });

  describe("OR operator", () => {
    it("finds posts matching either condition", async () => {
      expect.assertions(3);

      const accountId = await createTestAccount();
      const postWithMediaId = await createTestPost(accountId);
      await createTestMedia(postWithMediaId);
      const pollId = await createTestPoll();
      const postWithPollId = await createTestPost(accountId, { pollId });
      const plainPostId = await createTestPost(accountId);

      const results = await searchPosts("has:media OR has:poll");
      expect(results).toContain(postWithMediaId);
      expect(results).toContain(postWithPollId);
      expect(results).not.toContain(plainPostId);
    });
  });

  describe("implicit AND", () => {
    it("finds posts matching all conditions", async () => {
      expect.assertions(3);

      const aliceId = await createTestAccount({ handle: "@alice@example.com" });
      const bobId = await createTestAccount({ handle: "@bob@example.com" });

      const aliceWithMediaId = await createTestPost(aliceId);
      await createTestMedia(aliceWithMediaId);
      const aliceWithoutMediaId = await createTestPost(aliceId);
      const bobWithMediaId = await createTestPost(bobId);
      await createTestMedia(bobWithMediaId);

      const results = await searchPosts("from:alice has:media");
      expect(results).toContain(aliceWithMediaId);
      expect(results).not.toContain(aliceWithoutMediaId);
      expect(results).not.toContain(bobWithMediaId);
    });
  });

  describe("complex queries", () => {
    it("handles (from:alice OR from:bob) has:poll", async () => {
      expect.assertions(4);

      const aliceId = await createTestAccount({ handle: "@alice@example.com" });
      const bobId = await createTestAccount({ handle: "@bob@example.com" });
      const charlieId = await createTestAccount({
        handle: "@charlie@example.com",
      });

      const pollId1 = await createTestPoll();
      const pollId2 = await createTestPoll();
      const pollId3 = await createTestPoll();

      const alicePollPostId = await createTestPost(aliceId, {
        pollId: pollId1,
      });
      const bobPollPostId = await createTestPost(bobId, { pollId: pollId2 });
      const charliePollPostId = await createTestPost(charlieId, {
        pollId: pollId3,
      });
      const aliceNoPollPostId = await createTestPost(aliceId);

      const results = await searchPosts("(from:alice OR from:bob) has:poll");
      expect(results).toContain(alicePollPostId);
      expect(results).toContain(bobPollPostId);
      expect(results).not.toContain(charliePollPostId);
      expect(results).not.toContain(aliceNoPollPostId);
    });

    it("handles date range with before and after", async () => {
      expect.assertions(3);

      const accountId = await createTestAccount();
      const earlyPostId = await createTestPost(accountId, {
        published: new Date("2024-01-01"),
      });
      const midPostId = await createTestPost(accountId, {
        published: new Date("2024-06-15"),
      });
      const latePostId = await createTestPost(accountId, {
        published: new Date("2024-12-31"),
      });

      const results = await searchPosts("after:2024-06-01 before:2024-07-01");
      expect(results).not.toContain(earlyPostId);
      expect(results).toContain(midPostId);
      expect(results).not.toContain(latePostId);
    });

    it("handles text with operators: hello from:alice -is:sensitive", async () => {
      expect.assertions(4);

      const aliceId = await createTestAccount({ handle: "@alice@example.com" });
      const bobId = await createTestAccount({ handle: "@bob@example.com" });

      const matchingPostId = await createTestPost(aliceId, {
        contentHtml: "<p>Hello everyone!</p>",
        sensitive: false,
      });
      const sensitivePostId = await createTestPost(aliceId, {
        contentHtml: "<p>Hello sensitive content</p>",
        sensitive: true,
      });
      const noHelloPostId = await createTestPost(aliceId, {
        contentHtml: "<p>Goodbye world</p>",
        sensitive: false,
      });
      const bobPostId = await createTestPost(bobId, {
        contentHtml: "<p>Hello from Bob</p>",
        sensitive: false,
      });

      const results = await searchPosts("hello from:alice -is:sensitive");
      expect(results).toContain(matchingPostId);
      expect(results).not.toContain(sensitivePostId);
      expect(results).not.toContain(noHelloPostId);
      expect(results).not.toContain(bobPostId);
    });
  });
});
