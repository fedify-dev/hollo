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
  });
});
