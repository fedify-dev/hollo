import type { InboxContext } from "@fedify/fedify";
import { Emoji, EmojiReact, Image, Like, Person, Undo } from "@fedify/vocab";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import { createAccount } from "../../tests/helpers/oauth";
import db from "../db";
import { accounts, instances, likes, posts, reactions } from "../schema";
import type { Uuid } from "../uuid";
import {
  onEmojiReactionAdded,
  onEmojiReactionRemoved,
  onLiked,
  onUnliked,
} from "./inbox";

async function seedRemoteTargetPost(): Promise<{ id: Uuid; iri: string }> {
  await db
    .insert(instances)
    .values({
      host: "remote.test",
      software: "misskey",
      softwareVersion: null,
    })
    .onConflictDoNothing();
  const remoteAccountId = crypto.randomUUID() as Uuid;
  const remoteAccountIri = "https://remote.test/@author";
  await db.insert(accounts).values({
    id: remoteAccountId,
    iri: remoteAccountIri,
    type: "Person",
    name: "Remote author",
    handle: "@author@remote.test",
    bioHtml: "",
    emojis: {},
    fieldHtmls: {},
    aliases: [],
    protected: false,
    inboxUrl: `${remoteAccountIri}/inbox`,
    followersUrl: `${remoteAccountIri}/followers`,
    sharedInboxUrl: "https://remote.test/inbox",
    featuredUrl: `${remoteAccountIri}/featured`,
    instanceHost: "remote.test",
    published: new Date(),
  });
  const postId = crypto.randomUUID() as Uuid;
  const postIri = "https://remote.test/notes/remote-1";
  await db.insert(posts).values({
    id: postId,
    iri: postIri,
    type: "Note",
    accountId: remoteAccountId,
    visibility: "public",
    tags: {},
    emojis: {},
    sensitive: false,
    updated: new Date(),
  });
  return { id: postId, iri: postIri };
}

async function seedLocalLiker(): Promise<{ iri: string }> {
  const owner = await createAccount({ username: "liker" });
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, owner.id as Uuid),
  });
  if (account == null) {
    throw new Error("Failed to seed local liker");
  }
  return { iri: account.iri };
}

function createCtx() {
  const forwardActivity = vi.fn(async () => undefined);
  const ctx = {
    origin: "https://hollo.test",
    parseUri: () => null,
    forwardActivity,
  } as unknown as InboxContext<void>;
  return { ctx, forwardActivity };
}

function createLocalPerson(iri: string): Person {
  return new Person({
    id: new URL(iri),
    preferredUsername: "liker",
    name: "Liker",
    inbox: new URL(`${iri}/inbox`),
    followers: new URL(`${iri}/followers`),
  });
}

describe("federation inbox reaction target fallback", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists Like for remote object IRI via fallback and remains idempotent", async () => {
    expect.assertions(3);
    const target = await seedRemoteTargetPost();
    const liker = await seedLocalLiker();
    const person = createLocalPerson(liker.iri);
    const { ctx, forwardActivity } = createCtx();
    const activity = new Like({
      actor: person,
      object: new URL(target.iri),
    });

    await onLiked(ctx, activity as unknown as Like);
    await onLiked(ctx, activity as unknown as Like);

    const foundLikes = await db.query.likes.findMany({
      where: eq(likes.postId, target.id),
    });
    expect(foundLikes).toHaveLength(1);
    expect(foundLikes[0]?.postId).toBe(target.id);
    expect(forwardActivity).not.toHaveBeenCalled();
  });

  it("persists EmojiReact for remote object IRI via fallback and remains idempotent", async () => {
    expect.assertions(3);
    const target = await seedRemoteTargetPost();
    const liker = await seedLocalLiker();
    const person = createLocalPerson(liker.iri);
    const { ctx, forwardActivity } = createCtx();
    const activity = new EmojiReact({
      actor: person,
      object: new URL(target.iri),
      content: "👍",
    });

    await onEmojiReactionAdded(ctx, activity as unknown as EmojiReact);
    await onEmojiReactionAdded(ctx, activity as unknown as EmojiReact);

    const foundReactions = await db.query.reactions.findMany({
      where: eq(reactions.postId, target.id),
    });
    expect(foundReactions).toHaveLength(1);
    expect(foundReactions[0]?.emoji).toBe("👍");
    expect(forwardActivity).not.toHaveBeenCalled();
  });
});

describe.each([EmojiReact, Like])(
  "Unicode normalization for inbound %s",
  (Activity) => {
    beforeEach(async () => {
      await cleanDatabase();
    });

    async function setup() {
      const owner = await createAccount({ username: "author" });
      const id = crypto.randomUUID() as Uuid;
      const iri = `https://hollo.test/@author/${id}`;
      await db.insert(posts).values({
        id,
        iri,
        type: "Note",
        accountId: owner.id as Uuid,
        visibility: "public",
        tags: {},
        emojis: {},
        sensitive: false,
        updated: new Date(),
      });
      const liker = await seedLocalLiker();
      return {
        target: { id, iri },
        person: createLocalPerson(liker.iri),
        ...createCtx(),
      };
    }

    const add = (ctx: InboxContext<void>, activity: EmojiReact | Like) =>
      activity instanceof Like
        ? onLiked(ctx, activity)
        : onEmojiReactionAdded(ctx, activity);
    const remove = Activity === Like ? onUnliked : onEmojiReactionRemoved;

    it.each([
      ["❤", "❤️"],
      ["❤️", "❤"],
      ["✌", "✌️"],
      ["🏳️‍🌈", "🏳️‍🌈"],
    ])(
      "normalizes and deduplicates %s, then handles Undo with %s",
      async (content, undoContent) => {
        const { target, person, ctx, forwardActivity } = await setup();
        const activity = new Activity({
          actor: person,
          object: new URL(target.iri),
          content: ` ${content} `,
        });
        await add(ctx, activity);
        await add(
          ctx,
          new Activity({
            actor: person,
            object: new URL(target.iri),
            content: undoContent,
          }),
        );
        const found = await db.query.reactions.findMany();
        expect(found.map((r) => r.emoji)).toEqual([
          content === "❤️" ? content : undoContent,
        ]);
        expect(activity.content).toBe(` ${content} `);
        expect(forwardActivity).toHaveBeenCalledTimes(2);
        await remove(
          ctx,
          new Undo({
            actor: person,
            object: new Activity({
              actor: person,
              object: new URL(target.iri),
              content: undoContent,
            }),
          }),
        );
        expect(await db.query.reactions.findMany()).toEqual([]);
        expect(await db.query.likes.findMany()).toEqual([]);
        expect(forwardActivity).toHaveBeenCalledTimes(3);
      },
    );

    it.each(["3*14159", "👍🎉", "❤❤❤", "text", ""])(
      "ignores invalid content %j before actor lookup or forwarding",
      async (content) => {
        const { target, person, ctx, forwardActivity } = await setup();
        const activity = new Activity({
          actor: person,
          object: new URL(target.iri),
          content,
        });
        const getActor = vi.spyOn(activity, "getActor");
        const undo = new Undo({ actor: person, object: activity });
        const getUndoActor = vi.spyOn(undo, "getActor");
        await add(ctx, activity);
        await remove(ctx, undo);
        expect(getActor).not.toHaveBeenCalled();
        expect(getUndoActor).not.toHaveBeenCalled();
        expect(await db.query.reactions.findMany()).toEqual([]);
        expect(await db.query.likes.findMany()).toEqual([]);
        expect(await db.query.notifications.findMany()).toEqual([]);
        expect(forwardActivity).not.toHaveBeenCalled();
      },
    );

    it("preserves custom emoji tags and allows Undo", async () => {
      const { target, person, ctx } = await setup();
      const activity = new Activity({
        actor: person,
        object: new URL(target.iri),
        content: ":blobcat:",
        tags: [
          new Emoji({
            id: new URL("https://remote.test/emoji/blobcat"),
            name: ":blobcat:",
            icon: new Image({
              url: new URL("https://remote.test/blobcat.png"),
            }),
          }),
        ],
      });
      await add(ctx, activity);
      const [stored] = await db.query.reactions.findMany();
      expect(stored.emoji).toBe(":blobcat:");
      expect(stored.customEmoji).toBe("https://remote.test/blobcat.png");
      expect(stored.emojiIri).toBe("https://remote.test/emoji/blobcat");
      await remove(ctx, new Undo({ actor: person, object: activity }));
      expect(await db.query.reactions.findMany()).toEqual([]);
    });

    it("removes canonical before legacy bare rows without merging them", async () => {
      const { target, person, ctx } = await setup();
      const account = await db.query.accounts.findFirst({
        where: eq(accounts.iri, person.id!.href),
      });
      await db.insert(reactions).values([
        { postId: target.id, accountId: account!.id, emoji: "❤" },
        { postId: target.id, accountId: account!.id, emoji: "❤️" },
      ]);
      const undo = new Undo({
        actor: person,
        object: new Activity({
          actor: person,
          object: new URL(target.iri),
          content: "❤",
        }),
      });
      await remove(ctx, undo);
      expect((await db.query.reactions.findMany()).map((r) => r.emoji)).toEqual(
        ["❤"],
      );
      await remove(ctx, undo);
      expect(await db.query.reactions.findMany()).toEqual([]);
    });
  },
);
