import { EmojiReact, Undo } from "@fedify/vocab";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../../tests/helpers/oauth";
import db from "../../db";
import federation from "../../federation";
import { accounts, customEmojis, posts, reactions } from "../../schema";
import { type Uuid, uuidv7 } from "../../uuid";
import app from "./statuses";

const routes = [
  { add: "react", addMethod: "POST", remove: "unreact", removeMethod: "POST" },
  {
    add: "emoji_reactions",
    addMethod: "PUT",
    remove: "emoji_reactions",
    removeMethod: "DELETE",
  },
];

describe.each(routes)("emoji reaction API ($addMethod $add)", (route) => {
  let accountId: Uuid;
  let postId: Uuid;
  let authorization: string;
  const context = federation.createContext(
    new Request("https://hollo.test/"),
    undefined,
  );
  const sendActivity = vi.spyOn(context, "sendActivity");

  beforeEach(async () => {
    await cleanDatabase();
    const account = await createAccount();
    accountId = account.id as Uuid;
    const client = await createOAuthApplication({ scopes: ["write"] });
    authorization = bearerAuthorization(
      await getAccessToken(client, account, ["write"]),
    );
    postId = uuidv7();
    await db.insert(posts).values({
      id: postId,
      iri: `https://hollo.test/@hollo/${postId}`,
      type: "Note",
      accountId,
      visibility: "public",
      tags: {},
      emojis: {},
      sensitive: false,
      updated: new Date(),
    });
    sendActivity.mockReset().mockResolvedValue(undefined);
    vi.spyOn(federation, "createContext").mockReturnValue(context);
  });

  afterEach(() => {
    vi.mocked(federation.createContext).mockRestore();
  });

  function request(emoji: string, remove = false) {
    return app.request(
      `https://hollo.test/${postId}/${remove ? route.remove : route.add}/${encodeURIComponent(emoji)}`,
      {
        method: remove ? route.removeMethod : route.addMethod,
        headers: { authorization },
      },
    );
  }

  it.each([
    ["❤", "❤️"],
    ["❤️", "❤"],
    ["✌", "✌️"],
    ["☹", "☹️"],
    ["☃", "☃️"],
    ["🏳️‍🌈", "🏳️‍🌈"],
    ["1️⃣", "1️⃣"],
    ["👨🏾‍⚕️", "👨🏾‍⚕️"],
  ])("adds %s and removes it using %s", async (input, removal) => {
    const canonical = input === "❤️" ? input : removal;
    const added = await request(input);
    expect(added.status).toBe(200);
    expect((await added.json()).emoji_reactions[0].name).toBe(canonical);
    const stored = await db.query.reactions.findMany();
    expect(stored.map((r) => r.emoji)).toEqual([canonical]);
    expect(sendActivity).toHaveBeenCalledTimes(2);
    const activity = sendActivity.mock.calls[0][2] as EmojiReact;
    expect(activity).toBeInstanceOf(EmojiReact);
    expect(activity.content).toBe(canonical);
    expect(activity.id?.href).toBe(
      new URL(
        `/#react/${accountId}/${postId}/${canonical}`,
        "https://hollo.test",
      ).href,
    );
    const orderingKey = `react:https://hollo.test/@hollo:https://hollo.test/@hollo/${postId}:${canonical}`;
    expect(
      sendActivity.mock.calls.slice(0, 2).map((c) => c[3]?.orderingKey),
    ).toEqual([orderingKey, orderingKey]);

    const removed = await request(removal, true);
    expect(removed.status).toBe(200);
    expect((await removed.json()).emoji_reactions).toEqual([]);
    expect(await db.query.reactions.findMany()).toEqual([]);
    expect(sendActivity).toHaveBeenCalledTimes(4);
    const undo = sendActivity.mock.calls[2][2] as Undo;
    expect(undo).toBeInstanceOf(Undo);
    expect(undo.id?.href).toBe(
      new URL(
        `/#react/undo/${accountId}/${postId}/${canonical}`,
        "https://hollo.test",
      ).href,
    );
    const object = await undo.getObject();
    expect(object).toBeInstanceOf(EmojiReact);
    expect(object?.id?.href).toBe(activity.id?.href);
    expect(object?.content).toBe(canonical);
    expect(
      sendActivity.mock.calls.slice(2).map((c) => c[3]?.orderingKey),
    ).toEqual([orderingKey, orderingKey]);
  });

  it.each(["3*14159", "👍🎉🙏🍎", "❤❤❤", "hello"])(
    "rejects invalid reaction %s without insertion or delivery",
    async (emoji) => {
      expect((await request(emoji)).status).toBe(404);
      expect((await request(emoji, true)).status).toBe(404);
      expect(await db.query.reactions.findMany()).toEqual([]);
      expect(sendActivity).not.toHaveBeenCalled();
    },
  );

  it.each(["blobcat", "1", "❤️"])(
    "preserves local custom shortcode %s and its activity identity",
    async (shortcode) => {
      await db.insert(customEmojis).values({
        shortcode,
        url: "https://hollo.test/emoji.png",
      });
      expect((await request(shortcode)).status).toBe(200);
      const [stored] = await db.query.reactions.findMany();
      expect(stored.emoji).toBe(`:${shortcode}:`);
      expect(stored.customEmoji).toBe("https://hollo.test/emoji.png");
      const activity = sendActivity.mock.calls[0][2] as EmojiReact;
      expect(activity.content).toBe(`:${shortcode}:`);
      expect(activity.id?.href).toBe(
        new URL(
          `/#react/${accountId}/${postId}/${shortcode}`,
          "https://hollo.test",
        ).href,
      );
      const tags = [];
      for await (const tag of activity.getTags()) tags.push(tag);
      expect(tags).toHaveLength(1);
      expect(tags[0].id?.href).toBe(stored.emojiIri);
      expect((await request(`${shortcode}@hollo.test`, true)).status).toBe(200);
      const undo = sendActivity.mock.calls[2][2] as Undo;
      expect((await undo.getObject())?.id?.href).toBe(activity.id?.href);
      expect(await db.query.reactions.findMany()).toEqual([]);
    },
  );

  it("keeps legacy bare rows removable, preferring the canonical row", async () => {
    await db.insert(reactions).values([
      { postId, accountId, emoji: "❤" },
      { postId, accountId, emoji: "❤️" },
    ]);
    expect((await request("❤", true)).status).toBe(200);
    expect((await db.query.reactions.findMany()).map((r) => r.emoji)).toEqual([
      "❤",
    ]);
    expect((await request("❤", true)).status).toBe(200);
    const undo = sendActivity.mock.calls[2][2] as Undo;
    const object = await undo.getObject();
    expect(object?.content).toBe("❤");
    expect(object?.id?.href).toBe(
      new URL(`/#react/${accountId}/${postId}/❤`, "https://hollo.test").href,
    );
    expect(await db.query.reactions.findMany()).toEqual([]);
  });

  it.each(["👍🎉", "3*14159", "❤❤❤"])(
    "removes legacy invalid Unicode %s only for the current owner and post",
    async (emoji) => {
      expect((await request(emoji)).status).toBe(404);
      const other = await createAccount({ username: "other" });
      const otherPostId = uuidv7();
      await db.insert(posts).values({
        id: otherPostId,
        iri: `https://hollo.test/@hollo/${otherPostId}`,
        type: "Note",
        accountId,
        visibility: "public",
        tags: {},
        emojis: {},
        sensitive: false,
        updated: new Date(),
      });
      await db.insert(reactions).values([
        { postId, accountId, emoji },
        { postId, accountId: other.id as Uuid, emoji },
        { postId: otherPostId, accountId, emoji },
      ]);
      expect((await request(emoji, true)).status).toBe(200);
      const undo = sendActivity.mock.calls[0][2] as Undo;
      const object = await undo.getObject();
      expect(object?.content).toBe(emoji);
      expect(object?.id?.href).toBe(
        new URL(`/#react/${accountId}/${postId}/${emoji}`, "https://hollo.test")
          .href,
      );
      const remaining = await db.query.reactions.findMany();
      expect(remaining).toHaveLength(2);
      expect(remaining).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ postId, accountId: other.id, emoji }),
          expect.objectContaining({ postId: otherPostId, accountId, emoji }),
        ]),
      );
      expect((await request(emoji, true)).status).toBe(404);
      expect(sendActivity).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps custom shortcode precedence over legacy raw values", async () => {
    await db.insert(customEmojis).values({
      shortcode: "1",
      url: "https://hollo.test/emoji.png",
    });
    expect((await request("1")).status).toBe(200);
    await db.insert(reactions).values({ postId, accountId, emoji: "1" });
    expect((await request("1", true)).status).toBe(200);
    expect((await db.query.reactions.findMany()).map((r) => r.emoji)).toEqual([
      "1",
    ]);
    expect((await request("1", true)).status).toBe(404);
  });

  it("preserves remote custom emoji metadata when copying a reaction", async () => {
    const remote = await createAccount({ username: "remote" });
    // The remote-custom path identifies the source by its handle's domain.
    await db.insert(reactions).values({
      postId,
      accountId: remote.id as Uuid,
      emoji: ":blobcat:",
      customEmoji: "https://remote.test/blobcat.png",
      emojiIri: "https://remote.test/emoji/blobcat",
    });
    expect((await request("blobcat@hollo.test")).status).toBe(404);
    // A domain other than the request host exercises the remote-copy path.
    await db
      .update(accounts)
      .set({ handle: "@remote@remote.test" })
      .where(eq(accounts.id, remote.id as Uuid));
    expect((await request("blobcat@remote.test")).status).toBe(200);
    const stored = await db.query.reactions.findFirst({
      where: eq(reactions.accountId, accountId),
    });
    expect(stored?.emoji).toBe(":blobcat:");
    expect(stored?.customEmoji).toBe("https://remote.test/blobcat.png");
    expect(stored?.emojiIri).toBe("https://remote.test/emoji/blobcat");
    expect((sendActivity.mock.calls[0][2] as EmojiReact).content).toBe(
      ":blobcat:",
    );
  });
});
