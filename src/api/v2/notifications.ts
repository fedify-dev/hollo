import { getLogger } from "@logtape/logtape";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../../db";
import { postgresQueryCancellationMiddleware } from "../../db-cancel";
import {
  serializeAccount,
  serializeAccountOwner,
} from "../../entities/account";
import { getPostRelations, serializePost } from "../../entities/status";
import {
  scopeRequired,
  tokenRequired,
  withAccountOwner,
  type AccountOwnerVariables,
} from "../../oauth/middleware";
import {
  notificationGroups,
  notifications,
  notificationTypeEnum,
  type NotificationType,
} from "../../schema";
import type { Uuid } from "../../uuid";
import {
  getBlockedAccountIdsSubquery,
  getHiddenNotificationAccountIds,
  getMutedAccountIdsSubquery,
} from "../visibility";

const logger = getLogger(["hollo", "api", "v2", "notifications"]);

const app = new Hono<{ Variables: AccountOwnerVariables }>();
const cancelReadOnlyQueries = postgresQueryCancellationMiddleware();

// Format notification ID to match v1 API format for consistency
// This ensures markers work correctly across v1 and v2 APIs
function formatNotificationId(created: Date, type: string, id: string): string {
  return `${created.toISOString()}/${type}/${id}`;
}

// set for O(1) access to all possible types
const notificationTypeSet = new Set(notificationTypeEnum.enumValues);
function isNotificationType(value: string): value is NotificationType {
  return notificationTypeSet.has(value as NotificationType);
}

// GET /api/v2/notifications - Get grouped notifications
app.get(
  "/",
  cancelReadOnlyQueries,
  tokenRequired,
  scopeRequired(["read:notifications"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");

    // Parse query parameters
    let types = c.req.queries("types[]") as NotificationType[];
    const excludeTypes = c.req.queries("exclude_types[]") as NotificationType[];
    const maxId = c.req.query("max_id");
    const sinceId = c.req.query("since_id");
    const minId = c.req.query("min_id");
    const limit = Math.min(
      Number.parseInt(c.req.query("limit") ?? "40", 10),
      80, // Maximum 80 groups as per Mastodon spec
    );
    // const expandAccounts = c.req.query("expand_accounts") ?? "full";
    // TODO: Implement partial_avatars mode for expandAccounts

    // Default to all types if none specified
    if (types == null || types.length < 1) {
      types = [
        "mention",
        "status",
        "reblog",
        "follow",
        "follow_request",
        "favourite",
        "emoji_reaction",
        "poll",
        "update",
        "admin.sign_up",
        "admin.report",
        "quote",
        "quoted_update",
      ];
    }
    // types contains client-supplied values, which are not necessarily valid NotificationType. Filter everything we don't know and prevent problems later
    // excludeTypes doesn't need filtering because we won't pass it along
    types = types.filter(isNotificationType);
    types = types.filter((t) => !excludeTypes?.includes(t));

    const startTime = performance.now();

    // Accounts whose notifications should be hidden (blocked, or muted with
    // notifications hidden).
    const hiddenAccountIds = await getHiddenNotificationAccountIds(owner.id);

    const paginationConditions = [];

    // Pagination conditions
    if (maxId != null) {
      paginationConditions.push({ pageMaxId: { lt: maxId as Uuid } });
    }
    if (sinceId != null) {
      paginationConditions.push({ pageMaxId: { gt: sinceId as Uuid } });
    }
    if (minId != null) {
      paginationConditions.push({ pageMaxId: { gt: minId as Uuid } });
    }

    const groups = await db.query.notificationGroups.findMany({
      where: {
        accountOwnerId: { eq: owner.id },
        type: { in: types },
        ...(paginationConditions.length > 0
          ? { AND: paginationConditions }
          : {}),
      },
      // Use COALESCE to handle NULL latestPageNotificationAt values
      // (e.g., from older migrations that didn't set this field)
      orderBy: (notificationGroups, { desc, sql }) => [
        desc(
          sql`COALESCE(${notificationGroups.latestPageNotificationAt}, ${notificationGroups.created})`,
        ),
      ],
      limit,
    });

    const afterGroupQuery = performance.now();
    logger.info(
      "Notification groups query took {ms}ms, returned {count} groups",
      {
        ms: Math.round(afterGroupQuery - startTime),
        count: groups.length,
      },
    );

    // Determine each group's visibility and its visible sample actors.
    // Fast path: when nothing is hidden, every group and its cached sample
    // are already correct and no extra queries are needed.  Slow path: when
    // some accounts are hidden, filter the cached sample and, for groups
    // whose sample is fully hidden, look up their notifications (excluding
    // hidden actors) to find any remaining visible actor — the cached sample
    // is capped at ten, so it is not exhaustive.
    const visibleGroups: (typeof groups)[number][] = [];
    const visibleSampleAccountIds = new Map<string, Uuid[]>();
    let visibleCounts: Map<string, number> | null = null;

    if (hiddenAccountIds.size < 1) {
      for (const group of groups) {
        visibleGroups.push(group);
        visibleSampleAccountIds.set(group.groupKey, group.sampleAccountIds);
      }
    } else {
      const needsLookup: string[] = [];
      for (const group of groups) {
        if (group.type === "poll") {
          // Poll notifications have no actor; visibility is resolved against
          // the poll's post author once posts are fetched below.
          visibleGroups.push(group);
          visibleSampleAccountIds.set(group.groupKey, group.sampleAccountIds);
          continue;
        }
        const filteredSample = group.sampleAccountIds.filter(
          (id) => !hiddenAccountIds.has(id),
        );
        if (filteredSample.length > 0) {
          visibleGroups.push(group);
          visibleSampleAccountIds.set(group.groupKey, filteredSample);
        } else {
          needsLookup.push(group.groupKey);
        }
      }

      if (needsLookup.length > 0) {
        // Query per group with its own limit so a single large group cannot
        // starve the others out of the shared row budget.
        const perGroup = await Promise.all(
          needsLookup.map((groupKey) =>
            db.query.notifications.findMany({
              where: {
                groupKey: { eq: groupKey },
                actorAccountId: { notIn: [...hiddenAccountIds] },
              },
              orderBy: (notifications, { desc }) => [
                desc(notifications.created),
              ],
              limit: 10,
            }),
          ),
        );
        for (let i = 0; i < needsLookup.length; i++) {
          const notifications2 = perGroup[i];
          const visibleActorIds: Uuid[] = [];
          for (const notification of notifications2) {
            if (notification.actorAccountId == null) continue;
            if (!visibleActorIds.includes(notification.actorAccountId)) {
              visibleActorIds.push(notification.actorAccountId);
            }
          }
          if (visibleActorIds.length < 1) continue;
          const group = groups.find((g) => g.groupKey === needsLookup[i]);
          if (group == null) continue;
          visibleGroups.push(group);
          visibleSampleAccountIds.set(group.groupKey, visibleActorIds);
        }
      }

      // Recompute per-group counts so hidden actors are not leaked through
      // `notifications_count`.  Poll groups keep their stored count.
      const groupKeys = groups.map((g) => g.groupKey);
      const countRows =
        groupKeys.length > 0
          ? await db
              .select({
                groupKey: notifications.groupKey,
                count: sql<number>`COUNT(*)::integer`,
              })
              .from(notifications)
              .where(
                and(
                  inArray(notifications.groupKey, groupKeys),
                  or(
                    sql`${notifications.actorAccountId} IS NULL`,
                    and(
                      sql`${notifications.actorAccountId} NOT IN (${getBlockedAccountIdsSubquery(owner.id)})`,
                      sql`${notifications.actorAccountId} NOT IN (${getMutedAccountIdsSubquery(owner.id, true)})`,
                    ),
                  ),
                ),
              )
              .groupBy(notifications.groupKey)
          : [];
      visibleCounts = new Map(
        countRows.map((r) => [r.groupKey, r.count] as const),
      );
    }

    // Collect all account IDs, post IDs, and notification IDs to fetch
    const accountIds = new Set<string>();
    const postIds = new Set<string>();
    const notificationIds = new Set<string>();

    for (const group of visibleGroups) {
      for (const accountId of visibleSampleAccountIds.get(group.groupKey) ??
        []) {
        accountIds.add(accountId);
      }
      if (group.targetPostId != null) {
        postIds.add(group.targetPostId);
      }
      if (group.mostRecentNotificationId != null) {
        notificationIds.add(group.mostRecentNotificationId);
      }
    }

    // Fetch all accounts, posts, and notifications in batch
    const [accountsData, postsData, notificationsData] = await Promise.all([
      accountIds.size > 0
        ? db.query.accounts.findMany({
            where: { id: { in: Array.from(accountIds) as Uuid[] } },
            with: { owner: true, successor: true },
          })
        : [],
      postIds.size > 0
        ? db.query.posts.findMany({
            where: { id: { in: Array.from(postIds) as Uuid[] } },
            with: getPostRelations(owner.id),
          })
        : [],
      notificationIds.size > 0
        ? db.query.notifications.findMany({
            where: { id: { in: Array.from(notificationIds) as Uuid[] } },
          })
        : [],
    ]);

    const afterDataQuery = performance.now();
    logger.info(
      "Fetched {accountCount} accounts and {postCount} posts in {ms}ms",
      {
        accountCount: accountsData.length,
        postCount: postsData.length,
        ms: Math.round(afterDataQuery - afterGroupQuery),
      },
    );

    // Create lookup maps
    const accountsMap = new Map(accountsData.map((a) => [a.id, a]));
    const postsMap = new Map(postsData.map((p) => [p.id, p]));
    const notificationsMap = new Map(notificationsData.map((n) => [n.id, n]));

    // Serialize accounts for deduplication
    const serializedAccounts = accountsData.map((account) =>
      account.owner == null
        ? serializeAccount(account, c.req.url)
        : serializeAccountOwner(
            {
              ...account.owner,
              account,
            },
            c.req.url,
          ),
    );

    // Drop poll groups whose post author is hidden.  Poll notifications carry
    // no actor, so their displayed account is the post author, and they must
    // not remain visible when that author is blocked or notification-muted.
    const finalVisibleGroups = visibleGroups.filter((group) => {
      if (group.type !== "poll") return true;
      const post = group.targetPostId ? postsMap.get(group.targetPostId) : null;
      return post == null || !hiddenAccountIds.has(post.accountId);
    });

    // Serialize statuses for deduplication, restricted to posts referenced by
    // a surviving (visible) group so hidden poll authors' posts are not leaked.
    const visibleTargetPostIds = new Set(
      finalVisibleGroups.flatMap((g) =>
        g.targetPostId != null ? [g.targetPostId] : [],
      ),
    );
    const serializedStatuses = postsData
      .filter((post) => visibleTargetPostIds.has(post.id))
      .map((post) => serializePost(post, owner, c.req.url));

    // Serialize notification groups
    const notificationGroupsData = finalVisibleGroups.map((group) => {
      const targetPost = group.targetPostId
        ? postsMap.get(group.targetPostId)
        : null;

      // Get the visible sample account IDs, keeping those that resolve
      // against fetched accounts.
      const sampleAccountIds = (
        visibleSampleAccountIds.get(group.groupKey) ?? group.sampleAccountIds
      ).filter((id) => accountsMap.has(id));

      const notificationId = group.mostRecentNotificationId;
      // Use the actual notification's created time for the composite ID
      // This ensures consistency with v1 API's notification ID format
      const mostRecentNotification = notificationId
        ? notificationsMap.get(notificationId)
        : null;
      const notificationCreatedAt =
        mostRecentNotification?.created ??
        group.latestPageNotificationAt ??
        group.created;
      const latestAt = group.latestPageNotificationAt ?? group.created;

      return {
        group_key: group.groupKey,
        notifications_count:
          visibleCounts?.get(group.groupKey) ?? group.notificationsCount,
        type: group.type,
        most_recent_notification_id:
          notificationId != null
            ? formatNotificationId(
                notificationCreatedAt,
                group.type,
                notificationId,
              )
            : null,
        page_min_id: group.pageMinId ?? group.mostRecentNotificationId,
        page_max_id: group.pageMaxId ?? group.mostRecentNotificationId,
        latest_page_notification_at: latestAt.toISOString(),
        sample_account_ids: sampleAccountIds,
        status_id: targetPost?.id ?? null,
      };
    });

    const afterSerialization = performance.now();
    logger.info("Serialization took {ms}ms", {
      ms: Math.round(afterSerialization - afterDataQuery),
    });

    // Build pagination links.  These are based on the *unfiltered* `groups`
    // so that filtering hidden groups out of the response does not break
    // pagination: a page whose visible groups are fewer than `limit` must
    // still expose `rel="next"` when more (possibly hidden) groups follow.
    let nextLink: URL | null = null;
    let prevLink: URL | null = null;

    if (groups.length >= limit && groups.length > 0) {
      const oldest = groups[groups.length - 1];
      const maxPageId = oldest.pageMaxId ?? oldest.mostRecentNotificationId;
      if (maxPageId != null) {
        nextLink = new URL(c.req.url);
        nextLink.searchParams.set("max_id", maxPageId);
      }
    }

    if (groups.length > 0) {
      const newest = groups[0];
      const minPageId = newest.pageMaxId ?? newest.mostRecentNotificationId;
      if (minPageId != null) {
        prevLink = new URL(c.req.url);
        prevLink.searchParams.set("min_id", minPageId);
      }
    }

    const response = {
      accounts: serializedAccounts,
      statuses: serializedStatuses,
      notification_groups: notificationGroupsData,
    };

    const headers: Record<string, string> = {};
    const linkParts: string[] = [];
    if (nextLink != null) {
      linkParts.push(`<${nextLink.href}>; rel="next"`);
    }
    if (prevLink != null) {
      linkParts.push(`<${prevLink.href}>; rel="prev"`);
    }
    if (linkParts.length > 0) {
      headers.Link = linkParts.join(", ");
    }

    return c.json(response, { headers });
  },
);

// GET /api/v2/notifications/unread_count - Get unread notification count
// This MUST be defined before /:group_key to avoid route conflicts
app.get(
  "/unread_count",
  cancelReadOnlyQueries,
  tokenRequired,
  scopeRequired(["read:notifications"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");

    const limit = Math.min(
      Number.parseInt(c.req.query("limit") ?? "100", 10),
      1000,
    );

    // Count unread notifications (notifications without readAt), excluding
    // notifications from hidden accounts (blocked, or muted with notifications
    // hidden).
    const result = await db
      .select({
        count: sql<number>`CAST(COUNT(DISTINCT ${notificationGroups.groupKey}) AS INTEGER)`,
      })
      .from(notificationGroups)
      .innerJoin(
        notifications,
        eq(notifications.groupKey, notificationGroups.groupKey),
      )
      .where(
        and(
          eq(notificationGroups.accountOwnerId, owner.id),
          sql`${notifications.readAt} IS NULL`,
          or(
            sql`${notifications.actorAccountId} IS NULL`,
            and(
              sql`${notifications.actorAccountId} NOT IN (${getBlockedAccountIdsSubquery(owner.id)})`,
              sql`${notifications.actorAccountId} NOT IN (${getMutedAccountIdsSubquery(owner.id, true)})`,
            ),
          ),
        ),
      )
      .limit(limit);

    const count = result[0]?.count ?? 0;

    return c.json({
      count: Math.min(count, limit),
    });
  },
);

// GET /api/v2/notifications/:group_key - Get a single notification group
app.get(
  "/:group_key",
  cancelReadOnlyQueries,
  tokenRequired,
  scopeRequired(["read:notifications"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");

    const groupKey = c.req.param("group_key");

    const group = await db.query.notificationGroups.findFirst({
      where: {
        groupKey: { eq: groupKey },
        accountOwnerId: { eq: owner.id },
      },
    });

    if (group == null) {
      return c.json({ error: "Record not found" }, 404);
    }

    const notificationId = group.mostRecentNotificationId;

    // Fetch related accounts, posts, and the most recent notification
    const [accountsData, postData, mostRecentNotification] = await Promise.all([
      group.sampleAccountIds.length > 0
        ? db.query.accounts.findMany({
            where: { id: { in: group.sampleAccountIds } },
            with: { owner: true, successor: true },
          })
        : [],
      group.targetPostId != null
        ? db.query.posts.findFirst({
            where: { id: { eq: group.targetPostId } },
            with: getPostRelations(owner.id),
          })
        : null,
      notificationId != null
        ? db.query.notifications.findFirst({
            where: { id: { eq: notificationId } },
          })
        : null,
    ]);

    // Serialize data
    const serializedAccounts = accountsData.map((account) =>
      account.owner == null
        ? serializeAccount(account, c.req.url)
        : serializeAccountOwner(
            {
              ...account.owner,
              account,
            },
            c.req.url,
          ),
    );

    const serializedStatus = postData
      ? serializePost(postData, owner, c.req.url)
      : null;

    // Use the actual notification's created time for the composite ID
    const notificationCreatedAt =
      mostRecentNotification?.created ??
      group.latestPageNotificationAt ??
      group.created;
    const latestAt = group.latestPageNotificationAt ?? group.created;

    return c.json({
      accounts: serializedAccounts,
      statuses: serializedStatus != null ? [serializedStatus] : [],
      notification_groups: [
        {
          group_key: group.groupKey,
          notifications_count: group.notificationsCount,
          type: group.type,
          most_recent_notification_id:
            notificationId != null
              ? formatNotificationId(
                  notificationCreatedAt,
                  group.type,
                  notificationId,
                )
              : null,
          page_min_id: group.pageMinId ?? group.mostRecentNotificationId,
          page_max_id: group.pageMaxId ?? group.mostRecentNotificationId,
          latest_page_notification_at: latestAt.toISOString(),
          sample_account_ids: group.sampleAccountIds,
          status_id: group.targetPostId,
        },
      ],
    });
  },
);

// POST /api/v2/notifications/:group_key/dismiss - Dismiss a notification group
app.post(
  "/:group_key/dismiss",
  tokenRequired,
  scopeRequired(["write:notifications"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");

    const groupKey = c.req.param("group_key");

    // Delete all notifications in the group
    await db.transaction(async (tx) => {
      await tx
        .delete(notifications)
        .where(
          and(
            eq(notifications.groupKey, groupKey),
            eq(notifications.accountOwnerId, owner.id),
          ),
        );

      await tx
        .delete(notificationGroups)
        .where(
          and(
            eq(notificationGroups.groupKey, groupKey),
            eq(notificationGroups.accountOwnerId, owner.id),
          ),
        );
    });

    logger.info("Dismissed notification group {groupKey} for owner {ownerId}", {
      groupKey,
      ownerId: owner.id,
    });

    return c.json({});
  },
);

// GET /api/v2/notifications/:group_key/accounts - Get all accounts in a group
app.get(
  "/:group_key/accounts",
  cancelReadOnlyQueries,
  tokenRequired,
  scopeRequired(["read:notifications"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");

    const groupKey = c.req.param("group_key");

    const group = await db.query.notificationGroups.findFirst({
      where: {
        groupKey: { eq: groupKey },
        accountOwnerId: { eq: owner.id },
      },
    });

    if (group == null) {
      return c.json({ error: "Record not found" }, 404);
    }

    // Fetch all notifications in this group to get all account IDs
    const notifs = await db.query.notifications.findMany({
      where: {
        groupKey: { eq: groupKey },
        accountOwnerId: { eq: owner.id },
      },
    });

    const allAccountIds = new Set(
      notifs
        .map((n) => n.actorAccountId)
        .filter((id): id is Uuid => id != null),
    );

    if (allAccountIds.size === 0) {
      return c.json([]);
    }

    const accountsData = await db.query.accounts.findMany({
      where: { id: { in: Array.from(allAccountIds) as Uuid[] } },
      with: { owner: true, successor: true },
    });

    const serializedAccounts = accountsData.map((account) =>
      account.owner == null
        ? serializeAccount(account, c.req.url)
        : serializeAccountOwner(
            {
              ...account.owner,
              account,
            },
            c.req.url,
          ),
    );

    return c.json(serializedAccounts);
  },
);

export default app;
