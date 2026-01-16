import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../tests/helpers";
import { createAccount } from "../tests/helpers/oauth";
import db from "./db";
import {
  createQuotedUpdateNotifications,
  createQuoteNotification,
} from "./notification";
import * as Schema from "./schema";
import type { Uuid } from "./uuid";

async function createRemoteAccount(username: string): Promise<Schema.Account> {
  const accountId = crypto.randomUUID() as Uuid;
  const accountIri = `https://remote.test/@${username}`;

  await db
    .insert(Schema.instances)
    .values({
      host: "remote.test",
      software: "mastodon",
      softwareVersion: null,
    })
    .onConflictDoNothing();

  const [account] = await db
    .insert(Schema.accounts)
    .values({
      id: accountId,
      iri: accountIri,
      instanceHost: "remote.test",
      type: "Person",
      name: `Remote: ${username}`,
      emojis: {},
      handle: `@${username}@remote.test`,
      bioHtml: "",
      url: accountIri,
      protected: false,
      inboxUrl: `${accountIri}/inbox`,
      followersUrl: `${accountIri}/followers`,
      sharedInboxUrl: "https://remote.test/inbox",
      featuredUrl: `${accountIri}/pinned`,
      published: new Date(),
    })
    .returning();

  return account;
}

async function createPost(
  accountId: Uuid,
  content: string,
  quoteTargetId?: Uuid,
): Promise<Schema.Post> {
  const postId = crypto.randomUUID() as Uuid;
  const postIri = `https://test.example/@test/${postId}`;

  const [post] = await db
    .insert(Schema.posts)
    .values({
      id: postId,
      iri: postIri,
      type: "Note",
      accountId,
      visibility: "public",
      content,
      quoteTargetId,
      published: new Date(),
    })
    .returning();

  return post;
}

describe("Quote notifications", () => {
  let localAccount: Awaited<ReturnType<typeof createAccount>>;
  let remoteAccount: Schema.Account;

  beforeEach(async () => {
    await cleanDatabase();
    localAccount = await createAccount();
    remoteAccount = await createRemoteAccount("remote_user");
  });

  describe("createQuoteNotification", () => {
    it("creates a quote notification when a post is quoted", async () => {
      expect.assertions(7);

      // Create original post by local user
      const originalPost = await createPost(
        localAccount.id as Uuid,
        "Original post",
      );

      // Get the original post with account and owner info
      const originalPostWithAccount = await db.query.posts.findFirst({
        where: eq(Schema.posts.id, originalPost.id),
        with: {
          account: { with: { owner: true } },
        },
      });

      expect(originalPostWithAccount).not.toBeNull();

      // Create quote post by remote user
      const quotePost = await createPost(
        remoteAccount.id,
        "Quoting this!",
        originalPost.id,
      );

      // Create quote notification
      const notificationId = await createQuoteNotification(
        remoteAccount,
        quotePost,
        originalPostWithAccount!,
      );

      expect(notificationId).not.toBeNull();

      // Verify notification was created
      const notification = await db.query.notifications.findFirst({
        where: eq(Schema.notifications.id, notificationId!),
      });

      expect(notification).not.toBeNull();
      expect(notification?.type).toBe("quote");
      expect(notification?.actorAccountId).toBe(remoteAccount.id);
      expect(notification?.targetPostId).toBe(quotePost.id);
      expect(notification?.accountOwnerId).toBe(localAccount.id);
    });

    it("returns null for self-quote", async () => {
      expect.assertions(1);

      // Create original post by local user
      const originalPost = await createPost(
        localAccount.id as Uuid,
        "Original post",
      );

      // Get the original post with account and owner info
      const originalPostWithAccount = await db.query.posts.findFirst({
        where: eq(Schema.posts.id, originalPost.id),
        with: {
          account: { with: { owner: true } },
        },
      });

      // Get local account as a regular account for quoter
      const quoterAccount = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, localAccount.id as Uuid),
      });

      // Create quote post by same user
      const quotePost = await createPost(
        localAccount.id as Uuid,
        "Quoting my own post",
        originalPost.id,
      );

      // Create quote notification - should return null for self-quote
      const notificationId = await createQuoteNotification(
        quoterAccount!,
        quotePost,
        originalPostWithAccount!,
      );

      expect(notificationId).toBeNull();
    });

    it("returns null when original post author is not a local user", async () => {
      expect.assertions(1);

      // Create original post by remote user
      const originalPost = await createPost(remoteAccount.id, "Remote post");

      // Get the original post with account info (no owner)
      const originalPostWithAccount = await db.query.posts.findFirst({
        where: eq(Schema.posts.id, originalPost.id),
        with: {
          account: { with: { owner: true } },
        },
      });

      // Create another remote account for quoter
      const anotherRemote = await createRemoteAccount("another_remote");

      // Create quote post
      const quotePost = await createPost(
        anotherRemote.id,
        "Quoting remote",
        originalPost.id,
      );

      // Create quote notification - should return null (original author not local)
      const notificationId = await createQuoteNotification(
        anotherRemote,
        quotePost,
        originalPostWithAccount!,
      );

      expect(notificationId).toBeNull();
    });
  });

  describe("createQuotedUpdateNotifications", () => {
    it("creates quoted_update notifications for all quote authors", async () => {
      expect.assertions(6);

      // Create original post by remote user
      const originalPost = await createPost(remoteAccount.id, "Original post");

      // Local user creates a quote post
      const quotePost = await createPost(
        localAccount.id as Uuid,
        "My quote",
        originalPost.id,
      );

      // Get local account with owner info
      const quoteAuthor = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, localAccount.id as Uuid),
        with: { owner: true },
      });

      // Call createQuotedUpdateNotifications
      const notificationIds = await createQuotedUpdateNotifications(
        originalPost,
        [quoteAuthor!],
      );

      expect(notificationIds.length).toBe(1);
      expect(notificationIds[0]).not.toBeNull();

      // Verify notification was created
      const notification = await db.query.notifications.findFirst({
        where: eq(Schema.notifications.id, notificationIds[0]),
      });

      expect(notification).not.toBeNull();
      expect(notification?.type).toBe("quoted_update");
      expect(notification?.actorAccountId).toBe(remoteAccount.id);
      expect(notification?.targetPostId).toBe(quotePost.id);
    });

    it("returns empty array when no quote authors are local users", async () => {
      expect.assertions(1);

      // Create original post by remote user
      const originalPost = await createPost(remoteAccount.id, "Original post");

      // Create another remote account
      const anotherRemote = await createRemoteAccount("another_remote");

      // Get remote account without owner
      const quoteAuthor = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, anotherRemote.id),
        with: { owner: true },
      });

      // Call createQuotedUpdateNotifications
      const notificationIds = await createQuotedUpdateNotifications(
        originalPost,
        [quoteAuthor!],
      );

      expect(notificationIds.length).toBe(0);
    });

    it("skips quote authors with no quote posts", async () => {
      expect.assertions(1);

      // Create original post by remote user
      const originalPost = await createPost(remoteAccount.id, "Original post");

      // Get local account with owner info (but hasn't quoted the post)
      const quoteAuthor = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, localAccount.id as Uuid),
        with: { owner: true },
      });

      // Call createQuotedUpdateNotifications (no quote post exists)
      const notificationIds = await createQuotedUpdateNotifications(
        originalPost,
        [quoteAuthor!],
      );

      expect(notificationIds.length).toBe(0);
    });
  });

  describe("duplicate prevention", () => {
    it("does not create duplicate quote notifications", async () => {
      expect.assertions(3);

      // Create original post by local user
      const originalPost = await createPost(
        localAccount.id as Uuid,
        "Original post",
      );

      const originalPostWithAccount = await db.query.posts.findFirst({
        where: eq(Schema.posts.id, originalPost.id),
        with: {
          account: { with: { owner: true } },
        },
      });

      // Create quote post by remote user
      const quotePost = await createPost(
        remoteAccount.id,
        "Quoting this!",
        originalPost.id,
      );

      // Create quote notification twice
      const notificationId1 = await createQuoteNotification(
        remoteAccount,
        quotePost,
        originalPostWithAccount!,
      );
      const notificationId2 = await createQuoteNotification(
        remoteAccount,
        quotePost,
        originalPostWithAccount!,
      );

      // Should return the same notification ID
      expect(notificationId1).toBe(notificationId2);

      // Verify only one notification exists
      const notifications = await db.query.notifications.findMany({
        where: and(
          eq(Schema.notifications.type, "quote"),
          eq(Schema.notifications.targetPostId, quotePost.id),
        ),
      });

      expect(notifications.length).toBe(1);
      expect(notifications[0].id).toBe(notificationId1);
    });
  });
});
