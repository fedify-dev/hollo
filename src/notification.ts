import { getLogger } from "@logtape/logtape";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import type { Account, AccountOwner, Poll, Post } from "./schema";
import {
  type NotificationType,
  notificationGroups,
  notifications,
  posts,
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
 * If a duplicate notification already exists (same owner, type, actor, and target),
 * returns the existing notification ID without creating a new one.
 */
export async function createNotification(
  context: NotificationContext,
): Promise<Uuid> {
  const groupKey = generateGroupKey(context);
  const notificationId = uuidv7();
  const now = new Date();

  return await db.transaction(async (tx) => {
    // Check for existing duplicate notification to prevent duplicates from
    // federation activities that may be processed multiple times
    const existingNotification = await tx.query.notifications.findFirst({
      where: and(
        eq(notifications.accountOwnerId, context.accountOwnerId),
        eq(notifications.type, context.type),
        context.actorAccountId != null
          ? eq(notifications.actorAccountId, context.actorAccountId)
          : sql`${notifications.actorAccountId} IS NULL`,
        context.targetPostId != null
          ? eq(notifications.targetPostId, context.targetPostId)
          : sql`${notifications.targetPostId} IS NULL`,
        context.targetAccountId != null
          ? eq(notifications.targetAccountId, context.targetAccountId)
          : sql`${notifications.targetAccountId} IS NULL`,
      ),
    });

    if (existingNotification != null) {
      logger.debug(
        "Duplicate notification detected, returning existing {id} for {type}",
        {
          id: existingNotification.id,
          type: context.type,
        },
      );
      return existingNotification.id;
    }

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
 * Creates a status notification when someone posts a reply to a user's post.
 * This is different from mention - it specifically means "someone replied to your post".
 */
export async function createStatusNotification(
  replier: Account,
  replyPost: Post,
  originalPost: Post & { account: Account & { owner: AccountOwner | null } },
): Promise<Uuid | null> {
  if (originalPost.account.owner == null) {
    // Original post author is not a local user, no notification needed
    return null;
  }

  // Don't notify if the replier is the same as the original author
  if (replier.id === originalPost.account.id) {
    return null;
  }

  return await createNotification({
    accountOwnerId: originalPost.account.owner.id,
    type: "status",
    actorAccountId: replier.id,
    targetPostId: replyPost.id,
  });
}

/**
 * Creates mention notifications for all mentioned local users in a post.
 * @param post The post containing the mentions
 * @param mentionedAccounts Array of mentioned accounts with owner info
 * @param replyTargetAuthorId If this post is a reply, the account ID of the
 *   original post author. Mention notifications for this account will be
 *   skipped to avoid duplicate notifications (reply + mention for the same post).
 */
export async function createMentionNotifications(
  post: Post,
  mentionedAccounts: Array<Account & { owner: AccountOwner | null }>,
  replyTargetAuthorId?: Uuid | null,
): Promise<Uuid[]> {
  const notificationIds: Uuid[] = [];

  for (const mentioned of mentionedAccounts) {
    if (mentioned.owner == null) {
      // Mentioned account is not a local user, no notification needed
      continue;
    }

    // Skip mention notification for the reply target author to avoid duplicates.
    // When someone replies to a post and mentions the original author,
    // they will receive a "status" notification for the reply, so we don't
    // need to send a separate "mention" notification for the same post.
    if (replyTargetAuthorId != null && mentioned.id === replyTargetAuthorId) {
      logger.debug(
        "Skipping mention notification for reply target author {accountId} on post {postId}",
        {
          accountId: mentioned.id,
          postId: post.id,
        },
      );
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

/**
 * Creates a quote notification when someone quotes a post.
 * @param quoter The account that created the quote post
 * @param quotePost The new post that quotes the original
 * @param originalPost The original post being quoted
 */
export async function createQuoteNotification(
  quoter: Account,
  quotePost: Post,
  originalPost: Post & { account: Account & { owner: AccountOwner | null } },
): Promise<Uuid | null> {
  if (originalPost.account.owner == null) {
    // Original post author is not a local user, no notification needed
    return null;
  }

  // Don't notify if the quoter is the same as the original author (self-quote)
  if (quoter.id === originalPost.account.id) {
    return null;
  }

  return await createNotification({
    accountOwnerId: originalPost.account.owner.id,
    type: "quote",
    actorAccountId: quoter.id,
    targetPostId: quotePost.id, // The quote post, not the original
  });
}

/**
 * Creates quoted_update notifications when a quoted post is edited.
 * Notifies all local users who quoted the post.
 * @param editedPost The post that was edited
 * @param quoteAuthors Array of accounts that quoted this post
 */
export async function createQuotedUpdateNotifications(
  editedPost: Post,
  quoteAuthors: Array<Account & { owner: AccountOwner | null }>,
): Promise<Uuid[]> {
  const notificationIds: Uuid[] = [];

  for (const author of quoteAuthors) {
    if (author.owner == null) {
      // Quote author is not a local user, no notification needed
      continue;
    }

    // Find this user's quote post
    const quotePost = await db.query.posts.findFirst({
      where: and(
        eq(posts.accountId, author.id),
        eq(posts.quoteTargetId, editedPost.id),
      ),
    });

    if (quotePost == null) {
      logger.debug(
        "Quote post not found for author {accountId} quoting {postId}",
        {
          accountId: author.id,
          postId: editedPost.id,
        },
      );
      continue;
    }

    const notificationId = await createNotification({
      accountOwnerId: author.owner.id,
      type: "quoted_update",
      actorAccountId: editedPost.accountId,
      targetPostId: quotePost.id, // The user's quote post, not the edited original
    });

    notificationIds.push(notificationId);
  }

  return notificationIds;
}
