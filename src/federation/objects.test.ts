import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import { accounts, follows, instances } from "../schema";
import type { Uuid } from "../uuid";
import { hasApprovedFollowFromKeyOwner } from "./objects";

async function createRemoteAccount(username: string) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://remote.test/users/${username}`;

  await db
    .insert(instances)
    .values({ host: "remote.test" })
    .onConflictDoNothing();

  await db.insert(accounts).values({
    id,
    iri,
    instanceHost: "remote.test",
    type: "Person",
    name: `Remote ${username}`,
    emojis: {},
    handle: `@${username}@remote.test`,
    bioHtml: "",
    url: `https://remote.test/@${username}`,
    protected: false,
    inboxUrl: `${iri}/inbox`,
  });

  return { id, iri };
}

describe.sequential("object dispatchers", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("requires approved follows for private object fetches", async () => {
    expect.assertions(2);

    const owner = await createAccount({ username: "quote-author" });
    const pendingFollower = await createRemoteAccount("pending-follower");
    const approvedFollower = await createRemoteAccount("approved-follower");

    await db.insert(follows).values([
      {
        iri: `https://remote.test/follows/${crypto.randomUUID()}`,
        followingId: owner.id as Uuid,
        followerId: pendingFollower.id,
        approved: null,
      },
      {
        iri: `https://remote.test/follows/${crypto.randomUUID()}`,
        followingId: owner.id as Uuid,
        followerId: approvedFollower.id,
        approved: new Date(),
      },
    ]);

    await expect(
      hasApprovedFollowFromKeyOwner(
        new URL(pendingFollower.iri),
        owner.id as Uuid,
      ),
    ).resolves.toBe(false);
    await expect(
      hasApprovedFollowFromKeyOwner(
        new URL(approvedFollower.iri),
        owner.id as Uuid,
      ),
    ).resolves.toBe(true);
  });
});
