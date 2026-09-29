import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import { accounts, follows, instances, posts } from "../schema";
import type { Uuid } from "../uuid";
import { uuidv7 } from "../uuid";
import {
  buildPostVisibilityConditions,
  getApprovedFollowingAccountIds,
} from "./visibility";

async function createRemoteAccount(username: string): Promise<Uuid> {
  const id = crypto.randomUUID() as Uuid;

  await db
    .insert(instances)
    .values({ host: "remote.test" })
    .onConflictDoNothing();

  await db.insert(accounts).values({
    id,
    iri: `https://remote.test/users/${username}`,
    instanceHost: "remote.test",
    type: "Person",
    name: `Remote ${username}`,
    emojis: {},
    handle: `@${username}@remote.test`,
    bioHtml: "",
    url: `https://remote.test/@${username}`,
    protected: false,
    inboxUrl: `https://remote.test/users/${username}/inbox`,
  });

  return id;
}

describe("visibility helpers", { concurrent: false }, () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns approved following account IDs only", async () => {
    expect.assertions(1);

    const viewer = await createAccount({ username: "viewer" });
    const approvedAuthorId = await createRemoteAccount("approved");
    const pendingAuthorId = await createRemoteAccount("pending");

    await db.insert(follows).values([
      {
        iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
        followingId: approvedAuthorId,
        followerId: viewer.id,
        approved: new Date(),
      },
      {
        iri: `https://hollo.test/follows/${crypto.randomUUID()}`,
        followingId: pendingAuthorId,
        followerId: viewer.id,
        approved: null,
      },
    ]);

    await expect(getApprovedFollowingAccountIds(viewer.id)).resolves.toEqual([
      approvedAuthorId,
    ]);
  });

  it("builds post visibility SQL without a follows subquery", () => {
    expect.assertions(5);

    const viewerId = uuidv7();
    const followedAccountId = uuidv7();
    const condition = buildPostVisibilityConditions({
      viewerAccountId: viewerId,
      followingAccountIds: [followedAccountId],
    });
    const query = db
      .select()
      .from(posts)
      .where(and(eq(posts.id, uuidv7()), condition))
      .toSQL();

    expect(query.sql).not.toContain('"follows"');
    expect(query.sql).toContain('"actor_id" = ANY');
    expect(query.params).not.toContain(followedAccountId);
    expect(query.params).toContain(viewerId);
    expect(
      query.params.some((param) =>
        Array.isArray((param as { value?: unknown }).value),
      ),
    ).toBe(true);
  });
});
