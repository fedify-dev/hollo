import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";

import { db, postgres, type DatabaseLike } from "../db";
import { blocks, follows, mentions, mutes, posts } from "../schema";
import type { Uuid } from "../uuid";

// postgres-js needs the array type OID here; 2951 is uuid[].
const UUID_ARRAY_OID = 2951;

export type PostVisibilityScope = {
  viewerAccountId: Uuid | null;
  followingAccountIds: Uuid[];
};

export async function getApprovedFollowingAccountIds(
  accountId: Uuid,
  database: DatabaseLike = db,
): Promise<Uuid[]> {
  const rows = await database
    .select({ id: follows.followingId })
    .from(follows)
    .where(and(eq(follows.followerId, accountId), isNotNull(follows.approved)));

  return rows.map((row) => row.id);
}

export function postAccountIdInArray(accountIds: Uuid[], table = posts) {
  return sql`${table.accountId} = ANY(${postgres.array(accountIds, UUID_ARRAY_OID)})`;
}

export async function getPostVisibilityScope(
  viewerAccountId: Uuid | null | undefined,
): Promise<PostVisibilityScope> {
  if (viewerAccountId == null) {
    return { viewerAccountId: null, followingAccountIds: [] };
  }

  return {
    viewerAccountId,
    followingAccountIds: await getApprovedFollowingAccountIds(viewerAccountId),
  };
}

export function buildPostVisibilityConditions(
  scope: PostVisibilityScope,
  table = posts,
) {
  const { viewerAccountId } = scope;

  if (viewerAccountId == null) {
    return inArray(table.visibility, ["public", "unlisted"]);
  }

  const privateAccountIds = [
    ...new Set([viewerAccountId, ...scope.followingAccountIds]),
  ];
  const recipientCondition = or(
    eq(table.accountId, viewerAccountId),
    exists(
      db
        .select({ postId: mentions.postId })
        .from(mentions)
        .where(
          and(
            eq(mentions.postId, table.id),
            eq(mentions.accountId, viewerAccountId),
          ),
        ),
    ),
  );

  return or(
    inArray(table.visibility, ["public", "unlisted"]),
    and(
      eq(table.visibility, "private"),
      or(postAccountIdInArray(privateAccountIds, table), recipientCondition),
    ),
    and(eq(table.visibility, "direct"), recipientCondition),
  );
}

/**
 * Returns a subquery selecting the account IDs that the given owner has
 * blocked.
 */
export function getBlockedAccountIdsSubquery(ownerId: Uuid) {
  return db
    .select({ accountId: blocks.blockedAccountId })
    .from(blocks)
    .where(eq(blocks.accountId, ownerId));
}

/**
 * Returns a subquery selecting the account IDs that the given owner has muted
 * (and whose mute has not expired).  When `notificationsOnly` is true, only
 * mutes that also hide notifications are included.
 */
export function getMutedAccountIdsSubquery(
  ownerId: Uuid,
  notificationsOnly = false,
) {
  return db
    .select({ accountId: mutes.mutedAccountId })
    .from(mutes)
    .where(
      and(
        eq(mutes.accountId, ownerId),
        notificationsOnly ? eq(mutes.notifications, true) : undefined,
        or(
          isNull(mutes.duration),
          gt(sql`${mutes.created} + ${mutes.duration}`, sql`CURRENT_TIMESTAMP`),
        ),
      ),
    );
}

/**
 * Returns the set of account IDs whose notifications should be hidden from the
 * given owner: accounts the owner has blocked, plus accounts the owner has
 * muted with notifications hidden.
 */
export async function getHiddenNotificationAccountIds(
  ownerId: Uuid,
): Promise<Set<Uuid>> {
  const [blocked, muted] = await Promise.all([
    getBlockedAccountIdsSubquery(ownerId),
    getMutedAccountIdsSubquery(ownerId, true),
  ]);
  return new Set([...blocked, ...muted].map(({ accountId }) => accountId));
}
