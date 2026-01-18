import { getLogger } from "@logtape/logtape";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import {
  serializeAccount,
  serializeAccountOwner,
} from "../../entities/account";
import { getPostRelations, serializePost } from "../../entities/status";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import {
  accounts,
  type NotificationType,
  notificationGroups,
  notifications,
  posts,
} from "../../schema";
import type { Uuid } from "../../uuid";

const logger = getLogger(["hollo", "api", "v2", "notifications"]);

const app = new Hono<{ Variables: Variables }>();

// Format notification ID to match v1 API format for consistency
// This ensures markers work correctly across v1 and v2 APIs
function formatNotificationId(created: Date, type: string, id: string): string {
  return `${created.toISOString()}/${type}/${id}`;
}

// GET /api/v2/notifications - Get grouped notifications
app.get(
  "/",
  tokenRequired,
  scopeRequired(["read:notifications"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }

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
    types = types.filter((t) => !excludeTypes?.includes(t));

    const startTime = performance.now();

    // Query notification groups
    const conditions = [
      eq(notificationGroups.accountOwnerId, owner.id),
      inArray(notificationGroups.type, types),
    ];

    // Pagination conditions
    if (maxId != null) {
      conditions.push(lt(notificationGroups.pageMaxId, maxId as Uuid));
    }
    if (sinceId != null) {
      conditions.push(gt(notificationGroups.pageMaxId, sinceId as Uuid));
    }
    if (minId != null) {
      conditions.push(gt(notificationGroups.pageMaxId, minId as Uuid));
    }

    const groups = await db.query.notificationGroups.findMany({
      where: and(...conditions),
      // Use COALESCE to handle NULL latestPageNotificationAt values
      // (e.g., from older migrations that didn't set this field)
      orderBy: desc(
        sql`COALESCE(${notificationGroups.latestPageNotificationAt}, ${notificationGroups.created})`,
      ),
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

    // Collect all account IDs, post IDs, and notification IDs to fetch
    const accountIds = new Set<string>();
    const postIds = new Set<string>();
    const notificationIds = new Set<string>();

    for (const group of groups) {
      for (const accountId of group.sampleAccountIds) {
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
            where: inArray(accounts.id, Array.from(accountIds) as Uuid[]),
            with: { owner: true, successor: true },
          })
        : [],
      postIds.size > 0
        ? db.query.posts.findMany({
            where: inArray(posts.id, Array.from(postIds) as Uuid[]),
            with: getPostRelations(owner.id),
          })
        : [],
      notificationIds.size > 0
        ? db.query.notifications.findMany({
            where: inArray(
              notifications.id,
              Array.from(notificationIds) as Uuid[],
            ),
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

    // Serialize statuses for deduplication
    const serializedStatuses = postsData.map((post) =>
      serializePost(post, owner, c.req.url),
    );

    // Serialize notification groups
    const notificationGroupsData = groups.map((group) => {
      const targetPost = group.targetPostId
        ? postsMap.get(group.targetPostId)
        : null;

      // Get sample account IDs
      const sampleAccountIds = group.sampleAccountIds.filter((id) =>
        accountsMap.has(id),
      );

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
        sample_account_ids: sampleAccountIds,
        status_id: targetPost?.id ?? null,
      };
    });

    const afterSerialization = performance.now();
    logger.info("Serialization took {ms}ms", {
      ms: Math.round(afterSerialization - afterDataQuery),
    });

    // Build pagination links
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
  tokenRequired,
  scopeRequired(["read:notifications"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }

    const limit = Math.min(
      Number.parseInt(c.req.query("limit") ?? "100", 10),
      1000,
    );

    // Count unread notifications (notifications without readAt)
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
  tokenRequired,
  scopeRequired(["read:notifications"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }

    const groupKey = c.req.param("group_key");

    const group = await db.query.notificationGroups.findFirst({
      where: and(
        eq(notificationGroups.groupKey, groupKey),
        eq(notificationGroups.accountOwnerId, owner.id),
      ),
    });

    if (group == null) {
      return c.json({ error: "Record not found" }, 404);
    }

    const notificationId = group.mostRecentNotificationId;

    // Fetch related accounts, posts, and the most recent notification
    const [accountsData, postData, mostRecentNotification] = await Promise.all([
      group.sampleAccountIds.length > 0
        ? db.query.accounts.findMany({
            where: inArray(accounts.id, group.sampleAccountIds),
            with: { owner: true, successor: true },
          })
        : [],
      group.targetPostId != null
        ? db.query.posts.findFirst({
            where: eq(posts.id, group.targetPostId),
            with: getPostRelations(owner.id),
          })
        : null,
      notificationId != null
        ? db.query.notifications.findFirst({
            where: eq(notifications.id, notificationId),
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
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }

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
  tokenRequired,
  scopeRequired(["read:notifications"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }

    const groupKey = c.req.param("group_key");

    const group = await db.query.notificationGroups.findFirst({
      where: and(
        eq(notificationGroups.groupKey, groupKey),
        eq(notificationGroups.accountOwnerId, owner.id),
      ),
    });

    if (group == null) {
      return c.json({ error: "Record not found" }, 404);
    }

    // Fetch all notifications in this group to get all account IDs
    const notifs = await db.query.notifications.findMany({
      where: and(
        eq(notifications.groupKey, groupKey),
        eq(notifications.accountOwnerId, owner.id),
      ),
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
      where: inArray(accounts.id, Array.from(allAccountIds) as Uuid[]),
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
