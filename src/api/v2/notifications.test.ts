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
});
