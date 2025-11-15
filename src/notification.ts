import { getLogger } from "@logtape/logtape";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import type { Account, AccountOwner, Poll, Post } from "./schema";
import {
  type NotificationType,
  notificationGroups,
  notifications,
} from "./schema";
import type { Uuid } from "./uuid";
import { uuidv7 } from "./uuid";

const logger = getLogger(["hollo", "notification"]);

export interface NotificationContext {
  accountOwnerId: Uuid;
  type: NotificationType;
  actorAccountId?: Uuid;
  targetPostId?: Uuid;
  targetAccountId?: Uuid;
  targetPollId?: Uuid;
}

/**
 * Generates a group key for notification grouping based on Mastodon's logic.
 * Notifications of type favourite, follow, reblog, or admin.sign_up with the same
 * type and target (post or account) created within a similar timeframe share a group_key.
 */
export function generateGroupKey(context: NotificationContext): string {
  const { type, targetPostId, targetAccountId, accountOwnerId } = context;

  // Types that support grouping according to Mastodon spec
  const groupableTypes: NotificationType[] = [
    "favourite",
    "follow",
    "reblog",
    "admin.sign_up",
    "emoji_reaction", // Hollo extension
  ];

  if (!groupableTypes.includes(type)) {
    // For non-groupable types, each notification gets a unique group key
    return `ungrouped:${uuidv7()}`;
  }

  // Group key format: {owner_id}:{type}:{target}
  // This ensures notifications of the same type affecting the same target are grouped
  const target = targetPostId ?? targetAccountId ?? "no-target";
  return `${accountOwnerId}:${type}:${target}`;
}

/**
 * Creates a notification and updates the corresponding notification group.
 * This function handles both notification creation and group aggregation in a transaction.
 */
export async function createNotification(
  context: NotificationContext,
): Promise<Uuid> {
  const groupKey = generateGroupKey(context);
  const notificationId = uuidv7();
  const now = new Date();

  return await db.transaction(async (tx) => {
    // Insert the notification
    await tx.insert(notifications).values({
      id: notificationId,
      accountOwnerId: context.accountOwnerId,
      type: context.type,
      actorAccountId: context.actorAccountId,
      targetPostId: context.targetPostId,
      targetAccountId: context.targetAccountId,
      targetPollId: context.targetPollId,
      groupKey,
      created: now,
      readAt: null,
    });

    // Update or create notification group
    const existingGroup = await tx.query.notificationGroups.findFirst({
      where: eq(notificationGroups.groupKey, groupKey),
    });

    if (existingGroup) {
      // Update existing group
      const sampleAccountIds = context.actorAccountId
        ? Array.from(
            new Set([
              context.actorAccountId,
              ...existingGroup.sampleAccountIds,
            ]),
          ).slice(0, 10) // Keep max 10 sample accounts
        : existingGroup.sampleAccountIds;

      await tx
        .update(notificationGroups)
        .set({
          notificationsCount: sql`${notificationGroups.notificationsCount} + 1`,
          mostRecentNotificationId: notificationId,
          sampleAccountIds,
          latestPageNotificationAt: now,
          pageMaxId: notificationId,
          updated: now,
        })
        .where(eq(notificationGroups.groupKey, groupKey));
    } else {
      // Create new group
      await tx.insert(notificationGroups).values({
        groupKey,
        accountOwnerId: context.accountOwnerId,
        type: context.type,
        targetPostId: context.targetPostId,
        notificationsCount: 1,
        mostRecentNotificationId: notificationId,
        sampleAccountIds: context.actorAccountId
          ? [context.actorAccountId]
          : [],
        latestPageNotificationAt: now,
        pageMinId: notificationId,
        pageMaxId: notificationId,
        created: now,
        updated: now,
      });
    }

    logger.info(
      `Created ${context.type} notification {id} for owner {ownerId} in group {groupKey}`,
      {
        id: notificationId,
        ownerId: context.accountOwnerId,
        groupKey,
      },
    );

    return notificationId;
  });
}

/**
 * Creates a follow notification when someone follows a user.
 */
export async function createFollowNotification(
  follower: Account,
  following: AccountOwner,
): Promise<Uuid> {
  return await createNotification({
    accountOwnerId: following.id,
    type: "follow",
    actorAccountId: follower.id,
    targetAccountId: following.id,
  });
}

/**
 * Creates a follow request notification for protected accounts.
 */
export async function createFollowRequestNotification(
  follower: Account,
  following: AccountOwner,
): Promise<Uuid> {
  return await createNotification({
    accountOwnerId: following.id,
    type: "follow_request",
    actorAccountId: follower.id,
    targetAccountId: following.id,
  });
}

/**
 * Creates a favourite (like) notification when someone likes a post.
 */
export async function createFavouriteNotification(
  liker: Account,
  post: Post & { account: Account & { owner: AccountOwner | null } },
): Promise<Uuid | null> {
  if (post.account.owner == null) {
    // Post author is not a local user, no notification needed
    return null;
  }

  return await createNotification({
    accountOwnerId: post.account.owner.id,
    type: "favourite",
    actorAccountId: liker.id,
    targetPostId: post.id,
  });
}

/**
 * Creates an emoji reaction notification when someone reacts to a post.
 */
export async function createEmojiReactionNotification(
  reactor: Account,
  post: Post & { account: Account & { owner: AccountOwner | null } },
): Promise<Uuid | null> {
  if (post.account.owner == null) {
    // Post author is not a local user, no notification needed
    return null;
  }

  return await createNotification({
    accountOwnerId: post.account.owner.id,
    type: "emoji_reaction",
    actorAccountId: reactor.id,
    targetPostId: post.id,
  });
}

/**
 * Creates a reblog (share) notification when someone shares a post.
 */
export async function createReblogNotification(
  sharer: Account,
  originalPost: Post & { account: Account & { owner: AccountOwner | null } },
): Promise<Uuid | null> {
  if (originalPost.account.owner == null) {
    // Post author is not a local user, no notification needed
    return null;
  }

  return await createNotification({
    accountOwnerId: originalPost.account.owner.id,
    type: "reblog",
    actorAccountId: sharer.id,
    targetPostId: originalPost.id,
  });
}

/**
 * Creates mention notifications for all mentioned local users in a post.
 */
export async function createMentionNotifications(
  post: Post,
  mentionedAccounts: Array<Account & { owner: AccountOwner | null }>,
): Promise<Uuid[]> {
  const notificationIds: Uuid[] = [];

  for (const mentioned of mentionedAccounts) {
    if (mentioned.owner == null) {
      // Mentioned account is not a local user, no notification needed
      continue;
    }

    const notificationId = await createNotification({
      accountOwnerId: mentioned.owner.id,
      type: "mention",
      actorAccountId: post.accountId,
      targetPostId: post.id,
    });

    notificationIds.push(notificationId);
  }

  return notificationIds;
}

/**
 * Creates poll expiry notification for the poll author and participants.
 */
export async function createPollNotifications(
  poll: Poll,
  post: Post & { account: Account & { owner: AccountOwner | null } },
  participantOwnerIds: Uuid[],
): Promise<Uuid[]> {
  const notificationIds: Uuid[] = [];

  // Create notification for poll author if they're a local user
  if (post.account.owner != null) {
    const authorNotificationId = await createNotification({
      accountOwnerId: post.account.owner.id,
      type: "poll",
      targetPostId: post.id,
      targetPollId: poll.id,
    });
    notificationIds.push(authorNotificationId);
  }

  // Create notifications for participants (local users who voted)
  for (const participantOwnerId of participantOwnerIds) {
    // Don't notify the author twice
    if (
      post.account.owner != null &&
      participantOwnerId === post.account.owner.id
    ) {
      continue;
    }

    const participantNotificationId = await createNotification({
      accountOwnerId: participantOwnerId,
      type: "poll",
      targetPostId: post.id,
      targetPollId: poll.id,
    });
    notificationIds.push(participantNotificationId);
  }

  return notificationIds;
}

/**
 * Marks notifications as read.
 */
export async function markNotificationsAsRead(
  accountOwnerId: Uuid,
  notificationIds: Uuid[],
): Promise<void> {
  if (notificationIds.length === 0) return;

  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.accountOwnerId, accountOwnerId),
        inArray(notifications.id, notificationIds),
      ),
    );

  logger.info(`Marked {count} notifications as read for owner {ownerId}`, {
    count: notificationIds.length,
    ownerId: accountOwnerId,
  });
}

/**
 * Marks all notifications in a group as read.
 */
export async function markGroupAsRead(
  accountOwnerId: Uuid,
  groupKey: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.accountOwnerId, accountOwnerId),
        eq(notifications.groupKey, groupKey),
      ),
    );

  logger.info(
    `Marked notification group {groupKey} as read for owner {ownerId}`,
    {
      groupKey,
      ownerId: accountOwnerId,
    },
  );
}

/**
 * Deletes notifications by IDs.
 */
export async function deleteNotifications(
  accountOwnerId: Uuid,
  notificationIds: Uuid[],
): Promise<void> {
  if (notificationIds.length === 0) return;

  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.accountOwnerId, accountOwnerId),
        inArray(notifications.id, notificationIds),
      ),
    );

  logger.info(`Deleted {count} notifications for owner {ownerId}`, {
    count: notificationIds.length,
    ownerId: accountOwnerId,
  });
}

/**
 * Deletes all notifications in a group.
 */
export async function deleteGroup(
  accountOwnerId: Uuid,
  groupKey: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Delete all notifications in the group
    await tx
      .delete(notifications)
      .where(
        and(
          eq(notifications.accountOwnerId, accountOwnerId),
          eq(notifications.groupKey, groupKey),
        ),
      );

    // Delete the group metadata
    await tx
      .delete(notificationGroups)
      .where(eq(notificationGroups.groupKey, groupKey));

    logger.info(`Deleted notification group {groupKey} for owner {ownerId}`, {
      groupKey,
      ownerId: accountOwnerId,
    });
  });
}

/**
 * Deletes all notifications for a user.
 */
export async function deleteAllNotifications(
  accountOwnerId: Uuid,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Delete all notifications
    await tx
      .delete(notifications)
      .where(eq(notifications.accountOwnerId, accountOwnerId));

    // Delete all notification groups
    await tx
      .delete(notificationGroups)
      .where(eq(notificationGroups.accountOwnerId, accountOwnerId));

    logger.info(`Deleted all notifications for owner {ownerId}`, {
      ownerId: accountOwnerId,
    });
  });
}
