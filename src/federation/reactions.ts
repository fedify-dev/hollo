import {
  type Collection,
  Emoji,
  EmojiReact,
  Image,
  Like,
  Link,
} from "@fedify/vocab";

import type { DatabaseLike } from "../db";
import {
  type Account,
  type AccountOwner,
  reactions,
  type Post,
} from "../schema";
import { persistAccount, type PersistAccountOptions } from "./account";
import { iterateCollection } from "./collection";

export const REMOTE_EMOJI_REACTIONS_FETCH_MAX_ITEMS = parseNonNegativeInteger(
  "REMOTE_EMOJI_REACTIONS_FETCH_MAX_ITEMS",
  100,
);

type RemoteReactionPost = Post & {
  account: Account & { owner: AccountOwner | null };
};

type EmojiReactionFetchOptions = PersistAccountOptions & {
  crossOrigin?: "ignore" | "throw" | "trust";
  suppressError?: boolean;
};

export async function getEmojiReactionCustomEmoji(
  react: EmojiReact | Like,
  emoji: string,
  options: EmojiReactionFetchOptions = {},
): Promise<{ customEmoji: URL | null; emojiIri: URL | null }> {
  let emojiIri: URL | null = null;
  let customEmoji: URL | null = null;
  if (!emoji.startsWith(":") || !emoji.endsWith(":")) {
    return { customEmoji, emojiIri };
  }
  for await (const tag of react.getTags(options)) {
    if (
      tag.id == null ||
      !(tag instanceof Emoji) ||
      tag.name?.toString()?.trim() !== emoji
    ) {
      continue;
    }
    const icon = await tag.getIcon(options);
    if (!(icon instanceof Image) || icon.url == null) continue;
    customEmoji = icon.url instanceof Link ? icon.url.href : icon.url;
    emojiIri = tag.id;
    if (customEmoji != null) break;
  }
  return { customEmoji, emojiIri };
}

export async function persistRemoteEmojiReactions(
  db: DatabaseLike,
  collection: Collection,
  post: RemoteReactionPost,
  baseUrl: URL | string,
  options: EmojiReactionFetchOptions & {
    maxItems?: number;
  } = {},
): Promise<void> {
  const maxItems = options.maxItems ?? REMOTE_EMOJI_REACTIONS_FETCH_MAX_ITEMS;
  if (maxItems < 1) return;
  if (post.account.owner != null) return;

  let fetchedItems = 0;
  for await (const item of iterateCollection(collection, {
    ...options,
    crossOrigin: "trust",
    suppressError: true,
  })) {
    if (fetchedItems >= maxItems) break;
    fetchedItems++;
    if (!(item instanceof EmojiReact)) continue;
    if (item.objectId?.href !== post.iri) continue;
    const emoji = item.content?.toString().trim();
    if (emoji == null || emoji === "") continue;
    const actor = await item.getActor({
      ...options,
      crossOrigin: "trust",
      suppressError: true,
    });
    if (actor == null) continue;
    const account = await persistAccount(db, actor, baseUrl, {
      ...options,
      skipUpdate: true,
    });
    if (account == null) continue;
    const { customEmoji, emojiIri } = await getEmojiReactionCustomEmoji(
      item,
      emoji,
      { ...options, crossOrigin: "trust", suppressError: true },
    );
    await db
      .insert(reactions)
      .values({
        postId: post.id,
        accountId: account.id,
        emoji,
        customEmoji: customEmoji?.href,
        emojiIri: emojiIri?.href,
      })
      .onConflictDoNothing({
        target: [reactions.postId, reactions.accountId, reactions.emoji],
      });
  }
}

function parseNonNegativeInteger(name: string, fallback: number): number {
  const value = parseInteger(name, fallback);
  return value < 0 ? fallback : value;
}

function parseInteger(name: string, fallback: number): number {
  // oxlint-disable-next-line typescript/dot-notation
  const envValue = process.env[name];
  if (envValue == null || envValue.trim() === "") return fallback;
  const value = Number.parseInt(envValue, 10);
  return Number.isInteger(value) ? value : fallback;
}
