import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import * as Schema from "../schema";
import type { Uuid } from "../uuid";
import { onOutboxPermanentFailure } from "./index";

async function createRemoteAccount(
  username: string,
  host = "remote.test",
): Promise<Schema.Account> {
  const accountId = crypto.randomUUID() as Uuid;
  const accountIri = `https://${host}/@${username}`;

  await db
    .insert(Schema.instances)
    .values({
      host,
      software: "mastodon",
      softwareVersion: null,
    })
    .onConflictDoNothing();

  const [account] = await db
    .insert(Schema.accounts)
    .values({
      id: accountId,
      iri: accountIri,
      instanceHost: host,
      type: "Person",
      name: `Remote: ${username}`,
      emojis: {},
      handle: `@${username}@${host}`,
      bioHtml: "",
      url: accountIri,
      protected: false,
      inboxUrl: `${accountIri}/inbox`,
      followersUrl: `${accountIri}/followers`,
      sharedInboxUrl: `https://${host}/inbox`,
      featuredUrl: `${accountIri}/pinned`,
      published: new Date(),
    })
    .returning();

  return account;
}

async function createFollow(
  followingId: Uuid,
  followerId: Uuid,
): Promise<void> {
  await db.insert(Schema.follows).values({
    iri: `https://remote.test/follows/${crypto.randomUUID()}`,
    followingId,
    followerId,
    approved: new Date(),
  });
}

describe("onOutboxPermanentFailure", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  describe("404 Not Found", () => {
    it("should remove follower relationships for the failed actor", async () => {
      expect.assertions(3);
      const localAccount = await createAccount();
      const remoteAccount = await createRemoteAccount("alice");
      await createFollow(localAccount.id as Uuid, remoteAccount.id);

      await onOutboxPermanentFailure(
        404,
        [new URL(remoteAccount.iri)],
        new URL(remoteAccount.inboxUrl),
      );

      // Follow should be deleted
      const remainingFollows = await db
        .select()
        .from(Schema.follows)
        .where(eq(Schema.follows.followerId, remoteAccount.id));
      expect(remainingFollows).toHaveLength(0);

      // Account should still exist
      const remainingAccount = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, remoteAccount.id),
      });
      expect(remainingAccount).toBeDefined();

      // Local account follower count should be updated
      const updatedLocal = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, localAccount.id as Uuid),
      });
      expect(updatedLocal?.followersCount).toBe(0);
    });

    it("should remove multiple follower relationships", async () => {
      expect.assertions(4);
      const localAccount1 = await createAccount({ username: "user1" });
      const localAccount2 = await createAccount({ username: "user2" });
      const remoteAccount = await createRemoteAccount("alice");
      await createFollow(localAccount1.id as Uuid, remoteAccount.id);
      await createFollow(localAccount2.id as Uuid, remoteAccount.id);

      await onOutboxPermanentFailure(
        404,
        [new URL(remoteAccount.iri)],
        new URL(remoteAccount.inboxUrl),
      );

      // All follows from this remote account should be deleted
      const remainingFollows = await db
        .select()
        .from(Schema.follows)
        .where(eq(Schema.follows.followerId, remoteAccount.id));
      expect(remainingFollows).toHaveLength(0);

      // Account should still exist
      const remainingAccount = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, remoteAccount.id),
      });
      expect(remainingAccount).toBeDefined();

      // Both local accounts should have updated stats
      for (const localAccount of [localAccount1, localAccount2]) {
        const updated = await db.query.accounts.findFirst({
          where: eq(Schema.accounts.id, localAccount.id as Uuid),
        });
        expect(updated?.followersCount).toBe(0);
      }
    });

    it("should not remove outgoing follows (local following remote)", async () => {
      expect.assertions(1);
      const localAccount = await createAccount();
      const remoteAccount = await createRemoteAccount("alice");
      // Local follows remote (outgoing follow)
      await createFollow(remoteAccount.id, localAccount.id as Uuid);

      await onOutboxPermanentFailure(
        404,
        [new URL(remoteAccount.iri)],
        new URL(remoteAccount.inboxUrl),
      );

      // Outgoing follow should remain for 404
      const remainingFollows = await db
        .select()
        .from(Schema.follows)
        .where(eq(Schema.follows.followingId, remoteAccount.id));
      expect(remainingFollows).toHaveLength(1);
    });

    it("should skip unknown actor IDs gracefully", async () => {
      expect.assertions(1);
      // Should not throw when actor doesn't exist in DB
      await onOutboxPermanentFailure(
        404,
        [new URL("https://nonexistent.test/@ghost")],
        new URL("https://nonexistent.test/@ghost/inbox"),
      );

      // No error thrown — just verify the test completes
      expect(true).toBe(true);
    });
  });

  describe("410 Gone", () => {
    it("should delete the account and cascade-delete follows", async () => {
      expect.assertions(3);
      const localAccount = await createAccount();
      const remoteAccount = await createRemoteAccount("alice");
      await createFollow(localAccount.id as Uuid, remoteAccount.id);

      await onOutboxPermanentFailure(
        410,
        [new URL(remoteAccount.iri)],
        new URL(remoteAccount.inboxUrl),
      );

      // Account should be deleted
      const remainingAccount = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, remoteAccount.id),
      });
      expect(remainingAccount).toBeUndefined();

      // Follow should be cascade-deleted
      const remainingFollows = await db
        .select()
        .from(Schema.follows)
        .where(eq(Schema.follows.followerId, remoteAccount.id));
      expect(remainingFollows).toHaveLength(0);

      // Local account follower count should be updated
      const updatedLocal = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, localAccount.id as Uuid),
      });
      expect(updatedLocal?.followersCount).toBe(0);
    });

    it("should also clean up outgoing follows (local following remote)", async () => {
      expect.assertions(2);
      const localAccount = await createAccount();
      const remoteAccount = await createRemoteAccount("alice");
      // Local follows remote (outgoing follow)
      await createFollow(remoteAccount.id, localAccount.id as Uuid);

      await onOutboxPermanentFailure(
        410,
        [new URL(remoteAccount.iri)],
        new URL(remoteAccount.inboxUrl),
      );

      // Account should be deleted
      const remainingAccount = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, remoteAccount.id),
      });
      expect(remainingAccount).toBeUndefined();

      // Outgoing follow should be cascade-deleted too
      const remainingFollows = await db
        .select()
        .from(Schema.follows)
        .where(eq(Schema.follows.followingId, remoteAccount.id));
      expect(remainingFollows).toHaveLength(0);
    });

    it("should update stats for both followers and followees", async () => {
      expect.assertions(3);
      const localAccount = await createAccount();
      const remoteAccount = await createRemoteAccount("alice");
      // Remote follows local (incoming)
      await createFollow(localAccount.id as Uuid, remoteAccount.id);
      // Local follows remote (outgoing)
      await createFollow(remoteAccount.id, localAccount.id as Uuid);

      await onOutboxPermanentFailure(
        410,
        [new URL(remoteAccount.iri)],
        new URL(remoteAccount.inboxUrl),
      );

      const remainingAccount = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, remoteAccount.id),
      });
      expect(remainingAccount).toBeUndefined();

      // Local account stats should reflect removal of both relationships
      const updatedLocal = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, localAccount.id as Uuid),
      });
      expect(updatedLocal?.followersCount).toBe(0);
      expect(updatedLocal?.followingCount).toBe(0);
    });

    it("should handle multiple actor IDs", async () => {
      expect.assertions(2);
      const localAccount = await createAccount();
      const remoteAccount1 = await createRemoteAccount("alice");
      const remoteAccount2 = await createRemoteAccount("bob");
      await createFollow(localAccount.id as Uuid, remoteAccount1.id);
      await createFollow(localAccount.id as Uuid, remoteAccount2.id);

      await onOutboxPermanentFailure(
        410,
        [new URL(remoteAccount1.iri), new URL(remoteAccount2.iri)],
        new URL("https://remote.test/inbox"),
      );

      // Both accounts should be deleted
      const remaining1 = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, remoteAccount1.id),
      });
      const remaining2 = await db.query.accounts.findFirst({
        where: eq(Schema.accounts.id, remoteAccount2.id),
      });
      expect(remaining1).toBeUndefined();
      expect(remaining2).toBeUndefined();
    });

    it("should skip unknown actor IDs gracefully", async () => {
      expect.assertions(1);
      await onOutboxPermanentFailure(
        410,
        [new URL("https://nonexistent.test/@ghost")],
        new URL("https://nonexistent.test/@ghost/inbox"),
      );

      expect(true).toBe(true);
    });
  });
});
