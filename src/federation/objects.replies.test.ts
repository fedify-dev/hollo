import type { RequestContext } from "@fedify/fedify";
import { Person } from "@fedify/vocab";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import app from "../index";
import {
  accounts,
  follows,
  instances,
  mentions,
  type PostType,
  type PostVisibility,
  posts,
} from "../schema";
import { type Uuid, uuidv7 } from "../uuid";
import { countRepliesCollection, dispatchRepliesCollection } from "./objects";

const ACTIVITY_JSON = "application/activity+json";

function activityRequest(path: string) {
  return app.request(
    new Request(new URL(path, "https://hollo.test"), {
      headers: { Accept: ACTIVITY_JSON },
    }),
  );
}

async function createPost(
  accountId: string,
  options: {
    id?: Uuid;
    iri?: string;
    type?: PostType;
    visibility?: PostVisibility;
    replyTargetId?: Uuid;
    content?: string;
    published?: Date;
    mentionedAccountIds?: Uuid[];
  } = {},
) {
  const id = options.id ?? uuidv7();
  const iri = options.iri ?? `https://hollo.test/@hollo/${id}`;
  const content = options.content ?? "post";
  await db.insert(posts).values({
    id,
    iri,
    type: options.type ?? "Note",
    accountId: accountId as Uuid,
    replyTargetId: options.replyTargetId,
    visibility: options.visibility ?? "public",
    contentHtml: `<p>${content}</p>`,
    content,
    url: iri,
    published: options.published ?? new Date(),
  });
  if (options.mentionedAccountIds?.length) {
    await db.insert(mentions).values(
      options.mentionedAccountIds.map((mentionedAccountId) => ({
        postId: id,
        accountId: mentionedAccountId,
      })),
    );
  }
  return id;
}

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

function requestContext(keyOwnerIri: string | null): RequestContext<unknown> {
  return {
    getSignedKeyOwner: async () =>
      keyOwnerIri == null ? null : new Person({ id: new URL(keyOwnerIri) }),
    getCollectionUri: (
      name: string | symbol,
      values: Record<string, string>,
    ) => {
      const suffix =
        String(name) === "emojiReactions" ? "reactions" : "replies";
      return new URL(
        `/@${values["username"]}/${values["id"]}/${suffix}`,
        "https://hollo.test",
      );
    },
    getFollowersUri: (identifier: string) =>
      new URL(`/@${identifier}/followers`, "https://hollo.test"),
  } as unknown as RequestContext<unknown>;
}

function itemIds(page: Awaited<ReturnType<typeof dispatchRepliesCollection>>) {
  return (
    page?.items.map((item) =>
      item instanceof URL ? item.href : item.id?.href,
    ) ?? []
  );
}

describe("replies collection", () => {
  let accountId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const account = await createAccount({ generateKeyPair: true });
    accountId = account.id;
  });

  it.each(["Note", "Question", "Article"] as const)(
    "advertises replies on local %s objects",
    async (type) => {
      const postId = await createPost(accountId, { type });

      const response = await activityRequest(`/@hollo/${postId}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.replies).toBe(`https://hollo.test/@hollo/${postId}/replies`);
    },
  );

  it("serves visible replies as a paginated ordered collection", async () => {
    const rootId = await createPost(accountId, { content: "root" });
    const publicReplyId = await createPost(accountId, {
      id: uuidv7(Date.UTC(2026, 0, 1)),
      replyTargetId: rootId,
      visibility: "public",
      content: "public reply",
    });
    const unlistedReplyId = await createPost(accountId, {
      id: uuidv7(Date.UTC(2026, 0, 2)),
      type: "Question",
      replyTargetId: rootId,
      visibility: "unlisted",
      content: "unlisted reply",
    });
    await createPost(accountId, {
      id: uuidv7(Date.UTC(2026, 0, 3)),
      replyTargetId: rootId,
      visibility: "private",
      content: "private reply",
    });
    await createPost(accountId, {
      id: uuidv7(Date.UTC(2026, 0, 4)),
      replyTargetId: rootId,
      visibility: "direct",
      content: "direct reply",
    });

    const collection = await activityRequest(`/@hollo/${rootId}/replies`);
    expect(collection.status).toBe(200);
    expect(collection.headers.get("Cache-Control")).toBe("private, no-store");
    const collectionBody = await collection.json();
    expect(collectionBody).toMatchObject({
      type: "OrderedCollection",
      totalItems: 2,
      first: `https://hollo.test/@hollo/${rootId}/replies?cursor=0`,
    });

    const page = await activityRequest(`/@hollo/${rootId}/replies?cursor=0`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("private, no-store");
    const pageBody = await page.json();
    expect(pageBody.type).toBe("OrderedCollectionPage");
    expect(pageBody.partOf).toBe(`https://hollo.test/@hollo/${rootId}/replies`);
    expect(pageBody.orderedItems).toEqual([
      `https://hollo.test/@hollo/${unlistedReplyId}`,
      `https://hollo.test/@hollo/${publicReplyId}`,
    ]);
  });

  it("preserves canonical IRIs for remote replies", async () => {
    const rootId = await createPost(accountId, { content: "root" });
    const remote = await createRemoteAccount("reply-author");
    const remoteReplyIri = "https://remote.test/posts/reply";
    await createPost(remote.id, {
      iri: remoteReplyIri,
      replyTargetId: rootId,
      content: "remote reply",
    });

    const page = await activityRequest(`/@hollo/${rootId}/replies?cursor=0`);
    expect(page.status).toBe(200);
    const pageBody = await page.json();
    expect(pageBody.orderedItems).toEqual([remoteReplyIri]);
  });

  it("paginates replies forty at a time", async () => {
    const rootId = await createPost(accountId, { content: "root" });
    const replyIds = Array.from({ length: 41 }, (_, index) =>
      uuidv7(Date.UTC(2026, 1, 1, 0, 0, index)),
    );
    await db.insert(posts).values(
      replyIds.map((id, index) => ({
        id,
        iri: `https://hollo.test/@hollo/${id}`,
        type: "Note" as const,
        accountId: accountId as Uuid,
        replyTargetId: rootId,
        visibility: "public" as const,
        contentHtml: `<p>reply ${index}</p>`,
        content: `reply ${index}`,
        url: `https://hollo.test/@hollo/${id}`,
        published: new Date(Date.UTC(2026, 1, 1, 0, 0, index)),
      })),
    );

    const first = await activityRequest(`/@hollo/${rootId}/replies?cursor=0`);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.orderedItems).toHaveLength(40);
    expect(firstBody.orderedItems[0]).toBe(
      `https://hollo.test/@hollo/${replyIds[40]}`,
    );
    expect(firstBody.next).toBe(
      `https://hollo.test/@hollo/${rootId}/replies?cursor=40`,
    );

    const second = await activityRequest(`/@hollo/${rootId}/replies?cursor=40`);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.orderedItems).toHaveLength(1);
    expect(secondBody.orderedItems[0]).toBe(
      `https://hollo.test/@hollo/${replyIds[0]}`,
    );
  });

  it("applies requester visibility to both pages and counters", async () => {
    const rootId = await createPost(accountId, { content: "root" });
    const follower = await createRemoteAccount("follower");
    const mentioned = await createRemoteAccount("mentioned");
    const unrelated = await createRemoteAccount("unrelated");
    await db.insert(follows).values({
      iri: `https://remote.test/follows/${crypto.randomUUID()}`,
      followingId: accountId as Uuid,
      followerId: follower.id,
      approved: new Date(),
    });
    const publicReplyId = await createPost(accountId, {
      id: uuidv7(Date.UTC(2026, 2, 1)),
      replyTargetId: rootId,
      visibility: "public",
    });
    const unlistedReplyId = await createPost(accountId, {
      id: uuidv7(Date.UTC(2026, 2, 2)),
      replyTargetId: rootId,
      visibility: "unlisted",
    });
    const privateReplyId = await createPost(accountId, {
      id: uuidv7(Date.UTC(2026, 2, 3)),
      replyTargetId: rootId,
      visibility: "private",
    });
    const directReplyId = await createPost(accountId, {
      id: uuidv7(Date.UTC(2026, 2, 4)),
      replyTargetId: rootId,
      visibility: "direct",
      mentionedAccountIds: [mentioned.id],
    });
    const values = { username: "hollo", id: rootId };

    const anonymousContext = requestContext(null);
    expect(
      new Set(
        itemIds(await dispatchRepliesCollection(anonymousContext, values, "0")),
      ),
    ).toEqual(
      new Set([
        `https://hollo.test/@hollo/${publicReplyId}`,
        `https://hollo.test/@hollo/${unlistedReplyId}`,
      ]),
    );
    await expect(
      countRepliesCollection(anonymousContext, values),
    ).resolves.toBe(2);

    const followerContext = requestContext(follower.iri);
    expect(
      new Set(
        itemIds(await dispatchRepliesCollection(followerContext, values, "0")),
      ),
    ).toEqual(
      new Set([
        `https://hollo.test/@hollo/${publicReplyId}`,
        `https://hollo.test/@hollo/${unlistedReplyId}`,
        `https://hollo.test/@hollo/${privateReplyId}`,
      ]),
    );
    await expect(countRepliesCollection(followerContext, values)).resolves.toBe(
      3,
    );

    const mentionedContext = requestContext(mentioned.iri);
    expect(
      new Set(
        itemIds(await dispatchRepliesCollection(mentionedContext, values, "0")),
      ),
    ).toEqual(
      new Set([
        `https://hollo.test/@hollo/${publicReplyId}`,
        `https://hollo.test/@hollo/${unlistedReplyId}`,
        `https://hollo.test/@hollo/${directReplyId}`,
      ]),
    );
    await expect(
      countRepliesCollection(mentionedContext, values),
    ).resolves.toBe(3);

    const unrelatedContext = requestContext(unrelated.iri);
    expect(
      new Set(
        itemIds(await dispatchRepliesCollection(unrelatedContext, values, "0")),
      ),
    ).toEqual(
      new Set([
        `https://hollo.test/@hollo/${publicReplyId}`,
        `https://hollo.test/@hollo/${unlistedReplyId}`,
      ]),
    );
    await expect(
      countRepliesCollection(unrelatedContext, values),
    ).resolves.toBe(2);
  });

  it("requires authorization for replies to a private root", async () => {
    const follower = await createRemoteAccount("private-root-follower");
    const mentioned = await createRemoteAccount("private-root-mentioned");
    const rootId = await createPost(accountId, {
      visibility: "private",
      content: "private root",
      mentionedAccountIds: [mentioned.id],
    });
    const replyId = await createPost(accountId, {
      replyTargetId: rootId,
      visibility: "public",
    });
    await db.insert(follows).values({
      iri: `https://remote.test/follows/${crypto.randomUUID()}`,
      followingId: accountId as Uuid,
      followerId: follower.id,
      approved: new Date(),
    });
    const values = { username: "hollo", id: rootId };

    await expect(
      dispatchRepliesCollection(requestContext(null), values, "0"),
    ).resolves.toBeNull();
    expect(
      itemIds(
        await dispatchRepliesCollection(
          requestContext(follower.iri),
          values,
          "0",
        ),
      ),
    ).toEqual([`https://hollo.test/@hollo/${replyId}`]);
    expect(
      itemIds(
        await dispatchRepliesCollection(
          requestContext(mentioned.iri),
          values,
          "0",
        ),
      ),
    ).toEqual([`https://hollo.test/@hollo/${replyId}`]);

    const response = await activityRequest(`/@hollo/${rootId}/replies`);
    expect(response.status).toBe(401);
  });

  it("returns not found for invalid cursors and missing roots", async () => {
    const rootId = await createPost(accountId, { content: "root" });

    const invalid = await activityRequest(
      `/@hollo/${rootId}/replies?cursor=40invalid`,
    );
    expect(invalid.status).toBe(404);

    const missing = await activityRequest(
      `/@hollo/${crypto.randomUUID()}/replies`,
    );
    expect(missing.status).toBe(404);
  });
});
