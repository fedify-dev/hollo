import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../../tests/helpers/oauth";
import { createExpiredPollPost } from "../../../tests/helpers/poll";
import db from "../../db";
import app from "../../index";
import { materializeExpiredPollNotifications } from "../../notification";
import * as Schema from "../../schema";
import type { Uuid } from "../../uuid";

// Helper to create a remote account for use as notification actor
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

// Helper to create a notification
async function createNotification(
  accountOwnerId: Uuid,
  type: Schema.NotificationType,
  actorAccountId: Uuid,
  createdAt?: Date,
): Promise<Schema.Notification> {
  const id = crypto.randomUUID() as Uuid;
  const created = createdAt ?? new Date();

  const [notification] = await db
    .insert(Schema.notifications)
    .values({
      id,
      accountOwnerId,
      type,
      actorAccountId,
      groupKey: `ungrouped-${id}`,
      created,
    })
    .returning();

  return notification;
}

// Helper to create a grouped notification (notification + group)
async function createGroupedNotification(
  accountOwnerId: Uuid,
  type: Schema.NotificationType,
  actorAccountId: Uuid,
  createdAt?: Date,
): Promise<Schema.Notification> {
  const id = crypto.randomUUID() as Uuid;
  const created = createdAt ?? new Date();
  const groupKey = `${accountOwnerId}:${type}:grouped-${id}`;

  const [notification] = await db
    .insert(Schema.notifications)
    .values({
      id,
      accountOwnerId,
      type,
      actorAccountId,
      groupKey,
      created,
    })
    .returning();

  await db.insert(Schema.notificationGroups).values({
    groupKey,
    accountOwnerId,
    type,
    notificationsCount: 1,
    mostRecentNotificationId: id,
    sampleAccountIds: [actorAccountId],
    pageMinId: id,
    pageMaxId: id,
    created,
    updated: created,
  });

  return notification;
}

describe.sequential("/api/v2/notifications", () => {
  let client: Awaited<ReturnType<typeof createOAuthApplication>>;
  let account: Awaited<ReturnType<typeof createAccount>>;
  let remoteAccount: Schema.Account;

  beforeEach(async () => {
    await cleanDatabase();

    account = await createAccount();
    remoteAccount = await createRemoteAccount("remote_user");
    client = await createOAuthApplication({
      scopes: ["read:notifications"],
    });
  });

  describe("Notification types", () => {
    it("can handle unknown notification types", async () => {
      expect.assertions(2);
      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);

      await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        new Date(),
      );

      const response = await app.request(
        "/api/v2/notifications?types[]=SurelyInvalidType",
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.notification_groups).toHaveLength(0);
    });

    it("hides notification groups from blocked accounts", async () => {
      expect.assertions(3);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);
      await createGroupedNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
      );

      const responseBefore = await app.request("/api/v2/notifications", {
        method: "GET",
        headers: { authorization: bearerAuthorization(accessToken) },
      });
      expect((await responseBefore.json()).notification_groups).toHaveLength(1);

      await db.insert(Schema.blocks).values({
        accountId: account.id as Uuid,
        blockedAccountId: remoteAccount.id,
      });

      const responseAfter = await app.request("/api/v2/notifications", {
        method: "GET",
        headers: { authorization: bearerAuthorization(accessToken) },
      });
      expect(responseAfter.status).toBe(200);
      expect((await responseAfter.json()).notification_groups).toHaveLength(0);
    });

    it("keeps a group visible when a non-sampled actor is not hidden", async () => {
      expect.assertions(4);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);

      // Two actors like the same post: block actor A, leave actor B visible.
      const blockedActor = await createRemoteAccount("blocked_actor");
      const groupKey = `${account.id as Uuid}:favourite:${crypto.randomUUID()}`;
      const created = new Date();

      for (const [actorId, id] of [
        [remoteAccount.id, crypto.randomUUID() as Uuid],
        [blockedActor.id, crypto.randomUUID() as Uuid],
      ]) {
        await db.insert(Schema.notifications).values({
          id,
          accountOwnerId: account.id as Uuid,
          type: "favourite",
          actorAccountId: actorId,
          groupKey,
          created,
        });
      }

      // The cached sample only contains the blocked actor, which is what
      // `sampleAccountIds` would hold after the cap logic.  The group must
      // still resolve the visible actor B from its notifications.
      await db.insert(Schema.notificationGroups).values({
        groupKey,
        accountOwnerId: account.id as Uuid,
        type: "favourite",
        notificationsCount: 2,
        sampleAccountIds: [blockedActor.id],
        created,
        updated: created,
      });

      await db.insert(Schema.blocks).values({
        accountId: account.id as Uuid,
        blockedAccountId: blockedActor.id,
      });

      const response = await app.request("/api/v2/notifications", {
        method: "GET",
        headers: { authorization: bearerAuthorization(accessToken) },
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.notification_groups).toHaveLength(1);
      expect(body.notification_groups[0].sample_account_ids).toEqual([
        remoteAccount.id,
      ]);
      // The blocked actor must be excluded from the count too.
      expect(body.notification_groups[0].notifications_count).toBe(1);
    });

    it("keeps only the visible actors of a partially hidden cached sample", async () => {
      expect.assertions(3);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);

      const blockedActor = await createRemoteAccount("blocked_actor");
      // A follow group whose cached sample has both a visible and a blocked
      // actor; the blocked actor must be filtered without needing a lookup.
      const groupKey = `${account.id as Uuid}:follow:${crypto.randomUUID()}`;
      const created = new Date();
      await db.insert(Schema.notificationGroups).values({
        groupKey,
        accountOwnerId: account.id as Uuid,
        type: "follow",
        notificationsCount: 2,
        sampleAccountIds: [remoteAccount.id, blockedActor.id],
        created,
        updated: created,
      });
      await db.insert(Schema.blocks).values({
        accountId: account.id as Uuid,
        blockedAccountId: blockedActor.id,
      });

      const response = await app.request("/api/v2/notifications", {
        method: "GET",
        headers: { authorization: bearerAuthorization(accessToken) },
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.notification_groups).toHaveLength(1);
      expect(body.notification_groups[0].sample_account_ids).toEqual([
        remoteAccount.id,
      ]);
    });
  });

  describe("Poll notifications", () => {
    it("returns materialized poll notifications as groups", async () => {
      expect.assertions(9);
      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);
      const expires = new Date("2026-01-01T00:00:00.000Z");
      const { pollId, postId } = await createExpiredPollPost(
        account.id as Uuid,
        expires,
      );

      expect(
        await materializeExpiredPollNotifications({
          now: new Date("2026-01-01T00:00:01.000Z"),
        }),
      ).toBe(1);

      const notification = await db.query.notifications.findFirst({
        where: {
          RAW: (notifications, { and, eq }) =>
            and(
              eq(notifications.accountOwnerId, account.id as Uuid),
              eq(notifications.type, "poll"),
              eq(notifications.targetPollId, pollId),
            )!,
        },
      });
      expect(notification).not.toBeNull();

      const response = await app.request("/api/v2/notifications?types[]=poll", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.notification_groups).toHaveLength(1);
      expect(body.statuses).toHaveLength(1);
      expect(body.notification_groups[0]).toMatchObject({
        group_key: `${account.id}:poll:${pollId}`,
        type: "poll",
        status_id: postId,
      });
      expect(body.notification_groups[0].most_recent_notification_id).toBe(
        `${expires.toISOString()}/poll/${notification?.id}`,
      );
      expect(body.notification_groups[0].latest_page_notification_at).toBe(
        expires.toISOString(),
      );
      expect(body.statuses[0].id).toBe(postId);
    });

    it("drops a poll group whose post author is blocked", async () => {
      expect.assertions(3);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);
      const blockedActor = await createRemoteAccount("blocked_poll_author");

      // A poll post authored by a remote account that the owner has blocked.
      const postId = crypto.randomUUID() as Uuid;
      const postIri = `https://remote.test/@blocked_poll_author/${postId}`;
      await db.insert(Schema.posts).values({
        id: postId,
        iri: postIri,
        type: "Question",
        accountId: blockedActor.id,
        visibility: "public",
        contentHtml: "<p>Which option?</p>",
        content: "Which option?",
        published: new Date(),
      });

      // A poll notification group targeting that post (no actor).
      const notificationId = crypto.randomUUID() as Uuid;
      const groupKey = `${account.id as Uuid}:poll:${crypto.randomUUID()}`;
      const created = new Date();
      await db.insert(Schema.notifications).values({
        id: notificationId,
        accountOwnerId: account.id as Uuid,
        type: "poll",
        targetPostId: postId,
        groupKey,
        created,
      });
      await db.insert(Schema.notificationGroups).values({
        groupKey,
        accountOwnerId: account.id as Uuid,
        type: "poll",
        targetPostId: postId,
        notificationsCount: 1,
        mostRecentNotificationId: notificationId,
        sampleAccountIds: [],
        created,
        updated: created,
      });

      await db.insert(Schema.blocks).values({
        accountId: account.id as Uuid,
        blockedAccountId: blockedActor.id,
      });

      const response = await app.request("/api/v2/notifications?types[]=poll", {
        method: "GET",
        headers: { authorization: bearerAuthorization(accessToken) },
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.notification_groups).toHaveLength(0);
      // The blocked author's post must not leak into the statuses list either.
      expect(body.statuses).toHaveLength(0);
    });
  });

  describe("unread_count", () => {
    it("excludes unread notifications from blocked accounts", async () => {
      expect.assertions(3);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);
      await createGroupedNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
      );

      const before = await app.request("/api/v2/notifications/unread_count", {
        method: "GET",
        headers: { authorization: bearerAuthorization(accessToken) },
      });
      expect((await before.json()).count).toBe(1);

      await db.insert(Schema.blocks).values({
        accountId: account.id as Uuid,
        blockedAccountId: remoteAccount.id,
      });

      const after = await app.request("/api/v2/notifications/unread_count", {
        method: "GET",
        headers: { authorization: bearerAuthorization(accessToken) },
      });
      expect(after.status).toBe(200);
      expect((await after.json()).count).toBe(0);
    });

    it("still counts unread notifications from accounts muted without hiding notifications", async () => {
      expect.assertions(3);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);
      await createGroupedNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
      );

      // A mute that does not hide notifications must not reduce the count.
      await db.insert(Schema.mutes).values({
        id: crypto.randomUUID() as Uuid,
        accountId: account.id as Uuid,
        mutedAccountId: remoteAccount.id,
        notifications: false,
      });

      const response = await app.request("/api/v2/notifications/unread_count", {
        method: "GET",
        headers: { authorization: bearerAuthorization(accessToken) },
      });
      expect(response.status).toBe(200);
      expect((await response.json()).count).toBe(1);

      // A mute that hides notifications must reduce the count to zero.
      await db.update(Schema.mutes).set({ notifications: true });
      const response2 = await app.request(
        "/api/v2/notifications/unread_count",
        {
          method: "GET",
          headers: { authorization: bearerAuthorization(accessToken) },
        },
      );
      expect((await response2.json()).count).toBe(0);
    });
  });
});
