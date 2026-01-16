import { getLogger } from "@logtape/logtape";
import { and, desc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import {
  serializeAccount,
  serializeAccountOwner,
} from "../../entities/account";
import { serializeReaction } from "../../entities/emoji";
import { getPostRelations, serializePost } from "../../entities/status";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { notifications, polls, pollVotes, posts } from "../../schema";
import type { Uuid } from "../../uuid";

const logger = getLogger(["hollo", "notifications"]);

// Parse composite notification ID format: "created_at/type/uuid"
// Returns the actual notification UUID and timestamp for database queries
interface ParsedNotificationId {
  uuid: Uuid;
  timestamp: Date | null;
}

function parseNotificationId(compositeId: string): ParsedNotificationId {
  const parts = compositeId.split("/");
  if (parts.length >= 3) {
    // Format: "2025-11-15T10:00:00.000Z/follow/uuid"
    const timestampStr = parts.slice(0, -2).join("/"); // Handle ISO timestamp with colons
    const uuid = parts[parts.length - 1] as Uuid;
    const timestamp = new Date(timestampStr);
    const isValidTimestamp = !Number.isNaN(timestamp.getTime());
    logger.debug(
      "Parsed composite notification ID: {compositeId} -> {uuid}, {timestamp}",
      {
        compositeId,
        uuid,
        timestamp: isValidTimestamp ? timestamp.toISOString() : "invalid",
        isValidTimestamp,
      },
    );
    return {
      uuid,
      timestamp: Number.isNaN(timestamp.getTime()) ? null : timestamp,
    };
  }
  // Fallback: assume it's already a plain UUID
  logger.debug(
    "Notification ID is not composite, using as UUID: {compositeId}",
    {
      compositeId,
    },
  );
  return { uuid: compositeId as Uuid, timestamp: null };
}

const app = new Hono<{ Variables: Variables }>();

export type NotificationType =
  | "mention"
  | "status"
  | "reblog"
  | "follow"
  | "follow_request"
  | "favourite"
  | "emoji_reaction"
  | "poll"
  | "update"
  | "admin.sign_up"
  | "admin.report"
  | "quote"
  | "quoted_update";

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
    let types = c.req.queries("types[]") as NotificationType[];
    const excludeTypes = c.req.queries("exclude_types[]") as NotificationType[];
    const olderThanStr = c.req.query("older_than");
    const olderThan = olderThanStr == null ? null : new Date(olderThanStr);
    const limit = Number.parseInt(c.req.query("limit") ?? "40", 10);

    // Mastodon-compatible pagination parameters
    const maxIdParam = c.req.query("max_id");
    const sinceIdParam = c.req.query("since_id");
    const minIdParam = c.req.query("min_id");

    // Parse composite IDs to get actual UUIDs and timestamps
    const maxIdParsed = maxIdParam ? parseNotificationId(maxIdParam) : null;
    const sinceIdParsed = sinceIdParam
      ? parseNotificationId(sinceIdParam)
      : null;
    const minIdParsed = minIdParam ? parseNotificationId(minIdParam) : null;

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

    // Build pagination conditions using timestamps for reliable ordering
    // UUIDv7 comparison may not work correctly across all PostgreSQL versions
    const paginationConditions = [];
    if (olderThan != null) {
      paginationConditions.push(lt(notifications.created, olderThan));
    }
    // max_id: Return results older than this ID (exclusive)
    if (maxIdParsed?.timestamp != null) {
      paginationConditions.push(
        lt(notifications.created, maxIdParsed.timestamp),
      );
    }
    // since_id: Return results newer than this ID (exclusive)
    if (sinceIdParsed?.timestamp != null) {
      paginationConditions.push(
        gt(notifications.created, sinceIdParsed.timestamp),
      );
    }
    // min_id: Return results immediately newer than this ID (exclusive)
    if (minIdParsed?.timestamp != null) {
      paginationConditions.push(
        gt(notifications.created, minIdParsed.timestamp),
      );
    }

    // Use new notifications table for much better performance
    const notificationsData = await db.query.notifications.findMany({
      where: and(
        eq(notifications.accountOwnerId, owner.id),
        inArray(notifications.type, types),
        ...paginationConditions,
      ),
      orderBy: desc(notifications.created),
      limit,
      with: {
        actorAccount: { with: { owner: true, successor: true } },
        targetPost: { with: getPostRelations(owner.id) },
        targetAccount: { with: { owner: true, successor: true } },
      },
    });

    const afterQuery = performance.now();
    logger.info("Notifications query took {ms}ms, returned {count} results", {
      ms: Math.round(afterQuery - startTime),
      count: notificationsData.length,
    });

    // Query poll expiry notifications dynamically (not stored in DB)
    type StoredNotification = (typeof notificationsData)[number];
    type PollNotification = {
      id: string;
      type: "poll";
      created: Date;
      targetPost: NonNullable<StoredNotification["targetPost"]>;
      actorAccount: null;
      targetAccount: null;
      targetPollId: null;
      groupKey: string;
      readAt: null;
    };
    const pollNotificationsData: PollNotification[] = [];

    if (types.includes("poll")) {
      const now = new Date();

      // Build poll pagination conditions using timestamps from parsed IDs
      const pollPaginationConditions = [];
      if (olderThan != null) {
        pollPaginationConditions.push(lt(polls.expires, olderThan));
      }
      if (maxIdParsed?.timestamp != null) {
        pollPaginationConditions.push(lt(polls.expires, maxIdParsed.timestamp));
      }
      if (sinceIdParsed?.timestamp != null) {
        pollPaginationConditions.push(
          gt(polls.expires, sinceIdParsed.timestamp),
        );
      }
      if (minIdParsed?.timestamp != null) {
        pollPaginationConditions.push(gt(polls.expires, minIdParsed.timestamp));
      }

      // Find expired polls where user is the author or has voted
      // Note: We don't join with accountOwners here because that would filter out
      // polls from remote users. Instead, we check the conditions directly.
      const expiredPollIds = await db
        .selectDistinct({ pollId: polls.id, expires: polls.expires })
        .from(polls)
        .innerJoin(posts, eq(posts.pollId, polls.id))
        .where(
          and(
            lte(polls.expires, now),
            or(
              // User is the post author (owner.id equals the account ID)
              eq(posts.accountId, owner.id),
              // User has voted in the poll
              sql`EXISTS (
                SELECT 1 FROM ${pollVotes}
                WHERE ${pollVotes.pollId} = ${polls.id}
                  AND ${pollVotes.accountId} = ${owner.id}
              )`,
            ),
            ...pollPaginationConditions,
          ),
        )
        .orderBy(desc(polls.expires))
        .limit(limit);

      if (expiredPollIds.length > 0) {
        // Load all posts with relations in one query
        const expiredPosts = await db.query.posts.findMany({
          where: inArray(
            posts.pollId,
            expiredPollIds.map((p) => p.pollId),
          ),
          with: getPostRelations(owner.id),
        });

        // Create poll notifications
        for (const pollInfo of expiredPollIds) {
          const post = expiredPosts.find((p) => p.pollId === pollInfo.pollId);
          if (post) {
            pollNotificationsData.push({
              id: `poll-${pollInfo.pollId}`,
              type: "poll",
              created: pollInfo.expires,
              targetPost: post,
              actorAccount: null,
              targetAccount: null,
              targetPollId: null,
              groupKey: `ungrouped:poll-${pollInfo.pollId}`,
              readAt: null,
            });
          }
        }
      }
    }

    // Merge stored notifications and poll notifications, then sort and limit
    const allNotifications = [...notificationsData, ...pollNotificationsData]
      .sort((a, b) => b.created.getTime() - a.created.getTime())
      .slice(0, limit);

    let nextLink: URL | null = null;
    let prevLink: URL | null = null;

    // Next link: for fetching notifications older than the oldest one
    if (allNotifications.length >= limit) {
      const oldest = allNotifications[allNotifications.length - 1];
      const oldestId = `${oldest.created.toISOString()}/${oldest.type}/${oldest.id}`;
      nextLink = new URL(c.req.url);
      // Remove existing pagination parameters
      nextLink.searchParams.delete("older_than");
      nextLink.searchParams.delete("min_id");
      nextLink.searchParams.delete("since_id");
      nextLink.searchParams.set("max_id", oldestId);
    }

    // Prev link: for fetching notifications newer than the newest one
    if (allNotifications.length > 0) {
      const newest = allNotifications[0];
      const newestId = `${newest.created.toISOString()}/${newest.type}/${newest.id}`;
      prevLink = new URL(c.req.url);
      // Remove existing pagination parameters
      prevLink.searchParams.delete("older_than");
      prevLink.searchParams.delete("max_id");
      prevLink.searchParams.delete("since_id");
      prevLink.searchParams.set("min_id", newestId);
    }

    const serialized = allNotifications
      .map((n) => {
        const created_at = n.created.toISOString();
        const account = n.actorAccount;

        // Poll notifications don't have actor accounts
        if (n.type !== "poll" && account == null) {
          logger.error("Notification {id} missing actor account", {
            id: n.id,
            type: n.type,
          });
          return null;
        }

        // Poll notifications use post author as account
        const displayAccount =
          n.type === "poll" && n.targetPost ? n.targetPost.account : account;

        if (displayAccount == null) {
          logger.error("Notification {id} missing display account", {
            id: n.id,
            type: n.type,
          });
          return null;
        }
        return {
          id: `${created_at}/${n.type}/${n.id}`,
          type: n.type,
          created_at,
          account:
            displayAccount.owner == null
              ? serializeAccount(displayAccount, c.req.url)
              : serializeAccountOwner(
                  {
                    ...displayAccount.owner,
                    account: displayAccount,
                  },
                  c.req.url,
                ),
          status: n.targetPost
            ? serializePost(n.targetPost, owner, c.req.url)
            : null,
          ...(n.type === "emoji_reaction" && n.targetPost && account
            ? {
                emoji_reaction: serializeReaction(
                  {
                    postId: n.targetPost.id,
                    accountId: account.id,
                    account,
                    emoji: "", // Will be fetched from reactions table if needed
                    customEmoji: null,
                    emojiIri: null,
                    created: n.created,
                  },
                  owner,
                ),
              }
            : {}),
        };
      })
      .filter((n) => n != null);

    const afterSerialization = performance.now();
    logger.info("Serialization took {ms}ms", {
      ms: Math.round(afterSerialization - afterQuery),
    });

    // Build Link header
    const linkParts: string[] = [];
    if (nextLink != null) {
      linkParts.push(`<${nextLink.href}>; rel="next"`);
    }
    if (prevLink != null) {
      linkParts.push(`<${prevLink.href}>; rel="prev"`);
    }

    return c.json(serialized, {
      headers: linkParts.length > 0 ? { Link: linkParts.join(", ") } : {},
    });
  },
);

export default app;
