import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";

import { db } from "../../db";
import { postgresQueryCancellationMiddleware } from "../../db-cancel";
import {
  serializeAccount,
  serializeAccountOwner,
} from "../../entities/account";
import { serializeReaction } from "../../entities/emoji";
import { getPostRelations, serializePost } from "../../entities/status";
import { proxyUrl } from "../../media-proxy";
import {
  scopeRequired,
  tokenRequired,
  withAccountOwner,
  type AccountOwnerVariables,
} from "../../oauth/middleware";
import { notificationTypeEnum, type NotificationType } from "../../schema";
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

const app = new Hono<{ Variables: AccountOwnerVariables }>();
const cancelReadOnlyQueries = postgresQueryCancellationMiddleware();

// set for O(1) access to all possible types
const notificationTypeSet = new Set(notificationTypeEnum.enumValues);
function isNotificationType(value: string) {
  return notificationTypeSet.has(value as NotificationType);
}

app.get(
  "/",
  cancelReadOnlyQueries,
  tokenRequired,
  scopeRequired(["read:notifications"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");
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
    // types contains client-supplied values, which are not necessarily valid NotificationType. Filter everything we don't know and prevent problems later
    // excludeTypes doesn't need filtering because we won't pass it along
    types = types.filter(isNotificationType);
    types = types.filter((t) => !excludeTypes?.includes(t));

    const startTime = performance.now();

    // Use new notifications table for much better performance
    const notificationsData = await db.query.notifications.findMany({
      where: {
        RAW: (notifications, { and, eq, gt, inArray, lt }) =>
          and(
            eq(notifications.accountOwnerId, owner.id),
            inArray(notifications.type, types),
            // Build pagination conditions using timestamps for reliable
            // ordering; UUIDv7 comparison may not work correctly across all
            // PostgreSQL versions.
            olderThan == null
              ? undefined
              : lt(notifications.created, olderThan),
            maxIdParsed?.timestamp == null
              ? undefined
              : lt(notifications.created, maxIdParsed.timestamp),
            sinceIdParsed?.timestamp == null
              ? undefined
              : gt(notifications.created, sinceIdParsed.timestamp),
            minIdParsed?.timestamp == null
              ? undefined
              : gt(notifications.created, minIdParsed.timestamp),
          )!,
      },
      orderBy: (notifications, { desc }) => [desc(notifications.created)],
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

    // Fetch emoji reactions for emoji_reaction notifications
    const emojiReactionNotifications = notificationsData.filter(
      (n) =>
        n.type === "emoji_reaction" &&
        n.targetPostId != null &&
        n.actorAccount != null,
    );

    // Fetch reactions from DB
    const reactionsData =
      emojiReactionNotifications.length > 0
        ? await db.query.reactions.findMany({
            where: {
              RAW: (reactions, { and, eq, or }) =>
                or(
                  ...emojiReactionNotifications.map((n) =>
                    and(
                      eq(reactions.postId, n.targetPostId!),
                      eq(reactions.accountId, n.actorAccount!.id),
                    ),
                  ),
                )!,
            },
            with: {
              account: { with: { owner: true, successor: true } },
            },
          })
        : [];

    // Build map: "postId:accountId" -> Reaction
    const reactionsMap = new Map<string, (typeof reactionsData)[number]>();
    for (const reaction of reactionsData) {
      const mapKey = `${reaction.postId}:${reaction.accountId}`;
      reactionsMap.set(mapKey, reaction);
    }

    if (reactionsData.length > 0) {
      logger.debug(
        "Fetched {count} emoji reactions for emoji_reaction notifications",
        {
          count: reactionsData.length,
        },
      );
    }

    const allNotifications = notificationsData;

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
        const result: Record<string, unknown> = {
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
        };

        // Add emoji and emoji_url fields for emoji_reaction notifications
        // These fields are used by clients like Phanpy, Misskey, Pleroma
        if (n.type === "emoji_reaction" && n.targetPost && account != null) {
          const mapKey = `${n.targetPost.id}:${account.id}`;
          const reaction = reactionsMap.get(mapKey);

          if (reaction != null) {
            // Add top-level emoji and emoji_url fields for client compatibility
            result.emoji = reaction.emoji;
            if (reaction.customEmoji != null) {
              const emojiUrl = proxyUrl(reaction.customEmoji, c.req.url);
              if (emojiUrl != null) {
                result.emoji_url = emojiUrl;
                // Also add camelCase variant for Phanpy compatibility (Phanpy bug workaround)
                result.emojiURL = emojiUrl;
              }
            }

            // Also include emoji_reaction object for Mastodon-compatible clients
            result.emoji_reaction = serializeReaction(
              reaction,
              owner,
              c.req.url,
            );
          } else {
            // Fallback: reaction not found (deleted)
            logger.warn(
              "Reaction not found for emoji_reaction notification {notifId}",
              { notifId: n.id },
            );
            result.emoji = "";
            result.emoji_reaction = {
              name: "",
              count: 1,
              me: false,
              account_ids: [account.id],
            };
          }
        }

        return result;
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
