import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import app from "../index";
import {
  accounts,
  instances,
  type PostType,
  type PostVisibility,
  posts,
  reactions,
} from "../schema";
import type { Uuid } from "../uuid";

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
  type: PostType = "Note",
  visibility: PostVisibility = "public",
) {
  const id = crypto.randomUUID() as Uuid;
  await db.insert(posts).values({
    id,
    iri: `https://hollo.test/@hollo/${id}`,
    type,
    accountId: accountId as Uuid,
    visibility,
    contentHtml: "<p>reactable post</p>",
    content: "reactable post",
    url: `https://hollo.test/@hollo/${id}`,
    published: new Date(),
  });
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

describe("emojiReactions collection", () => {
  let accountId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const account = await createAccount({ generateKeyPair: true });
    accountId = account.id;
  });

  it.each(["Note", "Question", "Article"] as const)(
    "advertises emojiReactions on local %s objects",
    async (type) => {
      expect.assertions(2);
      const postId = await createPost(accountId, type);

      const response = await activityRequest(`/@hollo/${postId}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.emojiReactions).toBe(
        `https://hollo.test/@hollo/${postId}/reactions`,
      );
    },
  );

  it("serves emoji reactions as ordered EmojiReact activities", async () => {
    expect.assertions(11);
    const postId = await createPost(accountId);
    const alice = await createRemoteAccount("alice");
    const bob = await createRemoteAccount("bob");
    await db.insert(reactions).values([
      {
        postId,
        accountId: alice.id,
        emoji: "🔥",
        created: new Date("2026-06-01T00:00:00Z"),
      },
      {
        postId,
        accountId: bob.id,
        emoji: ":blob:",
        customEmoji: "https://remote.test/emoji/blob.png",
        emojiIri: "https://remote.test/emojis/blob",
        created: new Date("2026-06-02T00:00:00Z"),
      },
    ]);

    const collection = await activityRequest(`/@hollo/${postId}/reactions`);
    expect(collection.status).toBe(200);
    const collectionBody = await collection.json();
    expect(collectionBody.type).toBe("OrderedCollection");
    expect(collectionBody.totalItems).toBe(2);
    expect(collectionBody.first).toBe(
      `https://hollo.test/@hollo/${postId}/reactions?cursor=0`,
    );

    const page = await activityRequest(`/@hollo/${postId}/reactions?cursor=0`);
    expect(page.status).toBe(200);
    const pageBody = await page.json();
    expect(pageBody.type).toBe("OrderedCollectionPage");
    expect(pageBody.orderedItems).toHaveLength(2);
    expect(pageBody.orderedItems[0]).toMatchObject({
      type: "EmojiReact",
      actor: bob.iri,
      object: `https://hollo.test/@hollo/${postId}`,
      content: ":blob:",
    });
    expect(pageBody.orderedItems[0].tag).toMatchObject({
      type: "Emoji",
      id: "https://remote.test/emojis/blob",
      name: ":blob:",
    });
    expect(pageBody.orderedItems[1]).toMatchObject({
      type: "EmojiReact",
      actor: alice.iri,
      object: `https://hollo.test/@hollo/${postId}`,
      content: "🔥",
    });
    expect(pageBody.orderedItems[1].tag ?? []).toHaveLength(0);
  });

  it("paginates emoji reaction activities", async () => {
    expect.assertions(6);
    const postId = await createPost(accountId);
    const reactors = await Promise.all(
      Array.from({ length: 41 }, (_, index) =>
        createRemoteAccount(`reactor-${index}`),
      ),
    );
    await db.insert(reactions).values(
      reactors.map((reactor, index) => ({
        postId,
        accountId: reactor.id,
        emoji: "⭐",
        created: new Date(Date.UTC(2026, 5, 1, 0, 0, index)),
      })),
    );

    const first = await activityRequest(`/@hollo/${postId}/reactions?cursor=0`);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.orderedItems).toHaveLength(40);
    expect(firstBody.next).toBe(
      `https://hollo.test/@hollo/${postId}/reactions?cursor=40`,
    );

    const second = await activityRequest(
      `/@hollo/${postId}/reactions?cursor=40`,
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.orderedItems).toHaveLength(1);

    const invalid = await activityRequest(
      `/@hollo/${postId}/reactions?cursor=40invalid`,
    );
    expect(invalid.status).toBe(404);
  });

  it("does not expose reactions for unsigned private posts", async () => {
    expect.assertions(2);
    const postId = await createPost(accountId, "Note", "private");
    const reactor = await createRemoteAccount("reactor");
    await db.insert(reactions).values({
      postId,
      accountId: reactor.id,
      emoji: "🔥",
    });

    const response = await activityRequest(`/@hollo/${postId}/reactions`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("EmojiReact");
  });
});
