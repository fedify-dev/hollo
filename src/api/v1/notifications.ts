import { getLogger } from "@logtape/logtape";
import { and, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
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
import {
  accountOwners,
  notifications,
  polls,
  pollVotes,
  posts,
} from "../../schema";

const logger = getLogger(["hollo", "notifications"]);

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
  | "admin.report";

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
      ];
    }
    types = types.filter((t) => !excludeTypes?.includes(t));

    const startTime = performance.now();

    // Use new notifications table for much better performance
    const notificationsData = await db.query.notifications.findMany({
      where: and(
        eq(notifications.accountOwnerId, owner.id),
        inArray(notifications.type, types),
        olderThan == null ? undefined : lt(notifications.created, olderThan),
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

      // Find expired polls where user is the author or has voted
      const expiredPollIds = await db
        .selectDistinct({ pollId: polls.id, expires: polls.expires })
        .from(polls)
        .innerJoin(posts, eq(posts.pollId, polls.id))
        .innerJoin(accountOwners, eq(posts.accountId, accountOwners.id))
        .where(
          and(
            lte(polls.expires, now),
            or(
              // User is the post author
              eq(accountOwners.id, owner.id),
              // User has voted in the poll
              sql`EXISTS (
                SELECT 1 FROM ${pollVotes}
                INNER JOIN ${accountOwners} AS voter_owner ON ${pollVotes.accountId} = voter_owner.id
                WHERE ${pollVotes.pollId} = ${polls.id}
                  AND voter_owner.id = ${owner.id}
              )`,
            ),
            olderThan == null ? undefined : lt(polls.expires, olderThan),
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
    if (allNotifications.length >= limit) {
      const oldest = allNotifications[allNotifications.length - 1].created;
      nextLink = new URL(c.req.url);
      nextLink.searchParams.set("older_than", oldest.toISOString());
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

    return c.json(serialized, {
      headers:
        nextLink == null ? {} : { Link: `<${nextLink.href}>; rel="next"` },
    });
  },
);

export default app;
