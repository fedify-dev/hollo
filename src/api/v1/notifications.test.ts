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

describe.sequential("/api/v1/notifications", () => {
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

  describe("Link header pagination", () => {
    it("returns both next and prev links when results equal limit", async () => {
      expect.assertions(5);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);

      // Create exactly 2 notifications (using limit=2 for testing)
      const now = new Date();
      await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        new Date(now.getTime() - 1000),
      );
      await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        now,
      );

      const response = await app.request("/api/v1/notifications?limit=2", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);

      const linkHeader = response.headers.get("Link");
      expect(linkHeader).not.toBeNull();
      expect(linkHeader).toContain('rel="next"');
      expect(linkHeader).toContain('rel="prev"');
      expect(linkHeader).toContain("min_id=");
    });

    it("returns only prev link when results are less than limit", async () => {
      expect.assertions(5);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);

      // Create only 1 notification (less than limit=2)
      await createNotification(account.id as Uuid, "follow", remoteAccount.id);

      const response = await app.request("/api/v1/notifications?limit=2", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);

      const linkHeader = response.headers.get("Link");
      expect(linkHeader).not.toBeNull();
      // Should have prev but not next (since results < limit)
      expect(linkHeader).not.toContain('rel="next"');
      expect(linkHeader).toContain('rel="prev"');
      expect(linkHeader).toContain("min_id=");
    });

    it("returns no Link header when there are no notifications", async () => {
      expect.assertions(2);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);

      const response = await app.request("/api/v1/notifications", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);

      const linkHeader = response.headers.get("Link");
      expect(linkHeader).toBeNull();
    });

    it("returns older notifications when max_id is provided", async () => {
      expect.assertions(4);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);

      // Create 3 notifications with different timestamps
      const baseTime = new Date("2025-01-01T12:00:00.000Z");
      const older = await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        new Date(baseTime.getTime() - 2000),
      );
      const middle = await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        new Date(baseTime.getTime() - 1000),
      );
      // Create newer notification (not used directly but needed for test setup)
      await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        baseTime,
      );

      // Use the middle notification's composite ID as max_id
      const middleId = `${middle.created.toISOString()}/${middle.type}/${middle.id}`;

      const response = await app.request(
        `/api/v1/notifications?max_id=${encodeURIComponent(middleId)}`,
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);

      const notifications = await response.json();
      // Should only return the older notification (not middle or newer)
      expect(notifications.length).toBe(1);
      expect(notifications[0].id).toContain(older.id);
      expect(notifications[0].id).not.toContain(middle.id);
    });

    it("returns newer notifications when min_id is provided", async () => {
      expect.assertions(4);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);

      // Create 3 notifications with different timestamps
      const baseTime = new Date("2025-01-01T12:00:00.000Z");
      // Create older notification (not used directly but needed for test setup)
      await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        new Date(baseTime.getTime() - 2000),
      );
      const middle = await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        new Date(baseTime.getTime() - 1000),
      );
      const newer = await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        baseTime,
      );

      // Use the middle notification's composite ID as min_id
      const middleId = `${middle.created.toISOString()}/${middle.type}/${middle.id}`;

      const response = await app.request(
        `/api/v1/notifications?min_id=${encodeURIComponent(middleId)}`,
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);

      const notifications = await response.json();
      // Should only return the newer notification (not middle or older)
      expect(notifications.length).toBe(1);
      expect(notifications[0].id).toContain(newer.id);
      expect(notifications[0].id).not.toContain(middle.id);
    });

    it("includes max_id in next link URL", async () => {
      expect.assertions(3);

      const accessToken = await getAccessToken(client, account, [
        "read:notifications",
      ]);

      // Create exactly 2 notifications
      const now = new Date();
      await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        new Date(now.getTime() - 1000),
      );
      await createNotification(
        account.id as Uuid,
        "follow",
        remoteAccount.id,
        now,
      );

      const response = await app.request("/api/v1/notifications?limit=2", {
        method: "GET",
        headers: {
          authorization: bearerAuthorization(accessToken),
        },
      });

      expect(response.status).toBe(200);

      const linkHeader = response.headers.get("Link");
      expect(linkHeader).not.toBeNull();

      // Parse the next link and verify it contains max_id
      const nextMatch = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
      expect(nextMatch?.[1]).toContain("max_id=");
    });

    it("does not return the account when no access token is used", async () => {
      expect.assertions(2);

      const response = await app.request("/api/v1/notifications", {
        method: "GET",
      });

      expect(response.status).toBe(401);

      const error = await response.json();
      expect(error).toMatchObject({
        error: "unauthorized",
      });
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
        "/api/v1/notifications?types[]=SurelyInvalidType",
        {
          method: "GET",
          headers: {
            authorization: bearerAuthorization(accessToken),
          },
        },
      );

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveLength(0);
    });
  });
});
