import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import {
  type Announce,
  Article,
  ChatMessage,
  Collection,
  Create,
  Delete,
  Document,
  type DocumentLoader,
  Emoji,
  Hashtag,
  Image,
  isActor,
  LanguageString,
  Link,
  lookupObject,
  Note,
  OrderedCollection,
  PUBLIC_COLLECTION,
  Question,
  type Recipient,
  Source,
  Tombstone,
  Update,
  Video,
} from "@fedify/vocab";

import { getLogger } from "@logtape/logtape";
import {
  and,
  count,
  type ExtractTablesWithRelations,
  eq,
  gte,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import sharp from "sharp";
// @ts-expect-error: No type definitions available
import { isSSRFSafeURL } from "ssrfcheck";
import { makeVideoScreenshot, type Thumbnail, uploadThumbnail } from "../media";
import { fetchPreviewCard } from "../previewcard";
import type * as schema from "../schema";
import {
  type Account,
  type AccountOwner,
  accountOwners,
  likes,
  type Medium,
  type Mention,
  media,
  mentions,
  type NewMedium,
  type NewPost,
  type Poll,
  type PollOption,
  type PollVote,
  type Post,
  pollOptions,
  polls,
  pollVotes,
  posts,
} from "../schema";
import { extractPreviewLink } from "../text";
import { type Uuid, uuidv7 } from "../uuid";
import { persistAccount, persistAccountByIri } from "./account";
import { iterateCollection } from "./collection";
import { toDate, toTemporalInstant } from "./date";
import { toEmoji } from "./emoji";
import { appendPostToTimelines } from "./timeline";

const logger = getLogger(["hollo", "federation", "post"]);

export type ASPost = Article | Note | Question | ChatMessage;

export function isPost(object?: vocab.Object | Link | null): object is ASPost {
  return (
    object instanceof Article ||
    object instanceof Note ||
    object instanceof Question ||
    object instanceof ChatMessage
  );
}

export async function persistPost(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  object: ASPost,
  baseUrl: URL | string,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
    account?: Account & { owner: AccountOwner | null };
    replyTarget?: Post;
    skipUpdate?: boolean;
  } = {},
): Promise<
  | (Post & {
      account: Account & { owner: AccountOwner | null };
      mentions: Mention[];
    })
  | null
> {
  if (object.id == null) return null;
  const existingPost = await db.query.posts.findFirst({
    with: { account: { with: { owner: true } }, mentions: true },
    where: eq(posts.iri, object.id.href),
  });
  if (options.skipUpdate && existingPost != null) return existingPost;
  if (existingPost != null && existingPost.account.owner != null) {
    return existingPost;
  }
  const actor = await object.getAttribution(options);
  logger.debug("Fetched actor: {actor}", { actor });
  if (!isActor(actor)) return null;
  const account =
    options?.account != null && options.account.iri === actor.id?.href
      ? options.account
      : await persistAccount(db, actor, baseUrl, {
          ...options,
          skipUpdate: true,
        });
  logger.debug("Persisted account: {account}", { account });
  if (account == null) return null;
  let replyTargetId: Uuid | null = null;
  let replyTargetObj: Post | null = null;
  if (object.replyTargetId != null) {
    if (
      options.replyTarget != null &&
      options.replyTarget.iri === object.replyTargetId?.href
    ) {
      replyTargetId = options.replyTarget.id;
    } else {
      const result = await db
        .select({ id: posts.id })
        .from(posts)
        .where(eq(posts.iri, object.replyTargetId.href))
        .limit(1);
      if (result != null && result.length > 0) {
        replyTargetId = result[0].id;
        logger.debug("The reply target is already persisted: {replyTargetId}", {
          replyTargetId,
        });
      } else {
        logger.debug("Persisting the reply target...");
        const replyTarget = await object.getReplyTarget(options);
        if (isPost(replyTarget)) {
          replyTargetObj = await persistPost(db, replyTarget, baseUrl, {
            ...options,
            skipUpdate: true,
          });
          logger.debug("Persisted the reply target: {replyTarget}", {
            replyTarget: replyTargetObj,
          });
          replyTargetId = replyTargetObj?.id ?? null;
        }
      }
    }
  }
  const tags: Record<string, string> = {};
  const emojis: Record<string, string> = {};
  let objectLink: URL | null = null; // FEP-e232
  for await (const tag of object.getTags(options)) {
    if (tag instanceof Hashtag && tag.name != null && tag.href != null) {
      tags[tag.name.toString()] = tag.href.href;
    } else if (tag instanceof Emoji && tag.name != null) {
      const icon = await tag.getIcon();
      if (icon?.url == null) continue;
      let href: string;
      if (icon.url instanceof Link) {
        if (icon.url.href == null) continue;
        href = icon.url.href.href;
      } else href = icon.url.href;
      emojis[tag.name.toString()] = href;
    } else if (
      objectLink == null &&
      tag instanceof Link &&
      (tag.mediaType === "application/activity+json" ||
        tag.mediaType?.match(
          /^application\/ld\+json\s*;\s*profile="https:\/\/www\.w3\.org\/ns\/activitystreams"/,
        )) &&
      tag.href != null
    ) {
      objectLink = tag.href;
    }
  }
  let quoteTargetId: Uuid | null = null;
  if (objectLink == null && object.quoteUrl != null) {
    objectLink = object.quoteUrl;
  }
  if (objectLink != null) {
    const result = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.iri, objectLink.href))
      .limit(1);
    if (result != null && result.length > 0) {
      quoteTargetId = result[0].id;
      logger.debug("The quote target is already persisted: {quoteTargetId}", {
        quoteTargetId,
      });
    } else {
      logger.debug("Persisting the quote target...");
      const quoteTarget = await lookupObject(objectLink, options);
      if (isPost(quoteTarget)) {
        const quoteTargetObj = await persistPost(db, quoteTarget, baseUrl, {
          ...options,
          skipUpdate: true,
        });
        logger.debug("Persisted the quote target: {quoteTarget}", {
          quoteTarget: quoteTargetObj,
        });
        quoteTargetId = quoteTargetObj?.id ?? null;
      }
    }
  }
  const to = new Set(object.toIds.map((url) => url.href));
  const cc = new Set(object.ccIds.map((url) => url.href));
  const replies = await object.getReplies(options);
  const shares = await object.getShares(options);
  const likes = await object.getLikes(options);
  const previewLink =
    object.content == null
      ? null
      : extractPreviewLink(object.content.toString());
  const previewCard =
    previewLink == null ? null : await fetchPreviewCard(previewLink);
  const published = toDate(object.published);
  const updated = toDate(object.updated) ?? published ?? new Date();
  const values = {
    type:
      object instanceof Question
        ? "Question"
        : object instanceof Article
          ? "Article"
          : "Note",
    accountId: account.id,
    applicationId: null,
    replyTargetId,
    sharingId: null,
    quoteTargetId,
    visibility: to.has(PUBLIC_COLLECTION.href)
      ? "public"
      : cc.has(PUBLIC_COLLECTION.href)
        ? "unlisted"
        : account.followersUrl != null && to.has(account.followersUrl)
          ? "private"
          : "direct",
    summary: object.summary?.toString(),
    contentHtml: object.content?.toString(),
    language:
      object.content instanceof LanguageString
        ? object.content.locale.toString()
        : object.summary instanceof LanguageString
          ? object.summary.locale.toString()
          : null,
    previewCard,
    tags,
    emojis,
    sensitive: object.sensitive ?? false,
    url: object.url instanceof Link ? object.url.href?.href : object.url?.href,
    repliesCount: replies?.totalItems ?? 0,
    sharesCount: shares?.totalItems ?? 0,
    likesCount: likes?.totalItems ?? 0,
    published,
    updated,
  } as const;
  await db
    .insert(posts)
    .values({
      ...values,
      id: uuidv7(+(published ?? updated)),
      iri: object.id.href,
    })
    .onConflictDoUpdate({
      target: [posts.iri],
      set: values,
      setWhere: eq(posts.iri, object.id.href),
    });
  let post = await db.query.posts.findFirst({
    where: eq(posts.iri, object.id.href),
  });
  if (post == null) return null;
  if (object instanceof Question) {
    const options: [string, number][] = [];
    let multiple = false;
    for await (const option of object.getExclusiveOptions()) {
      if (option instanceof Note && option.name != null) {
        const replies = await option.getReplies();
        options.push([option.name.toString(), replies?.totalItems ?? 0]);
      }
    }
    if (options.length < 1) {
      for await (const option of object.getInclusiveOptions()) {
        if (option instanceof Note && option.name != null) {
          const replies = await option.getReplies();
          options.push([option.name.toString(), replies?.totalItems ?? 0]);
        }
        multiple = true;
      }
    }
    if (options.length > 0 && object.endTime != null) {
      if (post.pollId == null) {
        const [poll] = await db
          .insert(polls)
          .values({
            id: uuidv7(),
            multiple,
            votersCount: object.voters ?? 0,
            expires: toDate(object.endTime),
          })
          .returning();
        await db.insert(pollOptions).values(
          options.map(([title, votesCount], index) => ({
            pollId: poll.id,
            index,
            title,
            votesCount,
          })),
        );
        await db
          .update(posts)
          .set({ pollId: poll.id })
          .where(eq(posts.id, post.id));
      } else {
        const [poll] = await db
          .update(polls)
          .set({
            multiple,
            votersCount: object.voters ?? 0,
            expires: toDate(object.endTime),
          })
          .where(eq(polls.id, post.pollId))
          .returning();
        for (let index = 0; index < options.length; index++) {
          const [title, votesCount] = options[index];
          await db
            .insert(pollOptions)
            .values({ pollId: poll.id, index, title, votesCount })
            .onConflictDoUpdate({
              target: [pollOptions.pollId, pollOptions.index],
              set: { title, votesCount },
              setWhere: and(
                eq(pollOptions.pollId, poll.id),
                eq(pollOptions.index, index),
              ),
            });
        }
        await db
          .delete(pollOptions)
          .where(
            and(
              eq(pollOptions.pollId, post.pollId),
              gte(pollOptions.index, options.length),
            ),
          );
      }
    }
  }
  const mentionRows: Mention[] = [];
  await db.delete(mentions).where(eq(mentions.postId, post.id));
  for await (const tag of object.getTags(options)) {
    if (tag instanceof vocab.Mention && tag.name != null && tag.href != null) {
      const account = await persistAccountByIri(
        db,
        tag.href.href,
        baseUrl,
        options,
      );
      if (account == null) continue;
      const result = await db
        .insert(mentions)
        .values({
          accountId: account.id,
          postId: post.id,
        })
        .onConflictDoNothing({
          target: [mentions.accountId, mentions.postId],
        })
        .returning();
      mentionRows.push(...result);
    }
  }
  await db.delete(media).where(eq(media.postId, post.id));
  for await (const attachment of object.getAttachments(options)) {
    if (
      !(
        attachment instanceof Image ||
        attachment instanceof Video ||
        attachment instanceof Document
      )
    ) {
      continue;
    }
    const url =
      attachment.url instanceof Link
        ? attachment.url.href?.href
        : attachment.url?.href;
    if (url == null || !isSSRFSafeURL(url)) continue;
    const response = await fetch(url);
    const mediaType =
      response.headers.get("Content-Type") ?? attachment.mediaType;
    if (mediaType == null) continue;
    const id = uuidv7();
    let thumbnail: Thumbnail;
    let metadata: { width?: number; height?: number };
    try {
      const imageData = new Uint8Array(await response.arrayBuffer());
      let imageBytes: Uint8Array = imageData;
      if (mediaType.startsWith("video/")) {
        imageBytes = await makeVideoScreenshot(imageData);
      }
      const image = sharp(imageBytes);
      metadata = await image.metadata();
      thumbnail = await uploadThumbnail(id, image);
    } catch {
      metadata = {
        width: attachment.width ?? 512,
        height: attachment.height ?? 512,
      };
      thumbnail = {
        thumbnailUrl: url,
        thumbnailType: mediaType,
        thumbnailWidth: metadata.width!,
        thumbnailHeight: metadata.height!,
      };
    }
    await db.insert(media).values({
      id,
      postId: post.id,
      type: mediaType,
      url,
      description:
        attachment.summary?.toString() ?? attachment.name?.toString(),
      width: attachment.width ?? metadata.width!,
      height: attachment.height ?? metadata.height!,
      ...thumbnail,
    } satisfies NewMedium);
  }
  post = await db.query.posts.findFirst({
    where: eq(posts.iri, object.id.href),
    with: { account: true, media: true },
  });
  if (post == null) return null;
  if (replies != null) {
    for await (const item of iterateCollection(replies, {
      ...options,
      suppressError: true,
    })) {
      if (!isPost(item)) continue;
      await persistPost(db, item, baseUrl, {
        ...options,
        skipUpdate: true,
        replyTarget: post,
      });
    }
  }
  await appendPostToTimelines(db, {
    ...post,
    sharing: null,
    mentions: mentionRows,
    replyTarget: replyTargetObj,
  });
  return { ...post, account, mentions: mentionRows };
}

export async function persistSharingPost(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  announce: Announce,
  object: ASPost,
  baseUrl: URL | string,
  options: {
    account?: Account & { owner: AccountOwner | null };
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<
  | (Post & {
      account: Account & { owner: AccountOwner | null };
      sharing:
        | (Post & { account: Account & { owner: AccountOwner | null } })
        | null;
    })
  | null
> {
  if (announce.id == null) return null;
  const existingPost = await db.query.posts.findFirst({
    with: {
      account: { with: { owner: true } },
      sharing: { with: { account: { with: { owner: true } } } },
    },
    where: eq(posts.iri, announce.id.href),
  });
  if (existingPost != null) return existingPost;
  const actor = await announce.getActor(options);
  if (actor == null) return null;
  const account =
    options.account?.iri != null && options.account.iri === actor.id?.href
      ? options.account
      : await persistAccount(db, actor, baseUrl, {
          ...options,
          skipUpdate: true,
        });
  if (account == null) return null;
  const originalPost = await persistPost(db, object, baseUrl, {
    ...options,
    skipUpdate: true,
  });
  if (originalPost == null) return null;
  const id = uuidv7();
  const updated = new Date();
  const result = await db
    .insert(posts)
    .values({
      ...originalPost,
      id,
      iri: announce.id.href,
      accountId: account.id,
      applicationId: null,
      replyTargetId: null,
      sharingId: originalPost.id,
      quoteTargetId: null,
      visibility: announce.toIds
        .map((iri) => iri.href)
        .includes(PUBLIC_COLLECTION.href)
        ? "public"
        : announce.ccIds.map((iri) => iri.href).includes(PUBLIC_COLLECTION.href)
          ? "unlisted"
          : "private",
      url: originalPost.url,
      published: toDate(announce.published) ?? updated,
      updated,
    } satisfies NewPost)
    .returning();
  await db
    .update(posts)
    .set({ sharesCount: sql`coalesce(${posts.sharesCount}, 0) + 1` })
    .where(eq(posts.id, originalPost.id));
  await appendPostToTimelines(db, {
    ...result[0],
    sharing: originalPost,
    mentions: [],
    replyTarget: null,
  });
  return result[0] == null
    ? null
    : { ...result[0], account, sharing: originalPost };
}

export async function persistPollVote(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  object: Note,
  baseUrl: URL | string,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
    account?: Account;
  } = {},
): Promise<PollVote | null> {
  if (
    object.replyTargetId == null ||
    object.attributionId == null ||
    object.name == null
  ) {
    return null;
  }
  const post = await db.query.posts.findFirst({
    with: {
      poll: { with: { options: { orderBy: pollOptions.index } } },
    },
    where: and(
      eq(posts.iri, object.replyTargetId.href),
      eq(posts.type, "Question"),
      isNotNull(posts.pollId),
    ),
  });
  if (post == null) return null;
  const poll = post.poll;
  if (poll == null) return null;
  const voter = await persistAccountByIri(
    db,
    object.attributionId.href,
    baseUrl,
    options,
  );
  if (voter == null) return null;
  if (!poll.multiple) {
    const deleted = await db
      .delete(pollVotes)
      .where(
        and(eq(pollVotes.accountId, voter.id), eq(pollVotes.pollId, poll.id)),
      )
      .returning();
    for (const vote of deleted) {
      await db
        .update(pollOptions)
        .set({
          votesCount: sql`${pollOptions.votesCount} - 1`,
        })
        .where(
          and(
            eq(pollOptions.pollId, poll.id),
            eq(pollOptions.index, vote.optionIndex),
          ),
        );
    }
    if (deleted.length > 0) {
      await db
        .update(polls)
        .set({
          votersCount: sql`${polls.votersCount} - 1`,
        })
        .where(eq(polls.id, poll.id));
    }
  }
  const optionTitle = object.name.toString();
  const optionIndex = poll.options.findIndex((o) => o.title === optionTitle);
  const votes = await db
    .insert(pollVotes)
    .values({
      accountId: voter.id,
      pollId: poll.id,
      optionIndex,
    })
    .returning();
  if (votes.length < 1) return null;
  await db
    .update(pollOptions)
    .set({
      votesCount: sql`${pollOptions.votesCount} + 1`,
    })
    .where(
      and(
        eq(pollOptions.pollId, poll.id),
        eq(pollOptions.index, votes[0].optionIndex),
      ),
    );
  await db
    .update(polls)
    .set({
      votersCount: sql`${polls.votersCount} + 1`,
    })
    .where(eq(polls.id, poll.id));
  return votes[0];
}

export async function updatePostStats(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  { id }: { id: Uuid },
): Promise<void> {
  const repliesCount = db
    .select({ cnt: count() })
    .from(posts)
    .where(eq(posts.replyTargetId, id));
  const sharesCount = db
    .select({ cnt: count() })
    .from(posts)
    .where(eq(posts.sharingId, id));
  const likesCount = db
    .select({ cnt: count() })
    .from(likes)
    .where(eq(likes.postId, id));
  const quotesCount = db
    .select({ cnt: count() })
    .from(posts)
    .where(eq(posts.quoteTargetId, id));
  await db
    .update(posts)
    .set({
      repliesCount: sql`${repliesCount}`,
      sharesCount: sql`${sharesCount}`,
      likesCount: sql`${likesCount}`,
      quotesCount: sql`${quotesCount}`,
    })
    .where(
      and(
        eq(posts.id, id),
        inArray(
          posts.accountId,
          db.select({ id: accountOwners.id }).from(accountOwners),
        ),
      ),
    );
}

export function toObject(
  post: Post & {
    account: Account & { owner: AccountOwner | null };
    replyTarget: Post | null;
    quoteTarget: Post | null;
    media: Medium[];
    poll: (Poll & { options: PollOption[] }) | null;
    mentions: (Mention & { account: Account })[];
    replies: Post[];
  },
  ctx: Context<unknown>,
): ASPost {
  const cls =
    post.type === "Question"
      ? Question
      : post.type === "Article"
        ? Article
        : Note;
  const options =
    post.poll == null
      ? []
      : post.poll.options
          .toSorted((a, b) => (a.index < b.index ? -1 : 1))
          .map(
            (o) =>
              new Note({
                name: o.title,
                replies: new Collection({ totalItems: o.votesCount }),
              }),
          );
  return new cls({
    id: new URL(post.iri),
    attribution: new URL(post.account.iri),
    tos: [
      // For public posts, include PUBLIC_COLLECTION
      // For private posts, include followers collection
      // For direct messages, don't include any collections
      ...(post.visibility === "public"
        ? [PUBLIC_COLLECTION]
        : post.visibility === "private" && post.account.owner != null
          ? [ctx.getFollowersUri(post.account.owner.handle)]
          : []),
      // Always include mentioned users in the to field
      ...post.mentions.map((m) => new URL(m.account.iri)),
    ],
    // For unlisted posts, include PUBLIC_COLLECTION in cc
    // For all other visibilities, cc is null
    cc: post.visibility === "unlisted" ? PUBLIC_COLLECTION : null,
    summaries:
      post.summary == null
        ? []
        : post.language == null
          ? [post.summary]
          : [post.summary, new LanguageString(post.summary, post.language)],
    contents:
      post.contentHtml == null
        ? []
        : post.language == null
          ? [post.contentHtml]
          : [
              post.contentHtml,
              new LanguageString(post.contentHtml, post.language),
            ],
    source:
      post.content == null
        ? null
        : new Source({
            content: post.content,
            mediaType: "text/markdown",
          }),
    sensitive: post.sensitive,
    tags: [
      ...post.mentions.map(
        (m) =>
          new vocab.Mention({
            href: new URL(m.account.iri),
            name: m.account.handle,
          }),
      ),
      ...Object.entries(post.tags).map(
        ([name, url]) =>
          new Hashtag({
            name,
            href: new URL(url),
          }),
      ),
      ...Object.entries(post.emojis).map(([shortcode, url]) =>
        toEmoji(ctx, { shortcode, url }),
      ),
      ...(post.quoteTarget == null
        ? []
        : [
            new Link({
              mediaType:
                'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
              href: new URL(post.quoteTarget.iri),
              name:
                post.quoteTarget.url != null &&
                post.content?.includes(post.quoteTarget.url)
                  ? post.quoteTarget.url
                  : post.quoteTarget.iri,
            }),
          ]),
    ],
    replyTarget:
      post.replyTarget == null ? null : new URL(post.replyTarget.iri),
    replies: new OrderedCollection({
      id: new URL("#replies", post.iri),
      totalItems: post.replies.length,
      items: post.replies.map((r) => new URL(r.iri)),
    }),
    shares:
      post.sharesCount == null
        ? null
        : new Collection({
            id: new URL("#shares", post.iri),
            totalItems: post.sharesCount,
          }),
    likes:
      post.likesCount == null
        ? null
        : new Collection({
            id: new URL("#likes", post.iri),
            totalItems: post.likesCount,
          }),
    attachments: post.media.map((medium) =>
      medium.type.startsWith("video/")
        ? new Video({
            mediaType: medium.type,
            url: new URL(medium.url),
            name: medium.description,
            summary: medium.description,
            width: medium.width,
            height: medium.height,
          })
        : new Image({
            mediaType: medium.type,
            url: new URL(medium.url),
            name: medium.description,
            summary: medium.description,
            width: medium.width,
            height: medium.height,
          }),
    ),
    quoteUrl: post.quoteTarget == null ? null : new URL(post.quoteTarget.iri),
    published: toTemporalInstant(post.published),
    url: post.url ? new URL(post.url) : null,
    updated: toTemporalInstant(
      post.published == null
        ? post.updated
        : +post.updated === +post.published
          ? null
          : post.updated,
    ),
    exclusiveOptions: post.poll == null || post.poll.multiple ? [] : options,
    inclusiveOptions: post.poll == null || !post.poll.multiple ? [] : options,
    voters: post.poll == null ? null : post.poll.votersCount,
    endTime: post.poll == null ? null : toTemporalInstant(post.poll.expires),
    closed:
      post.poll == null || post.poll.expires > new Date()
        ? null
        : toTemporalInstant(post.poll.expires),
  });
}

export function toCreate(
  post: Post & {
    account: Account & { owner: AccountOwner | null };
    replyTarget: Post | null;
    quoteTarget: Post | null;
    media: Medium[];
    poll: (Poll & { options: PollOption[] }) | null;
    mentions: (Mention & { account: Account })[];
    replies: Post[];
  },
  ctx: Context<unknown>,
): Create {
  const object = toObject(post, ctx);
  return new Create({
    id: new URL("#create", object.id!),
    actor: object.attributionId,
    tos: object.toIds,
    ccs: object.ccIds,
    object,
    published: object.published,
  });
}

export function toUpdate(
  post: Post & {
    account: Account & { owner: AccountOwner | null };
    replyTarget: Post | null;
    quoteTarget: Post | null;
    media: Medium[];
    poll: (Poll & { options: PollOption[] }) | null;
    mentions: (Mention & { account: Account })[];
    replies: Post[];
  },
  ctx: Context<unknown>,
  updated?: Date,
): Update {
  const object = toObject(post, ctx);
  return new Update({
    id: new URL(
      `#update-${(updated ?? object.updated)?.toString()}`,
      object.id!,
    ),
    actor: object.attributionId,
    tos: object.toIds,
    ccs: object.ccIds,
    object,
    published: object.updated,
  });
}

export function toDelete(
  post: Post & {
    account: Account & { owner: AccountOwner | null };
    replyTarget: Post | null;
    quoteTarget: Post | null;
    media: Medium[];
    poll: (Poll & { options: PollOption[] }) | null;
    mentions: (Mention & { account: Account })[];
    replies: Post[];
  },
  ctx: Context<unknown>,
  deleted: Date = new Date(),
) {
  const object = toObject(post, ctx);
  return new Delete({
    id: new URL(`#delete-${deleted.toString()}`, object.id!),
    actor: object.attributionId,
    tos: object.toIds,
    ccs: object.ccIds,
    object: new Tombstone({ id: object.id }),
  });
}

export function toAnnounce(
  post: Post & {
    account: Account;
    sharing: (Post & { account: Account }) | null;
  },
  ctx: Context<unknown>,
): Announce {
  if (post.sharing == null) throw new Error("The post is not shared");
  if (post.visibility === "direct") throw new Error("Disallowed sharing");
  const handle = post.account.handle.replaceAll(/(?:^@)|(?:@[^@]+$)/g, "");
  return new vocab.Announce({
    id: new URL("#activity", post.iri),
    actor: new URL(post.account.iri),
    object: new URL(post.sharing.iri),
    published: toTemporalInstant(post.published),
    to:
      post.visibility === "public"
        ? vocab.PUBLIC_COLLECTION
        : ctx.getFollowersUri(handle),
    ccs:
      post.visibility === "private"
        ? []
        : [
            post.visibility === "public"
              ? ctx.getFollowersUri(handle)
              : vocab.PUBLIC_COLLECTION,
            new URL(post.sharing.account.iri),
          ],
  });
}

export function getRecipients(
  post: Post & { mentions: (Mention & { account: Account })[] },
): Recipient[] {
  return post.mentions.map((m) => ({
    id: new URL(m.account.iri),
    inboxId: new URL(m.account.inboxUrl),
    // For direct messages, don't use shared inbox to ensure privacy
    endpoints:
      post.visibility === "direct"
        ? null
        : m.account.sharedInboxUrl == null
          ? null
          : { sharedInbox: new URL(m.account.sharedInboxUrl) },
  }));
}

// cSpell: ignore ssrfcheck
