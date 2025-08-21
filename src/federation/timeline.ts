import { Temporal } from "@js-temporal/polyfill";
import { getLogger } from "@logtape/logtape";
import {
  and,
  desc,
  type ExtractTablesWithRelations,
  eq,
  inArray,
  lt,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type {
  Account,
  AccountOwner,
  Block,
  Follow,
  List,
  ListMember,
  Mention,
  Mute,
  Post,
} from "../schema";
import * as schema from "../schema";
import type { Uuid } from "../uuid";

export const TIMELINE_INBOXES =
  // biome-ignore lint/complexity/useLiteralKeys: tsc rants about this (TS4111)
  process.env["TIMELINE_INBOXES"]?.trim()?.toLowerCase() === "true";

export const TIMELINE_INBOX_LIMIT = 1000;

const logger = getLogger(["hollo", "federation", "timeline"]);

export function isPostVisibleToAccount(
  post: Post & { mentions: Mention[] },
  account: Account & { following: Follow[]; blockedBy: Block[] },
): boolean {
  if (post.accountId === account.id) return true;
  for (const block of account.blockedBy) {
    if (block.accountId === post.accountId) return false;
  }
  if (post.visibility === "public" || post.visibility === "unlisted") {
    return true;
  }
  for (const mention of post.mentions) {
    if (mention.accountId === account.id) return true;
  }
  if (post.visibility === "private") {
    for (const follow of account.following) {
      if (follow.followingId === post.accountId) return true;
    }
  }
  return false;
}

export function shouldExcludePostFromTimeline(
  post: Post & {
    sharing: (Post & { mentions: Mention[] }) | null;
    mentions: Mention[];
    replyTarget: Post | null;
  },
  owner: AccountOwner & {
    account: Account & {
      following: Follow[];
      blocks: Block[];
      blockedBy: Block[];
      mutes: Mute[];
    };
  },
): boolean {
  if (
    !isPostVisibleToAccount(post, owner.account) ||
    (post.sharing != null &&
      !isPostVisibleToAccount(post.sharing, owner.account))
  ) {
    return true;
  }
  for (const block of owner.account.blocks) {
    if (
      block.accountId === post.accountId ||
      block.accountId === post.sharing?.accountId
    ) {
      return true;
    }
  }
  for (const mute of owner.account.mutes) {
    if (mute.duration != null) {
      const created = Temporal.Instant.from(mute.created.toISOString());
      const duration = Temporal.Duration.from(mute.duration);
      const expires = created.add(duration);
      if (Temporal.Now.instant().until(expires).total("nanoseconds") <= 0) {
        continue;
      }
    }
    if (
      mute.mutedAccountId === post.accountId ||
      mute.mutedAccountId === post.sharing?.accountId
    ) {
      return true;
    }
  }
  return false;
}

export function shouldIncludePostInTimeline(
  post: Post & {
    sharing: (Post & { mentions: Mention[] }) | null;
    mentions: Mention[];
    replyTarget: Post | null;
  },
  owner: AccountOwner & {
    account: Account & {
      following: Follow[];
      blocks: Block[];
      blockedBy: Block[];
      mutes: Mute[];
    };
  },
): boolean {
  if (post.accountId === owner.id) return true;
  if (shouldExcludePostFromTimeline(post, owner)) return false;
  for (const mention of post.mentions) {
    if (mention.accountId === owner.id) return true;
  }
  for (const mention of post.sharing?.mentions || []) {
    if (mention.accountId === owner.id) return true;
  }
  for (const follow of owner.account.following) {
    if (follow.followingId === post.accountId) {
      const replyTarget = post.replyTarget;
      return (
        replyTarget == null ||
        replyTarget.accountId === owner.id ||
        (owner.account.following.some(
          (f) => f.followingId === replyTarget.accountId,
        ) &&
          !owner.account.blocks.some(
            (b) => b.accountId === replyTarget.accountId,
          ) &&
          !owner.account.mutes.some(
            (m) => m.mutedAccountId === replyTarget.accountId,
          ))
      );
    }
  }
  if (owner.followedTags.length > 0) {
    const postTags = new Set(
      Object.keys(post.tags).map((t) =>
        t.replace(/^#/, "").toLowerCase().trim(),
      ),
    );
    const followedTags = new Set(
      owner.followedTags.map((t) => t.replace(/^#/, "").toLowerCase().trim()),
    );
    if (postTags.intersection(followedTags).size > 0) return true;
  }
  return false;
}

export function shouldIncludePostInList(
  post: Post & {
    sharing: (Post & { mentions: Mention[] }) | null;
    mentions: Mention[];
    replyTarget: Post | null;
  },
  list: List & {
    accountOwner: AccountOwner & {
      account: Account & {
        following: Follow[];
        blocks: Block[];
        blockedBy: Block[];
        mutes: Mute[];
      };
    };
    members: ListMember[];
  },
): boolean {
  if (shouldExcludePostFromTimeline(post, list.accountOwner)) return false;
  if (!list.members.some((m) => m.accountId === post.accountId)) return false;
  if (post.replyTarget != null) {
    const originalAuthorId = post.replyTarget.accountId;
    if (list.repliesPolicy === "followed") {
      return list.accountOwner.account.following.some(
        (f) => f.followingId === originalAuthorId,
      );
    }
    if (list.repliesPolicy === "list") {
      return list.members.some((m) => m.accountId === originalAuthorId);
    }
    return false;
  }
  return true;
}

export async function appendPostToTimelines(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  post: Post & {
    sharing: (Post & { mentions: Mention[] }) | null;
    mentions: Mention[];
    replyTarget: Post | null;
  },
): Promise<void> {
  const owners = await db.query.accountOwners.findMany({
    with: {
      account: {
        with: {
          following: true,
          blocks: true,
          blockedBy: true,
          mutes: true,
        },
      },
    },
  });
  const lists = await db.query.lists.findMany({
    with: {
      accountOwner: {
        with: {
          account: {
            with: {
              following: true,
              blocks: true,
              blockedBy: true,
              mutes: true,
            },
          },
        },
      },
      members: true,
    },
  });
  for (const owner of owners) {
    if (shouldIncludePostInTimeline(post, owner)) {
      await db
        .insert(schema.timelinePosts)
        .values({
          accountId: owner.id,
          postId: post.id,
        })
        .onConflictDoNothing();
    }
  }
  for (const list of lists) {
    if (shouldIncludePostInList(post, list)) {
      await db
        .insert(schema.listPosts)
        .values({
          listId: list.id,
          postId: post.id,
        })
        .onConflictDoNothing();
    }
  }
  logger.debug("Appended post {postId} to timelines.", { postId: post.id });
}

export async function pruneOldPostsFromTimelines(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
) {
  const owners = await db.query.accountOwners.findMany();
  for (const owner of owners) {
    await db
      .delete(schema.timelinePosts)
      .where(
        and(
          eq(schema.timelinePosts.accountId, owner.id),
          inArray(
            schema.timelinePosts.postId,
            db
              .select({ postId: schema.timelinePosts.postId })
              .from(schema.timelinePosts)
              .where(eq(schema.timelinePosts.accountId, owner.id))
              .orderBy(desc(schema.timelinePosts.postId))
              .offset(TIMELINE_INBOX_LIMIT),
          ),
        ),
      );
  }
  const lists = await db.query.lists.findMany();
  for (const list of lists) {
    await db
      .delete(schema.listPosts)
      .where(
        and(
          eq(schema.listPosts.listId, list.id),
          inArray(
            schema.listPosts.postId,
            db
              .select({ postId: schema.listPosts.postId })
              .from(schema.listPosts)
              .where(eq(schema.listPosts.listId, list.id))
              .orderBy(desc(schema.listPosts.postId))
              .offset(TIMELINE_INBOX_LIMIT),
          ),
        ),
      );
  }
}

export async function rebuildTimelines(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  window = TIMELINE_INBOX_LIMIT * 10,
): Promise<void> {
  const owners = await db.query.accountOwners.findMany({
    with: {
      account: {
        with: {
          following: true,
          blocks: true,
          blockedBy: true,
          mutes: true,
        },
      },
    },
  });
  const lists = await db.query.lists.findMany({
    with: {
      accountOwner: {
        with: {
          account: {
            with: {
              following: true,
              blocks: true,
              blockedBy: true,
              mutes: true,
            },
          },
        },
      },
      members: true,
    },
  });
  const timelineInboxes: Record<Uuid, Set<Uuid>> = Object.fromEntries(
    owners.map((o) => [o.id, new Set()]),
  );
  const listInboxes: Record<Uuid, Set<Uuid>> = Object.fromEntries(
    lists.map((l) => [l.id, new Set()]),
  );
  let lastPostId: Uuid | null = null;
  let posts: (Post & {
    sharing: (Post & { mentions: Mention[] }) | null;
    mentions: Mention[];
    replyTarget: Post | null;
  })[];
  do {
    if (lastPostId == null) {
      logger.debug("Fetching the first {window} posts...", {
        window,
        lastPostId,
      });
    } else {
      logger.debug("Fetching the next {window} posts before {lastPostId}...", {
        window,
        lastPostId,
      });
    }
    posts = await db.query.posts.findMany({
      where: lastPostId == null ? undefined : lt(schema.posts.id, lastPostId),
      with: {
        sharing: {
          with: { mentions: true },
        },
        mentions: true,
        replyTarget: true,
      },
      orderBy: desc(schema.posts.id),
      limit: window,
    });
    for (const post of posts) {
      for (const owner of owners) {
        if (shouldIncludePostInTimeline(post, owner)) {
          const set = timelineInboxes[owner.id];
          if (set.size < TIMELINE_INBOX_LIMIT) set.add(post.id);
        }
      }
      for (const list of lists) {
        if (shouldIncludePostInList(post, list)) {
          const set = listInboxes[list.id];
          if (set.size < TIMELINE_INBOX_LIMIT) set.add(post.id);
        }
      }
      lastPostId = post.id;
    }
    if (
      Object.values(timelineInboxes).every(
        (inbox) => inbox.size >= TIMELINE_INBOX_LIMIT,
      ) &&
      Object.values(listInboxes).every(
        (inbox) => inbox.size >= TIMELINE_INBOX_LIMIT,
      )
    ) {
      break;
    }
  } while (posts.length > 0);
  await db.delete(schema.timelinePosts);
  for (const ownerId in timelineInboxes) {
    const inbox = timelineInboxes[ownerId as Uuid];
    if (inbox.size < 1) continue;
    await db.insert(schema.timelinePosts).values(
      [...inbox].map((postId) => ({
        accountId: ownerId as Uuid,
        postId,
      })),
    );
  }
  await db.delete(schema.listPosts);
  for (const listId in listInboxes) {
    const inbox = listInboxes[listId as Uuid];
    if (inbox.size < 1) continue;
    await db.insert(schema.listPosts).values(
      [...inbox].map((postId) => ({
        listId: listId as Uuid,
        postId,
      })),
    );
  }
  logger.debug(
    "Rebuit inboxes for {accounts} accounts and {lists} lists: {inboxes}",
    {
      accounts: owners.length,
      lists: lists.length,
      inboxes: { ...timelineInboxes, ...listInboxes },
    },
  );
}
