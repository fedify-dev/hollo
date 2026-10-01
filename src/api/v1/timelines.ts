import { zValidator } from "@hono/zod-validator";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  lt,
  lte,
  notInArray,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { z } from "zod";

import { db, type DatabaseLike } from "../../db";
import { postgresQueryCancellationMiddleware } from "../../db-cancel";
import { getTimelinePostRelations, serializePost } from "../../entities/status";
import {
  TIMELINE_INBOX_LIMIT,
  TIMELINE_INBOXES,
} from "../../federation/timeline";
import {
  scopeRequired,
  tokenRequired,
  withAccountOwner,
  type AccountOwnerVariables,
} from "../../oauth/middleware";
import {
  accountOwners,
  blocks,
  listMembers,
  listPosts,
  lists,
  mentions,
  mutes,
  posts,
  timelinePosts,
} from "../../schema";
import { isUuid, uuid, type Uuid } from "../../uuid";
import {
  getApprovedFollowingAccountIds,
  postAccountIdInArray,
} from "../visibility";

const app = new Hono<{ Variables: AccountOwnerVariables }>();
const cancelReadOnlyQueries = postgresQueryCancellationMiddleware();

app.use(tokenRequired);

const TIMELINE_LIMIT_MAX = 1000;

export const timelineQuerySchema = z.object({
  max_id: uuid.optional(),
  since_id: uuid.optional(),
  min_id: uuid.optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .default("20")
    .transform((v) =>
      Math.min(TIMELINE_LIMIT_MAX, Math.max(1, Number.parseInt(v, 10))),
    ),
});

export const publicTimelineQuerySchema = timelineQuerySchema.extend({
  local: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  remote: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

// Mastodon pagination semantics shared by every timeline endpoint:
// `min_id` returns the posts *immediately* newer than the cursor (ASC +
// reverse to newest-first); `since_id` is applied only when `min_id` is
// absent and keeps the normal DESC order.
function resolveTimelineCursor(query: { min_id?: Uuid; since_id?: Uuid }): {
  useMinId: boolean;
  lowerBound: Uuid | undefined;
} {
  return {
    useMinId: query.min_id != null,
    lowerBound: query.min_id ?? query.since_id,
  };
}

// Build Mastodon-compatible bidirectional pagination Link headers for every
// non-empty timeline response.  `timeline` must be ordered newest-first
// (DESC by id).
function buildTimelineLinkHeader(
  requestUrl: string,
  timeline: readonly { id: Uuid }[],
): { Link: string } | undefined {
  if (timeline.length === 0) return undefined;
  const baseUrl = new URL(requestUrl);
  baseUrl.searchParams.delete("max_id");
  baseUrl.searchParams.delete("min_id");
  baseUrl.searchParams.delete("since_id");
  const linkParts: string[] = [];
  const next = new URL(baseUrl);
  next.searchParams.set("max_id", timeline[timeline.length - 1].id);
  linkParts.push(`<${next.href}>; rel="next"`);
  const prev = new URL(baseUrl);
  prev.searchParams.set("min_id", timeline[0].id);
  linkParts.push(`<${prev.href}>; rel="prev"`);
  return { Link: linkParts.join(", ") };
}

function orderTimelinePostIds(
  timelineIds: { id: Uuid }[],
  useMinId: boolean,
): Uuid[] {
  const orderedIds = timelineIds.map((p) => p.id);
  if (useMinId) orderedIds.reverse();
  return orderedIds;
}

async function hydrateTimelinePosts(
  database: DatabaseLike,
  ownerId: Uuid,
  postIds: Uuid[],
): Promise<Parameters<typeof serializePost>[0][]> {
  if (postIds.length < 1) return [];
  const timeline = await database.query.posts.findMany({
    where: { id: { in: postIds } },
    with: getTimelinePostRelations(ownerId),
  });
  const postsById = new Map(timeline.map((p) => [p.id, p]));
  return postIds.flatMap((id) => {
    const post = postsById.get(id);
    return post == null ? [] : [post];
  });
}

async function hydrateOrderedTimelinePosts(
  database: DatabaseLike,
  ownerId: Uuid,
  timelineIds: { id: Uuid }[],
  useMinId: boolean,
): Promise<Parameters<typeof serializePost>[0][]> {
  return await hydrateTimelinePosts(
    database,
    ownerId,
    orderTimelinePostIds(timelineIds, useMinId),
  );
}

async function readTimelineSnapshot<T>(
  readTimeline: (database: DatabaseLike) => Promise<T>,
): Promise<T> {
  return await db.transaction(readTimeline, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

function getSharedPostFilterConditions(
  ownerId: Uuid,
  outerPosts: typeof posts,
): (SQL | undefined)[] {
  const sharedPosts = alias(posts, "shared_posts");
  return [
    // Hide the shared posts from the muted accounts:
    notExists(
      db
        .select({ id: sharedPosts.id })
        .from(sharedPosts)
        .innerJoin(mutes, eq(mutes.mutedAccountId, sharedPosts.accountId))
        .where(
          and(
            eq(sharedPosts.id, outerPosts.sharingId),
            eq(mutes.accountId, ownerId),
            or(
              isNull(mutes.duration),
              gt(
                sql`${mutes.created} + ${mutes.duration}`,
                sql`CURRENT_TIMESTAMP`,
              ),
            ),
          ),
        ),
    ),
    // Hide the shared posts from the blocked accounts:
    notExists(
      db
        .select({ id: sharedPosts.id })
        .from(sharedPosts)
        .innerJoin(blocks, eq(blocks.blockedAccountId, sharedPosts.accountId))
        .where(
          and(
            eq(sharedPosts.id, outerPosts.sharingId),
            eq(blocks.accountId, ownerId),
          ),
        ),
    ),
    // Hide the shared posts from the accounts who blocked the owner:
    notExists(
      db
        .select({ id: sharedPosts.id })
        .from(sharedPosts)
        .innerJoin(blocks, eq(blocks.accountId, sharedPosts.accountId))
        .where(
          and(
            eq(sharedPosts.id, outerPosts.sharingId),
            eq(blocks.blockedAccountId, ownerId),
          ),
        ),
    ),
  ];
}

function getTimelinePostFilterConditions(ownerId: Uuid): (SQL | undefined)[] {
  return [
    // Hide future posts
    lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
    // Hide the posts from the muted accounts:
    notInArray(
      posts.accountId,
      db
        .select({ accountId: mutes.mutedAccountId })
        .from(mutes)
        .where(
          and(
            eq(mutes.accountId, ownerId),
            or(
              isNull(mutes.duration),
              gt(
                sql`${mutes.created} + ${mutes.duration}`,
                sql`CURRENT_TIMESTAMP`,
              ),
            ),
          ),
        ),
    ),
    // Hide the posts from the blocked accounts:
    notInArray(
      posts.accountId,
      db
        .select({ accountId: blocks.blockedAccountId })
        .from(blocks)
        .where(eq(blocks.accountId, ownerId)),
    ),
    // Hide the posts from the accounts who blocked the owner:
    notInArray(
      posts.accountId,
      db
        .select({ accountId: blocks.accountId })
        .from(blocks)
        .where(eq(blocks.blockedAccountId, ownerId)),
    ),
    ...getSharedPostFilterConditions(ownerId, posts),
  ];
}

app.get(
  "/public",
  cancelReadOnlyQueries,
  withAccountOwner,
  zValidator("query", publicTimelineQuerySchema),
  async (c) => {
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const { useMinId, lowerBound } = resolveTimelineCursor(query);
    const timeline = await readTimelineSnapshot(async (database) => {
      const timelineIds = await database.query.posts.findMany({
        columns: { id: true },
        where: {
          RAW: (
            posts,
            { and, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql },
          ) =>
            and(
              eq(posts.visibility, "public"),
              query.local
                ? inArray(
                    posts.accountId,
                    db.select({ id: accountOwners.id }).from(accountOwners),
                  )
                : undefined,
              query.remote
                ? notInArray(
                    posts.accountId,
                    db.select({ id: accountOwners.id }).from(accountOwners),
                  )
                : undefined,
              // Hide future posts
              lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
              // Hide the posts from the muted accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: mutes.mutedAccountId })
                  .from(mutes)
                  .where(
                    and(
                      eq(mutes.accountId, owner.id),
                      or(
                        isNull(mutes.duration),
                        gt(
                          sql`${mutes.created} + ${mutes.duration}`,
                          sql`CURRENT_TIMESTAMP`,
                        ),
                      ),
                    ),
                  ),
              ),
              // Hide the posts from the blocked accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.blockedAccountId })
                  .from(blocks)
                  .where(eq(blocks.accountId, owner.id)),
              ),
              // Hide the posts from the accounts who blocked the owner:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.accountId })
                  .from(blocks)
                  .where(eq(blocks.blockedAccountId, owner.id)),
              ),
              ...getSharedPostFilterConditions(owner.id, posts),
              query.max_id == null ? undefined : lt(posts.id, query.max_id),
              lowerBound == null ? undefined : gt(posts.id, lowerBound),
            )!,
        },
        orderBy: (posts, { asc, desc }) => [
          useMinId ? asc(posts.id) : desc(posts.id),
        ],
        limit: query.limit,
      });
      return await hydrateOrderedTimelinePosts(
        database,
        owner.id,
        timelineIds,
        useMinId,
      );
    });
    return c.json(
      timeline.map((p) => serializePost(p, owner, c.req.url)),
      200,
      buildTimelineLinkHeader(c.req.url, timeline),
    );
  },
);

app.get(
  "/home",
  cancelReadOnlyQueries,
  scopeRequired(["read:statuses"]),
  withAccountOwner,
  zValidator("query", timelineQuerySchema),
  async (c) => {
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const { useMinId, lowerBound } = resolveTimelineCursor(query);
    const timeline = await readTimelineSnapshot(async (database) => {
      let timelineIds: { id: Uuid }[];
      if (TIMELINE_INBOXES) {
        timelineIds = await database
          .select({ id: posts.id })
          .from(timelinePosts)
          .innerJoin(posts, eq(posts.id, timelinePosts.postId))
          .where(
            and(
              eq(timelinePosts.accountId, owner.id),
              query.max_id == null
                ? undefined
                : lt(timelinePosts.postId, query.max_id),
              lowerBound == null
                ? undefined
                : gt(timelinePosts.postId, lowerBound),
              ...getTimelinePostFilterConditions(owner.id),
            ),
          )
          .orderBy(
            useMinId ? asc(timelinePosts.postId) : desc(timelinePosts.postId),
          )
          .limit(Math.min(TIMELINE_INBOX_LIMIT, query.limit));
      } else {
        const followingAccountIds = await getApprovedFollowingAccountIds(
          owner.id,
          database,
        );
        const followedTags: SQL[] = owner.followedTags.map(
          // oxlint-disable-next-line prefer-template
          (t) => sql`${"#" + t}`,
        );
        timelineIds = await database.query.posts.findMany({
          columns: { id: true },
          where: {
            RAW: (
              posts,
              {
                and,
                eq,
                gt,
                inArray,
                isNull,
                lt,
                lte,
                ne,
                notInArray,
                or,
                sql,
              },
            ) =>
              and(
                or(
                  eq(posts.accountId, owner.id),
                  and(
                    ne(posts.visibility, "direct"),
                    postAccountIdInArray(followingAccountIds, posts),
                    notInArray(
                      posts.accountId,
                      db
                        .select({ id: listMembers.accountId })
                        .from(listMembers)
                        .leftJoin(lists, eq(listMembers.listId, lists.id))
                        .where(eq(lists.exclusive, true)),
                    ),
                  ),
                  and(
                    ne(posts.visibility, "private"),
                    inArray(
                      posts.id,
                      db
                        .select({ id: mentions.postId })
                        .from(mentions)
                        .where(eq(mentions.accountId, owner.id)),
                    ),
                  ),
                  owner.followedTags.length < 1
                    ? undefined
                    : and(
                        eq(posts.visibility, "public"),
                        sql`${posts.tags} ?| ARRAY[${sql.join(
                          followedTags,
                          sql.raw(","),
                        )}]`,
                      ),
                ),
                or(
                  isNull(posts.replyTargetId),
                  inArray(
                    posts.replyTargetId,
                    db
                      .select({ id: posts.id })
                      .from(posts)
                      .where(
                        or(
                          eq(posts.accountId, owner.id),
                          postAccountIdInArray(followingAccountIds, posts),
                        ),
                      ),
                  ),
                ),
                // Hide future posts
                lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
                // Hide the posts from the muted accounts:
                notInArray(
                  posts.accountId,
                  db
                    .select({ accountId: mutes.mutedAccountId })
                    .from(mutes)
                    .where(
                      and(
                        eq(mutes.accountId, owner.id),
                        or(
                          isNull(mutes.duration),
                          gt(
                            sql`${mutes.created} + ${mutes.duration}`,
                            sql`CURRENT_TIMESTAMP`,
                          ),
                        ),
                      ),
                    ),
                ),
                // Hide the posts from the blocked accounts:
                notInArray(
                  posts.accountId,
                  db
                    .select({ accountId: blocks.blockedAccountId })
                    .from(blocks)
                    .where(eq(blocks.accountId, owner.id)),
                ),
                // Hide the posts from the accounts who blocked the owner:
                notInArray(
                  posts.accountId,
                  db
                    .select({ accountId: blocks.accountId })
                    .from(blocks)
                    .where(eq(blocks.blockedAccountId, owner.id)),
                ),
                ...getSharedPostFilterConditions(owner.id, posts),
                query.max_id == null ? undefined : lt(posts.id, query.max_id),
                lowerBound == null ? undefined : gt(posts.id, lowerBound),
              )!,
          },
          orderBy: (posts, { asc, desc }) => [
            useMinId ? asc(posts.id) : desc(posts.id),
          ],
          limit: query.limit,
        });
      }
      return await hydrateOrderedTimelinePosts(
        database,
        owner.id,
        timelineIds,
        useMinId,
      );
    });
    return c.json(
      timeline.map((p) => serializePost(p, owner, c.req.url)),
      200,
      buildTimelineLinkHeader(c.req.url, timeline),
    );
  },
);

app.get(
  "/list/:list_id",
  cancelReadOnlyQueries,
  tokenRequired,
  scopeRequired(["read:lists"]),
  withAccountOwner,
  zValidator("query", publicTimelineQuerySchema),
  async (c) => {
    const listId = c.req.param("list_id");
    if (!isUuid(listId)) return c.json({ error: "Record not found" }, 404);
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const list = await db.query.lists.findFirst({
      where: {
        RAW: (lists, { and, eq }) =>
          and(eq(lists.id, listId), eq(lists.accountOwnerId, owner.id))!,
      },
    });
    if (list == null) return c.json({ error: "Record not found" }, 404);
    const { useMinId, lowerBound } = resolveTimelineCursor(query);
    const timeline = await readTimelineSnapshot(async (database) => {
      let timelineIds: { id: Uuid }[];
      if (TIMELINE_INBOXES) {
        timelineIds = await database
          .select({ id: posts.id })
          .from(listPosts)
          .innerJoin(posts, eq(posts.id, listPosts.postId))
          .where(
            and(
              eq(listPosts.listId, list.id),
              query.max_id == null
                ? undefined
                : lt(listPosts.postId, query.max_id),
              lowerBound == null ? undefined : gt(listPosts.postId, lowerBound),
              ...getTimelinePostFilterConditions(owner.id),
            ),
          )
          .orderBy(useMinId ? asc(listPosts.postId) : desc(listPosts.postId))
          .limit(Math.min(TIMELINE_INBOX_LIMIT, query.limit));
      } else {
        const followingAccountIds = await getApprovedFollowingAccountIds(
          owner.id,
          database,
        );
        timelineIds = await database.query.posts.findMany({
          columns: { id: true },
          where: {
            RAW: (
              posts,
              {
                and,
                eq,
                gt,
                inArray,
                isNull,
                lt,
                lte,
                ne,
                notInArray,
                or,
                sql,
              },
            ) =>
              and(
                ne(posts.visibility, "direct"),
                inArray(
                  posts.accountId,
                  db
                    .select({ id: listMembers.accountId })
                    .from(listMembers)
                    .where(eq(listMembers.listId, list.id)),
                ),
                or(
                  isNull(posts.replyTargetId),
                  list.repliesPolicy === "none"
                    ? undefined
                    : inArray(
                        posts.replyTargetId,
                        db
                          .select({ id: posts.id })
                          .from(posts)
                          .where(
                            or(
                              eq(posts.accountId, owner.id),
                              list.repliesPolicy === "followed"
                                ? postAccountIdInArray(
                                    followingAccountIds,
                                    posts,
                                  )
                                : inArray(
                                    posts.accountId,
                                    db
                                      .select({ id: listMembers.accountId })
                                      .from(listMembers)
                                      .where(eq(listMembers.listId, list.id)),
                                  ),
                            ),
                          ),
                      ),
                ),
                // Hide future posts
                lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
                // Hide the posts from the muted accounts:
                notInArray(
                  posts.accountId,
                  db
                    .select({ accountId: mutes.mutedAccountId })
                    .from(mutes)
                    .where(
                      and(
                        eq(mutes.accountId, owner.id),
                        or(
                          isNull(mutes.duration),
                          gt(
                            sql`${mutes.created} + ${mutes.duration}`,
                            sql`CURRENT_TIMESTAMP`,
                          ),
                        ),
                      ),
                    ),
                ),
                // Hide the posts from the blocked accounts:
                notInArray(
                  posts.accountId,
                  db
                    .select({ accountId: blocks.blockedAccountId })
                    .from(blocks)
                    .where(eq(blocks.accountId, owner.id)),
                ),
                // Hide the posts from the accounts who blocked the owner:
                notInArray(
                  posts.accountId,
                  db
                    .select({ accountId: blocks.accountId })
                    .from(blocks)
                    .where(eq(blocks.blockedAccountId, owner.id)),
                ),
                ...getSharedPostFilterConditions(owner.id, posts),
                query.max_id == null ? undefined : lt(posts.id, query.max_id),
                lowerBound == null ? undefined : gt(posts.id, lowerBound),
              )!,
          },
          orderBy: (posts, { asc, desc }) => [
            useMinId ? asc(posts.id) : desc(posts.id),
          ],
          limit: query.limit,
        });
      }
      return await hydrateOrderedTimelinePosts(
        database,
        owner.id,
        timelineIds,
        useMinId,
      );
    });
    return c.json(
      timeline.map((p) => serializePost(p, owner, c.req.url)),
      200,
      buildTimelineLinkHeader(c.req.url, timeline),
    );
  },
);

app.get(
  "/tag/:hashtag",
  cancelReadOnlyQueries,
  tokenRequired,
  scopeRequired(["read:statuses"]),
  withAccountOwner,
  zValidator("query", publicTimelineQuerySchema),
  async (c) => {
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const hashtag = `#${c.req.param("hashtag")}`;
    const { useMinId, lowerBound } = resolveTimelineCursor(query);
    const timeline = await readTimelineSnapshot(async (database) => {
      const followingAccountIds = await getApprovedFollowingAccountIds(
        owner.id,
        database,
      );
      const timelineIds = await database.query.posts.findMany({
        columns: { id: true },
        where: {
          RAW: (
            posts,
            { and, eq, gt, inArray, isNull, lt, lte, ne, notInArray, or, sql },
          ) =>
            and(
              or(
                eq(posts.accountId, owner.id),
                and(
                  ne(posts.visibility, "direct"),
                  postAccountIdInArray(followingAccountIds, posts),
                ),
                and(
                  ne(posts.visibility, "private"),
                  inArray(
                    posts.id,
                    db
                      .select({ id: mentions.postId })
                      .from(mentions)
                      .where(eq(mentions.accountId, owner.id)),
                  ),
                ),
              ),
              sql`${posts.tags} ? ${hashtag.toLowerCase()}`,
              query.local
                ? inArray(
                    posts.accountId,
                    db.select({ id: accountOwners.id }).from(accountOwners),
                  )
                : undefined,
              query.remote
                ? notInArray(
                    posts.accountId,
                    db.select({ id: accountOwners.id }).from(accountOwners),
                  )
                : undefined,
              // Hide future posts
              lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
              // Hide the posts from the muted accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: mutes.mutedAccountId })
                  .from(mutes)
                  .where(
                    and(
                      eq(mutes.accountId, owner.id),
                      or(
                        isNull(mutes.duration),
                        gt(
                          sql`${mutes.created} + ${mutes.duration}`,
                          sql`CURRENT_TIMESTAMP`,
                        ),
                      ),
                    ),
                  ),
              ),
              // Hide the posts from the blocked accounts:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.blockedAccountId })
                  .from(blocks)
                  .where(eq(blocks.accountId, owner.id)),
              ),
              // Hide the posts from the accounts who blocked the owner:
              notInArray(
                posts.accountId,
                db
                  .select({ accountId: blocks.accountId })
                  .from(blocks)
                  .where(eq(blocks.blockedAccountId, owner.id)),
              ),
              query.max_id == null ? undefined : lt(posts.id, query.max_id),
              lowerBound == null ? undefined : gt(posts.id, lowerBound),
            )!,
        },
        orderBy: (posts, { asc, desc }) => [
          useMinId ? asc(posts.id) : desc(posts.id),
        ],
        limit: query.limit,
      });
      return await hydrateOrderedTimelinePosts(
        database,
        owner.id,
        timelineIds,
        useMinId,
      );
    });
    return c.json(
      timeline.map((p) => serializePost(p, owner, c.req.url)),
      200,
      buildTimelineLinkHeader(c.req.url, timeline),
    );
  },
);

export default app;
