import type { RequestContext } from "@fedify/fedify";
import { Person } from "@fedify/vocab";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
  countRepliesCollection,
  dispatchRepliesCollection,
  repliesQueryCache,
} from "./objects";

const ACTIVITY_JSON = "application/activity+json";

function activityRequest(path: string, headers: Record<string, string> = {}) {
  return app.request(
    new Request(new URL(path, "https://hollo.test"), {
      headers: { Accept: ACTIVITY_JSON, ...headers },
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

function requestContext(
  keyOwnerIri: string | null,
  request = new Request("https://hollo.test/replies"),
): RequestContext<unknown> {
  return {
    request,
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
    repliesQueryCache.clear();
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds database work for bare and page requests", async () => {
    const rootId = await createPost(accountId);
    const queries = vi.spyOn(db.$client, "unsafe");
    const bare = await activityRequest(`/@hollo/${rootId}/replies`);
    expect(bare.status).toBe(200);
    expect(queries).toHaveBeenCalledTimes(3);
    queries.mockClear();
    const repeated = await activityRequest(`/@hollo/${rootId}/replies`);
    expect(repeated.status).toBe(200);
    expect(queries).toHaveBeenCalledTimes(2);
    queries.mockClear();
    const page = await activityRequest(`/@hollo/${rootId}/replies?cursor=0`);
    expect(page.status).toBe(200);
    expect(queries).toHaveBeenCalledTimes(3);
  });

  it("coalesces overlapping HTTP root reads and counts", async () => {
    const rootId = await createPost(accountId);
    const rootsReady = Promise.withResolvers<void>();
    const countsReady = Promise.withResolvers<void>();
    const loadRoot = repliesQueryCache.loadRoot.bind(repliesQueryCache);
    const loadCount = repliesQueryCache.loadCount.bind(repliesQueryCache);
    const roots = vi
      .spyOn(repliesQueryCache, "loadRoot")
      .mockImplementation((key, load) =>
        loadRoot(key, async () => {
          await rootsReady.promise;
          return load();
        }),
      );
    const counts = vi
      .spyOn(repliesQueryCache, "loadCount")
      .mockImplementation((key, load) =>
        loadCount(key, async () => {
          await countsReady.promise;
          return load();
        }),
      );
    const queries = vi.spyOn(db.$client, "unsafe");
    const requests = Array.from({ length: 10 }, () =>
      activityRequest(`/@hollo/${rootId}/replies`),
    );
    try {
      await vi.waitFor(() => expect(roots).toHaveBeenCalledTimes(10));
      rootsReady.resolve();
      await vi.waitFor(() => expect(counts).toHaveBeenCalledTimes(10));
      countsReady.resolve();
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.status)).toEqual(
        Array(10).fill(200),
      );
      expect(queries).toHaveBeenCalledTimes(3);
    } finally {
      rootsReady.resolve();
      countsReady.resolve();
      await Promise.allSettled(requests);
    }
  });

  it.each([
    ["abc", "hollo", 0, 404],
    ["missing-post", "hollo", 2, 404],
    ["missing-post", "missing-owner", 1, 404],
    ["private", "hollo", 2, 401],
    ["direct", "hollo", 2, 401],
  ] as const)(
    "bounds rejected requests for %s/%s",
    async (kind, username, sqlCount, status) => {
      const id =
        kind === "abc"
          ? "abc"
          : kind === "missing-post"
            ? uuidv7()
            : await createPost(accountId, { visibility: kind });
      const queries = vi.spyOn(db.$client, "unsafe");
      const rootLoads = vi.spyOn(repliesQueryCache, "loadRoot");
      for (const suffix of ["", "?cursor=0"]) {
        queries.mockClear();
        const response = await activityRequest(
          `/@${username}/${id}/replies${suffix}`,
        );
        expect(response.status).toBe(status);
        expect(queries).toHaveBeenCalledTimes(sqlCount);
      }
      expect(rootLoads).toHaveBeenCalledTimes(kind === "abc" ? 0 : 2);
    },
  );

  it("does not load replies for invalid cursors", async () => {
    const id = await createPost(accountId);
    const queries = vi.spyOn(db.$client, "unsafe");
    const response = await activityRequest(
      `/@hollo/${id}/replies?cursor=invalid`,
    );
    expect(response.status).toBe(404);
    expect(queries).toHaveBeenCalledTimes(2);
    queries.mockClear();
    await expect(
      dispatchRepliesCollection(
        requestContext(null),
        { username: "hollo", id },
        "invalid",
      ),
    ).resolves.toBeNull();
    expect(queries).not.toHaveBeenCalled();
  });

  it("keeps unlisted roots live and separates different public roots", async () => {
    const publicId = await createPost(accountId);
    const otherId = await createPost(accountId);
    const unlistedId = await createPost(accountId, { visibility: "unlisted" });
    const queries = vi.spyOn(db.$client, "unsafe");
    for (const [id, expected] of [
      [publicId, 3],
      [publicId, 2],
      [otherId, 3],
      [unlistedId, 3],
      [unlistedId, 3],
    ] as const) {
      queries.mockClear();
      const response = await activityRequest(`/@hollo/${id}/replies`);
      expect(response.status).toBe(200);
      expect(queries).toHaveBeenCalledTimes(expected);
    }
  });

  it.each(["Signature", "Signature-Input", "Authorization"])(
    "bypasses cached counts with a present %s header, including empty values",
    async (header) => {
      const id = await createPost(accountId);
      const values = { username: "hollo", id };
      const url = `https://hollo.test/@hollo/${id}/replies`;
      const ctx = () => requestContext(null, new Request(url));
      await expect(countRepliesCollection(ctx(), values)).resolves.toBe(0);
      await createPost(accountId, { replyTargetId: id });
      for (const value of ["", "test"]) {
        const signed = requestContext(
          null,
          new Request(url, { headers: { [header]: value } }),
        );
        await expect(countRepliesCollection(signed, values)).resolves.toBe(1);
      }
      // Header-bearing requests neither read nor replace the anonymous entry.
      await expect(countRepliesCollection(ctx(), values)).resolves.toBe(0);
    },
  );

  it("does not share an invalid signed HTTP request's count or reach the network", async () => {
    const id = await createPost(accountId);
    const path = `/@hollo/${id}/replies`;
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network"));
    const first = await activityRequest(path);
    expect((await first.json()).totalItems).toBe(0);
    await createPost(accountId, { replyTargetId: id });
    const signed = await activityRequest(path, {
      Signature:
        'keyId="https://remote.test/key",algorithm="rsa-sha256",headers="date",signature="dGVzdA=="',
    });
    expect(signed.status).toBe(200);
    expect((await signed.json()).totalItems).toBe(1);
    const anonymous = await activityRequest(path);
    expect((await anonymous.json()).totalItems).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });

  it("shares request-local viewer resolution but not identities or roots", async () => {
    const id = await createPost(accountId);
    const otherId = await createPost(accountId);
    const remote = await createRemoteAccount("recipient");
    await createPost(accountId, {
      replyTargetId: id,
      visibility: "direct",
      mentionedAccountIds: [remote.id],
    });
    const values = { username: "hollo", id };
    for (const [actor, expected] of [
      [null, 0],
      [remote.iri, 1],
      ["https://remote.test/unknown", 0],
    ] as const) {
      const ctx = requestContext(actor);
      const keyOwner = vi.spyOn(ctx, "getSignedKeyOwner");
      const [count, page] = await Promise.all([
        countRepliesCollection(ctx, values),
        dispatchRepliesCollection(ctx, values, "0"),
      ]);
      expect(count).toBe(expected);
      expect(page?.items).toHaveLength(expected);
      await expect(
        countRepliesCollection(ctx, { username: "hollo", id: otherId }),
      ).resolves.toBe(0);
      expect(keyOwner).toHaveBeenCalledTimes(1);
    }
  });

  it("reuses viewer resolution failures only within the failed request", async () => {
    const id = await createPost(accountId);
    const values = { username: "hollo", id };
    const ctx = requestContext(null);
    const failure = new Error("key lookup failed");
    const keyOwner = vi
      .spyOn(ctx, "getSignedKeyOwner")
      .mockRejectedValue(failure);
    const results = await Promise.allSettled([
      countRepliesCollection(ctx, values),
      dispatchRepliesCollection(ctx, values, "0"),
    ]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(keyOwner).toHaveBeenCalledTimes(1);
    await expect(
      countRepliesCollection(requestContext(null), values),
    ).resolves.toBe(0);
  });

  it.each(["private", "direct", "delete"] as const)(
    "rechecks a warm root after %s",
    async (change) => {
      const id = await createPost(accountId);
      const path = `/@hollo/${id}/replies`;
      expect((await activityRequest(path)).status).toBe(200);
      if (change === "delete") await db.delete(posts).where(eq(posts.id, id));
      else
        await db
          .update(posts)
          .set({ visibility: change })
          .where(eq(posts.id, id));
      for (const suffix of ["", "?cursor=0"]) {
        expect((await activityRequest(path + suffix)).status).toBe(
          change === "delete" ? 404 : 401,
        );
      }
    },
  );

  it("refreshes counts after expiry while pages reflect reply changes immediately", async () => {
    const id = await createPost(accountId);
    const replyId = await createPost(accountId, { replyTargetId: id });
    const path = `/@hollo/${id}/replies`;
    const start = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(start);
    expect((await (await activityRequest(path)).json()).totalItems).toBe(1);
    await db
      .update(posts)
      .set({ visibility: "private" })
      .where(eq(posts.id, replyId));
    {
      const page = await activityRequest(path + "?cursor=0");
      expect(page.status).toBe(200);
      expect(await page.json()).toMatchObject({
        type: "OrderedCollectionPage",
      });
      // JSON-LD omits an empty orderedItems property.
      const empty = await activityRequest(path + "?cursor=0");
      expect(await empty.json()).not.toHaveProperty("orderedItems");
    }
    expect((await (await activityRequest(path)).json()).totalItems).toBe(1);
    clock.mockReturnValue(start + 5000);
    expect((await (await activityRequest(path)).json()).totalItems).toBe(0);
    await db
      .update(posts)
      .set({ visibility: "public" })
      .where(eq(posts.id, replyId));
    clock.mockReturnValue(start + 10000);
    expect((await (await activityRequest(path)).json()).totalItems).toBe(1);
    await db.delete(posts).where(eq(posts.id, replyId));
    {
      const page = await activityRequest(path + "?cursor=0");
      expect(page.status).toBe(200);
      expect(await page.json()).toMatchObject({
        type: "OrderedCollectionPage",
      });
      // JSON-LD omits an empty orderedItems property.
      const empty = await activityRequest(path + "?cursor=0");
      expect(await empty.json()).not.toHaveProperty("orderedItems");
    }
    expect((await (await activityRequest(path)).json()).totalItems).toBe(1);
    clock.mockReturnValue(start + 15000);
    expect((await (await activityRequest(path)).json()).totalItems).toBe(0);
    await createPost(accountId, { replyTargetId: id });
    expect((await (await activityRequest(path)).json()).totalItems).toBe(0);
    clock.mockReturnValue(start + 20000);
    expect((await (await activityRequest(path)).json()).totalItems).toBe(1);
  });

  it("rechecks follower authorization on a new request", async () => {
    const id = await createPost(accountId, { visibility: "private" });
    const follower = await createRemoteAccount("revoked-follower");
    await db.insert(follows).values({
      iri: `https://remote.test/follows/${crypto.randomUUID()}`,
      followingId: accountId as Uuid,
      followerId: follower.id,
      approved: new Date(),
    });
    const values = { username: "hollo", id };
    const ctx = requestContext(follower.iri);
    const keyOwner = vi.spyOn(ctx, "getSignedKeyOwner");
    await expect(countRepliesCollection(ctx, values)).resolves.toBe(0);
    await expect(
      dispatchRepliesCollection(ctx, values, "0"),
    ).resolves.not.toBeNull();
    expect(keyOwner).toHaveBeenCalledTimes(1);
    await db.delete(follows).where(eq(follows.followerId, follower.id));
    await expect(
      countRepliesCollection(requestContext(follower.iri), values),
    ).resolves.toBeNull();
  });

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
