import * as vocab from "@fedify/vocab";
import {
  Add,
  Emoji,
  EmojiReact,
  Image,
  Note,
  PUBLIC_COLLECTION,
  Remove,
  Undo,
} from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import {
  and,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { TypedResponse } from "hono/types";
import { z } from "zod";

import { db } from "../../db";
import {
  serializeAccount,
  serializeAccountOwner,
} from "../../entities/account";
import { getPostRelations, serializePost } from "../../entities/status";
import federation from "../../federation";
import { updateAccountStats } from "../../federation/account";
import {
  getRecipients,
  persistPost,
  toAnnounce,
  toCreate,
  toDelete,
  toObject,
  toUpdate,
} from "../../federation/post";
import { appendPostToTimelines } from "../../federation/timeline";
import { requestBody } from "../../helpers";
import { getAccessToken } from "../../oauth/helpers";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { fetchPreviewCard, type PreviewCard } from "../../previewcard";
import {
  accountOwners,
  blocks,
  bookmarks,
  customEmojis,
  follows,
  type Like,
  likes,
  type Mention,
  media,
  mentions,
  mutes,
  type NewBookmark,
  type NewLike,
  type NewPinnedPost,
  type NewPollOption,
  type NewPost,
  type Poll,
  pinnedPosts,
  pollOptions,
  polls,
  posts,
  type QuoteApprovalPolicy,
  reactions,
} from "../../schema";
import { isUuid, type Uuid, uuid, uuidv7 } from "../../uuid";
import {
  buildPostVisibilityConditions,
  getPostVisibilityScope,
} from "../visibility";

const app = new Hono<{ Variables: Variables }>();
const logger = getLogger(["hollo", "api", "v1", "statuses"]);

const quoteApprovalPolicySchema = z.enum(["public", "followers", "nobody"]);

function getPostOrderingKey(postIri: string): string {
  return `post:${postIri}`;
}

function getLikeOrderingKey(actorIri: string, postIri: string): string {
  return `like:${actorIri}:${postIri}`;
}

function getReactionOrderingKey(
  actorIri: string,
  postIri: string,
  emoji: string,
): string {
  return `react:${actorIri}:${postIri}:${emoji}`;
}

/**
 * Builds mute and block conditions for authenticated users.
 * Returns undefined for unauthenticated users (no mute/block filtering).
 */
function buildMuteAndBlockConditions(viewerAccountId: Uuid | null | undefined) {
  if (viewerAccountId == null) return undefined;

  return and(
    notInArray(
      posts.accountId,
      db
        .select({ accountId: mutes.mutedAccountId })
        .from(mutes)
        .where(
          and(
            eq(mutes.accountId, viewerAccountId),
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
    notInArray(
      posts.accountId,
      db
        .select({ accountId: blocks.blockedAccountId })
        .from(blocks)
        .where(eq(blocks.accountId, viewerAccountId)),
    ),
    notInArray(
      posts.accountId,
      db
        .select({ accountId: blocks.accountId })
        .from(blocks)
        .where(eq(blocks.blockedAccountId, viewerAccountId)),
    ),
  );
}

function normalizeQuoteApprovalPolicy(
  policy: QuoteApprovalPolicy | null | undefined,
  visibility: "public" | "unlisted" | "private" | "direct",
): QuoteApprovalPolicy {
  if (visibility === "private" || visibility === "direct") return "nobody";
  return policy ?? "public";
}

async function isApprovedFollower(
  followerId: Uuid,
  followingId: Uuid,
): Promise<boolean> {
  const follow = await db.query.follows.findFirst({
    where: and(
      eq(follows.followerId, followerId),
      eq(follows.followingId, followingId),
      isNotNull(follows.approved),
    ),
  });
  return follow != null;
}

async function isBlockedBetween(accountId: Uuid, otherAccountId: Uuid) {
  const block = await db.query.blocks.findFirst({
    where: or(
      and(
        eq(blocks.accountId, accountId),
        eq(blocks.blockedAccountId, otherAccountId),
      ),
      and(
        eq(blocks.accountId, otherAccountId),
        eq(blocks.blockedAccountId, accountId),
      ),
    ),
  });
  return block != null;
}

async function validateQuoteTarget(
  quoteTargetId: Uuid,
  owner: { id: Uuid },
  mentionedIds: Uuid[],
  requestedVisibility: "public" | "unlisted" | "private" | "direct",
): Promise<
  | {
      ok: true;
      quoteTarget: typeof posts.$inferSelect;
      visibility: "public" | "unlisted" | "private" | "direct";
    }
  | { ok: false; status: 404 | 422; error: string }
> {
  const visibilityScope = await getPostVisibilityScope(owner.id);
  const quoteTarget = await db.query.posts.findFirst({
    where: and(
      eq(posts.id, quoteTargetId),
      buildPostVisibilityConditions(visibilityScope),
    ),
  });
  if (quoteTarget == null) {
    return { ok: false, status: 404, error: "Quote target not found" };
  }
  if (quoteTarget.visibility === "direct") {
    return { ok: false, status: 422, error: "Cannot quote a direct message" };
  }

  let visibility = requestedVisibility;
  if (
    quoteTarget.visibility === "private" &&
    (visibility === "public" || visibility === "unlisted")
  ) {
    visibility = "private";
  }
  if (
    visibility === "direct" &&
    !mentionedIds.includes(quoteTarget.accountId)
  ) {
    return {
      ok: false,
      status: 422,
      error: "Cannot quote without mentioning the quoted status author",
    };
  }
  if (await isBlockedBetween(owner.id, quoteTarget.accountId)) {
    return { ok: false, status: 422, error: "Quote target is not quotable" };
  }
  if (quoteTarget.accountId !== owner.id) {
    const policy = normalizeQuoteApprovalPolicy(
      quoteTarget.quoteApprovalPolicy,
      quoteTarget.visibility,
    );
    if (policy === "nobody") {
      return { ok: false, status: 422, error: "Quote target is not quotable" };
    }
    if (
      policy === "followers" &&
      !(await isApprovedFollower(owner.id, quoteTarget.accountId))
    ) {
      return { ok: false, status: 422, error: "Quote target is not quotable" };
    }
  }
  return { ok: true, quoteTarget, visibility };
}

const statusSchema = z.object({
  status: z.string().min(1).optional().nullable(),
  media_ids: z.array(uuid).optional().nullable(),
  poll: z
    .object({
      options: z.array(z.string()),
      expires_in: z.union([
        z.number().int(),
        z
          .string()
          .regex(/^\d+$/)
          .transform((v) => Number.parseInt(v, 10)),
      ]),
      multiple: z.boolean().default(false),
      hide_totals: z.boolean().default(false),
    })
    .optional()
    .nullable(),
  sensitive: z.boolean().default(false),
  spoiler_text: z.string().optional().nullable(),
  language: z.string().min(2).optional().nullable(),
  quote_approval_policy: quoteApprovalPolicySchema.optional().nullable(),
});

const createStatusSchema = statusSchema.extend({
  in_reply_to_id: uuid.optional().nullable(),
  quote_id: uuid.optional().nullable(),
  quoted_status_id: uuid.optional().nullable(),
  visibility: z
    .enum(["public", "unlisted", "private", "direct"])
    .optional()
    .nullable(),
  scheduled_at: z.iso.datetime().optional().nullable(),
});

app.post("/", tokenRequired, scopeRequired(["write:statuses"]), async (c) => {
  const token = c.get("token");
  const owner = token.accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (idempotencyKey != null) {
    const post = await db.query.posts.findFirst({
      where: and(
        eq(posts.accountId, owner.id),
        eq(posts.idempotenceKey, idempotencyKey),
        gt(posts.published, sql`CURRENT_TIMESTAMP - INTERVAL '1 hour'`),
      ),
      with: getPostRelations(owner.id),
    });
    if (post != null) return c.json(serializePost(post, owner, c.req.url));
  }

  const fedCtx = federation.createContext(c.req.raw, undefined);
  const fmtOpts = {
    url: fedCtx.url,
    contextLoader: fedCtx.contextLoader,
    documentLoader: await fedCtx.getDocumentLoader({
      username: owner.handle,
    }),
  };

  const result = await requestBody(c.req, createStatusSchema);

  if (!result.success) {
    logger.debug("Invalid request: {error}", { error: result.error.issues });
    return c.json({ error: "invalid_request", zod_error: result.error }, 422);
  }

  const data = result.data;

  const handle = owner.handle;
  const id = uuidv7();
  const url = fedCtx.getObjectUri(Note, { username: handle, id });
  const { formatPostContent } = await import("../../text");
  const content =
    data.status == null
      ? null
      : await formatPostContent(db, data.status, data.language, fmtOpts);
  const summary =
    data.spoiler_text == null || data.spoiler_text.trim() === ""
      ? null
      : data.spoiler_text;
  const mentionedIds = content?.mentions ?? [];
  const hashtags = content?.hashtags ?? [];
  const emojis = content?.emojis ?? {};
  const tags = Object.fromEntries(
    hashtags.map((tag) => [
      tag.toLowerCase(),
      new URL(`/tags/${encodeURIComponent(tag.substring(1))}`, c.req.url).href,
    ]),
  );
  let previewCard: PreviewCard | null = null;
  if (content?.previewLink != null) {
    previewCard = await fetchPreviewCard(content.previewLink);
  }
  let quoteTargetId: Uuid | null = null;
  let quoteTarget: typeof posts.$inferSelect | null = null;
  if (data.quoted_status_id != null) quoteTargetId = data.quoted_status_id;
  else if (data.quote_id != null) quoteTargetId = data.quote_id;
  else if (content?.quoteTarget != null) {
    const quoted = await persistPost(
      db,
      content.quoteTarget,
      c.req.url,
      fmtOpts,
    );
    if (quoted != null) quoteTargetId = quoted.id;
  }
  let effectiveVisibility = data.visibility ?? owner.visibility;
  if (quoteTargetId != null) {
    const validation = await validateQuoteTarget(
      quoteTargetId,
      owner,
      mentionedIds,
      effectiveVisibility,
    );
    if (!validation.ok) {
      return c.json({ error: validation.error }, validation.status);
    }
    quoteTarget = validation.quoteTarget;
    effectiveVisibility = validation.visibility;
  }
  const quoteApprovalPolicy = normalizeQuoteApprovalPolicy(
    data.quote_approval_policy,
    effectiveVisibility,
  );
  let quoteState: "accepted" | "pending" | null = null;
  if (quoteTarget != null) {
    const localQuoteTargetOwner =
      quoteTarget.accountId === owner.id
        ? owner
        : await db.query.accountOwners.findFirst({
            where: eq(accountOwners.id, quoteTarget.accountId),
          });
    quoteState = localQuoteTargetOwner == null ? "pending" : "accepted";
  }
  await db.transaction(async (tx) => {
    let poll: Poll | null = null;
    if (data.poll != null) {
      const expires = new Date(Date.now() + data.poll.expires_in * 1000);
      [poll] = await tx
        .insert(polls)
        .values({
          id: uuidv7(),
          multiple: data.poll.multiple,
          expires,
        })
        .returning();
      await tx.insert(pollOptions).values(
        data.poll.options.map(
          (title, index) =>
            ({
              pollId: poll!.id,
              index,
              title,
            }) satisfies NewPollOption,
        ),
      );
    }
    const insertedRows = await tx
      .insert(posts)
      .values({
        id,
        iri: url.href,
        type: poll == null ? "Note" : "Question",
        accountId: owner.id,
        applicationId: token.applicationId,
        replyTargetId: data.in_reply_to_id,
        quoteTargetId,
        quoteTargetIri: quoteTarget?.iri ?? null,
        quoteState,
        quoteApprovalPolicy,
        sharingId: null,
        visibility: effectiveVisibility,
        summary,
        content: data.status,
        contentHtml: content?.html,
        language: data.language ?? owner.language,
        pollId: poll == null ? null : poll.id,
        tags,
        emojis,
        sensitive: data.sensitive,
        url: url.href,
        previewCard,
        idempotenceKey: idempotencyKey,
        published: sql`CURRENT_TIMESTAMP`,
      })
      .returning();
    if (data.media_ids != null && data.media_ids.length > 0) {
      for (const mediaId of data.media_ids) {
        const result = await tx
          .update(media)
          .set({ postId: id })
          .where(and(eq(media.id, mediaId), isNull(media.postId)))
          .returning();
        if (result.length < 1) {
          tx.rollback();
          return c.json({ error: "Media not found" }, 422);
        }
      }
    }
    let mentionObjects: Mention[] = [];
    if (mentionedIds.length > 0) {
      mentionObjects = await tx
        .insert(mentions)
        .values(
          mentionedIds.map((accountId) => ({
            postId: id,
            accountId,
          })),
        )
        .returning();
    }
    if (
      quoteTargetId != null &&
      (quoteState == null || quoteState === "accepted")
    ) {
      await tx
        .update(posts)
        .set({ quotesCount: sql`coalesce(${posts.quotesCount}, 0) + 1` })
        .where(eq(posts.id, quoteTargetId));
    }
    await updateAccountStats(tx, owner);
    await appendPostToTimelines(tx, {
      ...insertedRows[0],
      sharing: null,
      mentions: mentionObjects,
      replyTarget:
        insertedRows[0].replyTargetId == null
          ? null
          : ((await db.query.posts.findFirst({
              where: eq(posts.id, insertedRows[0].replyTargetId),
            })) ?? null),
    });
  });
  const post = (await db.query.posts.findFirst({
    where: eq(posts.id, id),
    with: getPostRelations(owner.id),
  }))!;
  const activity = toCreate(post, fedCtx);
  const orderingKey = getPostOrderingKey(post.iri);
  await fedCtx.sendActivity(
    { username: handle },
    getRecipients(post),
    activity,
    {
      orderingKey,
      excludeBaseUris: [new URL(c.req.url)],
    },
  );
  if (post.visibility !== "direct") {
    await fedCtx.sendActivity({ username: handle }, "followers", activity, {
      orderingKey,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(c.req.url)],
    });
  }
  if (post.quoteState === "pending" && post.quoteTarget != null) {
    await fedCtx.sendActivity(
      { username: handle },
      {
        id: new URL(post.quoteTarget.account.iri),
        inboxId: new URL(post.quoteTarget.account.inboxUrl),
        endpoints:
          post.quoteTarget.account.sharedInboxUrl == null
            ? null
            : {
                sharedInbox: new URL(post.quoteTarget.account.sharedInboxUrl),
              },
      },
      new vocab.QuoteRequest({
        id: new URL("#quote-request", post.iri),
        actor: new URL(owner.account.iri),
        object: new URL(post.quoteTarget.iri),
        instrument: toObject(post, fedCtx),
      }),
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
  }
  return c.json(serializePost(post, owner, c.req.url));
});

app.put("/:id", tokenRequired, scopeRequired(["write:statuses"]), async (c) => {
  const token = c.get("token");
  const owner = token.accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }

  const id = c.req.param("id");
  if (!isUuid(id)) {
    return c.json({ error: "Record not found" }, 404);
  }

  const result = await requestBody(c.req, statusSchema);

  if (!result.success) {
    logger.debug("Invalid request: {error}", { error: result.error.issues });
    return c.json({ error: "invalid_request", zod_error: result.error }, 422);
  }

  const data = result.data;

  const fedCtx = federation.createContext(c.req.raw, undefined);
  const fmtOpts = {
    url: fedCtx.url,
    contextLoader: fedCtx.contextLoader,
    documentLoader: await fedCtx.getDocumentLoader({
      username: owner.handle,
    }),
  };
  const { formatPostContent } = await import("../../text");
  const content =
    data.status == null
      ? null
      : await formatPostContent(db, data.status, data.language, fmtOpts);
  const summary =
    data.spoiler_text == null || data.spoiler_text.trim() === ""
      ? null
      : data.spoiler_text;
  const hashtags = content?.hashtags ?? [];
  const tags = Object.fromEntries(
    hashtags.map((tag) => [
      tag.toLowerCase(),
      new URL(`/tags/${encodeURIComponent(tag.substring(1))}`, c.req.url).href,
    ]),
  );
  const emojis = content?.emojis ?? {};
  let previewCard: PreviewCard | null = null;
  if (content?.previewLink != null) {
    previewCard = await fetchPreviewCard(content.previewLink);
  }
  const existingPost = await db.query.posts.findFirst({
    where: and(eq(posts.id, id), eq(posts.accountId, owner.id)),
  });
  if (existingPost == null) {
    return c.json({ error: "Record not found" }, 404);
  }
  const quoteApprovalPolicy = normalizeQuoteApprovalPolicy(
    data.quote_approval_policy ?? existingPost.quoteApprovalPolicy,
    existingPost.visibility,
  );
  await db.transaction(async (tx) => {
    const result = await tx
      .update(posts)
      .set({
        content: data.status,
        contentHtml: content?.html,
        sensitive: data.sensitive,
        summary,
        language: data.language ?? owner.language,
        tags,
        emojis,
        previewCard,
        quoteApprovalPolicy,
        updated: new Date(),
      })
      .where(and(eq(posts.id, id), eq(posts.accountId, owner.id)))
      .returning();
    if (result.length < 1) return c.json({ error: "Record not found" }, 404);
    await tx.delete(mentions).where(eq(mentions.postId, id));
    const mentionedIds = content?.mentions ?? [];
    if (mentionedIds.length > 0) {
      await tx.insert(mentions).values(
        mentionedIds.map((accountId) => ({
          postId: id,
          accountId,
        })),
      );
    }
  });
  const post = await db.query.posts.findFirst({
    where: eq(posts.id, id),
    with: getPostRelations(owner.id),
  });
  const activity = toUpdate(post!, fedCtx);
  const orderingKey = getPostOrderingKey(post!.iri);
  await fedCtx.sendActivity(
    { username: owner.handle },
    getRecipients(post!),
    activity,
    {
      orderingKey,
      excludeBaseUris: [new URL(c.req.url)],
    },
  );
  await fedCtx.sendActivity({ username: owner.handle }, "followers", activity, {
    orderingKey,
    preferSharedInbox: true,
    excludeBaseUris: [new URL(c.req.url)],
  });
  return c.json(serializePost(post!, owner, c.req.url));
});

const interactionPolicySchema = z.object({
  quote_approval_policy: quoteApprovalPolicySchema,
});

app.put(
  "/:id/interaction_policy",
  tokenRequired,
  scopeRequired(["write:statuses"]),
  async (c) => {
    const token = c.get("token");
    const owner = token.accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "Record not found" }, 404);

    const result = await requestBody(c.req, interactionPolicySchema);
    if (!result.success) {
      logger.debug("Invalid request: {error}", { error: result.error.issues });
      return c.json({ error: "invalid_request", zod_error: result.error }, 422);
    }

    const post = await db.query.posts.findFirst({
      where: and(eq(posts.id, id), eq(posts.accountId, owner.id)),
    });
    if (post == null) return c.json({ error: "Record not found" }, 404);

    const quoteApprovalPolicy = normalizeQuoteApprovalPolicy(
      result.data.quote_approval_policy,
      post.visibility,
    );
    await db
      .update(posts)
      .set({ quoteApprovalPolicy, updated: new Date() })
      .where(and(eq(posts.id, id), eq(posts.accountId, owner.id)));

    const updatedPost = await db.query.posts.findFirst({
      where: eq(posts.id, id),
      with: getPostRelations(owner.id),
    });
    if (updatedPost == null) return c.json({ error: "Record not found" }, 404);

    const fedCtx = federation.createContext(c.req.raw, undefined);
    const activity = toUpdate(updatedPost, fedCtx);
    const orderingKey = getPostOrderingKey(updatedPost.iri);
    await fedCtx.sendActivity(
      { username: owner.handle },
      getRecipients(updatedPost),
      activity,
      {
        orderingKey,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
    await fedCtx.sendActivity(
      { username: owner.handle },
      "followers",
      activity,
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
    return c.json(serializePost(updatedPost, owner, c.req.url));
  },
);

app.get("/:id", async (c) => {
  const token = await getAccessToken(c);
  const owner =
    token?.scopes.includes("read:statuses") || token?.scopes.includes("read")
      ? token?.accountOwner
      : null;
  const id = c.req.param("id");

  if (!isUuid(id)) return c.json({ error: "Record not found" }, 404);

  const visibilityScope = await getPostVisibilityScope(owner?.id);
  const post = await db.query.posts.findFirst({
    where: and(
      eq(posts.id, id),
      buildPostVisibilityConditions(visibilityScope),
    ),
    with: getPostRelations(owner?.id),
  });

  if (post == null) return c.json({ error: "Record not found" }, 404);
  return c.json(serializePost(post, owner, c.req.url));
});

app.delete(
  "/:id",
  tokenRequired,
  scopeRequired(["write:statuses"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "Record not found" }, 404);
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, id),
      with: getPostRelations(owner.id),
    });
    if (post == null) return c.json({ error: "Record not found" }, 404);
    await db.transaction(async (tx) => {
      await tx.delete(posts).where(eq(posts.id, id));
      if (
        post.quoteTargetId != null &&
        (post.quoteState == null || post.quoteState === "accepted")
      ) {
        await tx
          .update(posts)
          .set({
            quotesCount: sql`GREATEST(coalesce(${posts.quotesCount}, 0) - 1, 0)`,
          })
          .where(eq(posts.id, post.quoteTargetId));
      }
      await updateAccountStats(tx, owner);
    });
    const fedCtx = federation.createContext(c.req.raw, undefined);
    const activity = toDelete(post, fedCtx);
    const orderingKey = getPostOrderingKey(post.iri);
    await fedCtx.sendActivity(
      { username: owner.handle },
      getRecipients(post),
      activity,
      {
        orderingKey,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
    if (post.visibility !== "direct") {
      await fedCtx.sendActivity(
        { username: owner.handle },
        "followers",
        activity,
        {
          orderingKey,
          preferSharedInbox: true,
          excludeBaseUris: [new URL(c.req.url)],
        },
      );
    }
    return c.json({
      ...serializePost(post, owner, c.req.url),
      text: post.content ?? "",
      spoiler_text: post.summary ?? "",
    });
  },
);

app.get(
  "/:id/source",
  tokenRequired,
  scopeRequired(["read:statuses"]),
  async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "Record not found" }, 404);
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, id),
    });
    if (post == null) return c.json({ error: "Record not found" }, 404);
    return c.json({
      id: post.id,
      text: post.content ?? "",
      spoiler_text: post.summary ?? "",
    });
  },
);

app.get("/:id/context", async (c) => {
  const token = await getAccessToken(c);
  const owner =
    token?.scopes.includes("read:statuses") || token?.scopes.includes("read")
      ? token?.accountOwner
      : null;
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "Record not found" }, 404);

  const visibilityScope = await getPostVisibilityScope(owner?.id);
  const post = await db.query.posts.findFirst({
    where: and(
      eq(posts.id, id),
      buildPostVisibilityConditions(visibilityScope),
    ),
    with: getPostRelations(owner?.id),
  });
  if (post == null) return c.json({ error: "Record not found" }, 404);
  const ancestors: (typeof post)[] = [];
  let p: typeof post | undefined = post;
  while (p.replyTargetId != null) {
    p = await db.query.posts.findFirst({
      where: and(
        eq(posts.id, p.replyTargetId),
        buildPostVisibilityConditions(visibilityScope),
        buildMuteAndBlockConditions(owner?.id),
      ),
      with: getPostRelations(owner?.id),
    });
    if (p == null) break;
    ancestors.unshift(p);
  }
  const descendants: (typeof post)[] = [];
  const ps: (typeof post)[] = [post];
  while (true) {
    const p = ps.shift();
    if (p == null) break;
    const replies = await db.query.posts.findMany({
      where: and(
        eq(posts.replyTargetId, p.id),
        buildPostVisibilityConditions(visibilityScope),
        buildMuteAndBlockConditions(owner?.id),
      ),
      with: getPostRelations(owner?.id),
    });
    descendants.push(...replies);
    ps.push(...replies);
  }
  return c.json({
    ancestors: ancestors.map((p) => serializePost(p, owner, c.req.url)),
    descendants: descendants.map((p) => serializePost(p, owner, c.req.url)),
  });
});

app.post(
  "/:id/favourite",
  tokenRequired,
  scopeRequired(["write:favourites"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const postId = c.req.param("id");
    if (!isUuid(postId)) return c.json({ error: "Record not found" }, 404);
    let like: Like;
    try {
      const result = await db
        .insert(likes)
        .values({
          postId,
          accountId: owner.id,
        } as NewLike)
        .returning();
      like = result[0];
    } catch (_) {
      return c.json({ error: "Record not found" }, 404);
    }
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
      with: getPostRelations(owner.id),
    });
    if (post == null) {
      return c.json({ error: "Record not found" }, 404);
    }
    const fedCtx = federation.createContext(c.req.raw, undefined);
    const orderingKey = getLikeOrderingKey(owner.account.iri, post.iri);
    await fedCtx.sendActivity(
      { username: owner.handle },
      {
        id: new URL(post.account.iri),
        inboxId: new URL(post.account.inboxUrl),
      },
      new vocab.Like({
        id: new URL(`#likes/${like.created.toISOString()}`, owner.account.iri),
        actor: new URL(owner.account.iri),
        object: new URL(post.iri),
      }),
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
    return c.json(serializePost(post, owner, c.req.url));
  },
);

app.post(
  "/:id/unfavourite",
  tokenRequired,
  scopeRequired(["write:favourites"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const postId = c.req.param("id");
    if (!isUuid(postId)) return c.json({ error: "Record not found" }, 404);
    const result = await db
      .delete(likes)
      .where(and(eq(likes.postId, postId), eq(likes.accountId, owner.id)))
      .returning();
    if (result.length < 1) return c.json({ error: "Record not found" }, 404);
    const like = result[0];
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
      with: getPostRelations(owner.id),
    });
    if (post == null) {
      return c.json({ error: "Record not found" }, 404);
    }
    const fedCtx = federation.createContext(c.req.raw, undefined);
    const orderingKey = getLikeOrderingKey(owner.account.iri, post.iri);
    await fedCtx.sendActivity(
      { username: owner.handle },
      {
        id: new URL(post.account.iri),
        inboxId: new URL(post.account.inboxUrl),
      },
      new vocab.Undo({
        actor: new URL(owner.account.iri),
        object: new vocab.Like({
          id: new URL(
            `#likes/${like.created.toISOString()}`,
            owner.account.iri,
          ),
          actor: new URL(owner.account.iri),
          object: new URL(post.iri),
        }),
      }),
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
    return c.json(serializePost(post, owner, c.req.url));
  },
);

app.get(
  "/:id/favourited_by",
  tokenRequired,
  scopeRequired(["read:statuses"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "Record not found" }, 404);
    const likeList = await db.query.likes.findMany({
      where: eq(likes.postId, id),
      with: { account: { with: { owner: true, successor: true } } },
    });
    return c.json(
      likeList.map((l) =>
        l.account.owner == null
          ? serializeAccount(l.account, c.req.url)
          : serializeAccountOwner(
              { ...l.account.owner, account: l.account },
              c.req.url,
            ),
      ),
    );
  },
);

const reblogSchema = z.object({
  visibility: z.enum(["public", "unlisted", "private"]).default("public"),
});

app.post(
  "/:id/reblog",
  tokenRequired,
  scopeRequired(["write:statuses"]),
  async (c) => {
    const token = c.get("token");
    const owner = token.accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const originalPostId = c.req.param("id");
    if (!isUuid(originalPostId)) {
      return c.json({ error: "Record not found" }, 404);
    }
    const contentType = c.req.header("Content-Type");
    let data: z.infer<typeof reblogSchema>;
    if (contentType?.match(/^application\/json(\s*;|$)/)) {
      data = reblogSchema.parse(await c.req.json());
    } else if (contentType === "application/x-www-form-urlencoded") {
      data = reblogSchema.parse(await c.req.formData());
    } else if (contentType == null) {
      data = { visibility: "public" };
    } else {
      return c.json({ error: "Unsupported Media Type" }, 415);
    }
    const visibility = data.visibility;
    const originalPost = await db.query.posts.findFirst({
      where: eq(posts.id, originalPostId),
      with: { account: true, mentions: true },
    });
    if (
      originalPost == null ||
      originalPost.visibility === "private" ||
      originalPost.visibility === "direct"
    ) {
      return c.json({ error: "Record not found" }, 404);
    }
    const fedCtx = federation.createContext(c.req.raw, undefined);
    const id = uuidv7();
    const url = fedCtx.getObjectUri(Note, { username: owner.handle, id });
    const published = new Date();
    await db.transaction(async (tx) => {
      const insertedRows = await tx
        .insert(posts)
        .values({
          ...originalPost,
          id,
          iri: url.href,
          accountId: owner.id,
          applicationId: token.applicationId,
          replyTargetId: null,
          sharingId: originalPostId,
          visibility,
          url: url.href,
          published,
          updated: published,
        } satisfies NewPost)
        .returning();
      await tx
        .update(posts)
        .set({ sharesCount: sql`coalesce(${posts.sharesCount}, 0) + 1` })
        .where(eq(posts.id, originalPostId));
      await appendPostToTimelines(tx, {
        ...insertedRows[0],
        sharing: originalPost,
        mentions: [],
        replyTarget: null,
      });
    });
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, id),
      with: getPostRelations(owner.id),
    });
    const orderingKey = getPostOrderingKey(post!.iri);
    await fedCtx.sendActivity(
      { username: owner.handle },
      "followers",
      toAnnounce(post!, fedCtx),
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
    return c.json(serializePost(post!, owner, c.req.url));
  },
);

app.post(
  "/:id/unreblog",
  tokenRequired,
  scopeRequired(["write:statuses"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const originalPostId = c.req.param("id");
    if (!isUuid(originalPostId)) {
      return c.json({ error: "Record not found" }, 404);
    }
    const postList = await db.query.posts.findMany({
      where: and(
        eq(posts.accountId, owner.id),
        eq(posts.sharingId, originalPostId),
      ),
      with: {
        account: true,
        sharing: {
          with: { account: true },
        },
      },
    });
    if (postList.length < 1) return c.json({ error: "Record not found" }, 404);
    await db
      .delete(posts)
      .where(
        and(eq(posts.accountId, owner.id), eq(posts.sharingId, originalPostId)),
      );
    await db
      .update(posts)
      .set({
        sharesCount: sql`coalesce(${posts.sharesCount} - ${postList.length}, 0)`,
      })
      .where(eq(posts.id, originalPostId));
    const fedCtx = federation.createContext(c.req.raw, undefined);
    for (const post of postList) {
      const orderingKey = getPostOrderingKey(post.iri);
      await fedCtx.sendActivity(
        { username: owner.handle },
        "followers",
        new Undo({
          actor: new URL(owner.account.iri),
          object: toAnnounce(post, fedCtx),
        }),
        {
          orderingKey,
          preferSharedInbox: true,
          excludeBaseUris: [new URL(c.req.url)],
        },
      );
    }
    const originalPost = await db.query.posts.findFirst({
      where: eq(posts.id, originalPostId),
      with: getPostRelations(owner.id),
    });
    return c.json(serializePost(originalPost!, owner, c.req.url));
  },
);

app.get(
  "/:id/reblogged_by",
  tokenRequired,
  scopeRequired(["read:statuses"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "Record not found" }, 404);
    const post = await db.query.posts.findFirst({
      with: {
        shares: {
          with: {
            account: {
              with: {
                owner: true,
                successor: true,
              },
            },
          },
        },
      },
      where: eq(posts.id, id),
    });
    if (post == null) return c.json({ error: "Record not found" }, 404);
    return c.json(
      post.shares.map((s) =>
        s.account.owner == null
          ? serializeAccount(s.account, c.req.url)
          : serializeAccountOwner(
              { ...s.account.owner, account: s.account },
              c.req.url,
            ),
      ),
    );
  },
);

app.post(
  "/:id/bookmark",
  tokenRequired,
  scopeRequired(["write:bookmarks"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const postId = c.req.param("id");
    if (!isUuid(postId)) return c.json({ error: "Record not found" }, 404);
    try {
      await db.insert(bookmarks).values({
        postId,
        accountOwnerId: owner.id,
      } satisfies NewBookmark);
    } catch (_) {
      return c.json({ error: "Record not found" }, 404);
    }
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
      with: getPostRelations(owner.id),
    });
    return c.json(serializePost(post!, owner, c.req.url));
  },
);

app.post(
  "/:id/unbookmark",
  tokenRequired,
  scopeRequired(["write:bookmarks"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const postId = c.req.param("id");
    if (!isUuid(postId)) return c.json({ error: "Record not found" }, 404);
    const result = await db
      .delete(bookmarks)
      .where(
        and(
          eq(bookmarks.postId, postId),
          eq(bookmarks.accountOwnerId, owner.id),
        ),
      )
      .returning();
    if (result.length < 1) {
      return c.json({ error: "Record not found" }, 404);
    }
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
      with: getPostRelations(owner.id),
    });
    return c.json(serializePost(post!, owner, c.req.url));
  },
);

app.post(
  "/:id/pin",
  tokenRequired,
  scopeRequired(["write:accounts"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const postId = c.req.param("id");
    if (!isUuid(postId)) return c.json({ error: "Record not found" }, 404);
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
    });
    if (post == null) {
      return c.json({ error: "Record not found" }, 404);
    }
    if (post.accountId !== owner.id) {
      return c.json(
        { error: "Validation failed: Someone else's post cannot be pinned" },
        422,
      );
    }
    const result = await db
      .insert(pinnedPosts)
      .values({
        postId,
        accountId: owner.id,
      } satisfies NewPinnedPost)
      .returning();
    const fedCtx = federation.createContext(c.req.raw, undefined);
    const orderingKey = getPostOrderingKey(post.iri);
    await fedCtx.sendActivity(
      { username: owner.handle },
      "followers",
      new Add({
        id: new URL(
          `#add/${result[0].index}`,
          fedCtx.getFeaturedUri(owner.handle),
        ),
        actor: new URL(owner.account.iri),
        object: new URL(post.iri),
        target: fedCtx.getFeaturedUri(owner.handle),
      }),
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
    const resultPost = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
      with: getPostRelations(owner.id),
    });
    return c.json(serializePost(resultPost!, owner, c.req.url));
  },
);

app.post(
  "/:id/unpin",
  tokenRequired,
  scopeRequired(["write:accounts"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const postId = c.req.param("id");
    if (!isUuid(postId)) return c.json({ error: "Record not found" }, 404);
    const result = await db
      .delete(pinnedPosts)
      .where(
        and(
          eq(pinnedPosts.postId, postId),
          eq(pinnedPosts.accountId, owner.id),
        ),
      )
      .returning();
    if (result.length < 1) {
      return c.json({ error: "Record not found" }, 404);
    }
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
      with: getPostRelations(owner.id),
    });
    const fedCtx = federation.createContext(c.req.raw, undefined);
    const orderingKey = getPostOrderingKey(post!.iri);
    await fedCtx.sendActivity(
      { username: owner.handle },
      "followers",
      new Remove({
        id: new URL(
          `#remove/${result[0].index}`,
          fedCtx.getFeaturedUri(owner.handle),
        ),
        actor: new URL(owner.account.iri),
        object: new URL(post!.iri),
        target: fedCtx.getFeaturedUri(owner.handle),
      }),
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(c.req.url)],
      },
    );
    return c.json(serializePost(post!, owner, c.req.url));
  },
);

async function addEmojiReaction(
  c: Context<{ Variables: Variables }, "/:id/emoji_reactions/:emoji">,
): Promise<Response | TypedResponse> {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const postId = c.req.param("id");
  if (!isUuid(postId)) return c.json({ error: "Record not found" }, 404);
  let emoji = c.req.param("emoji");
  const url = new URL(c.req.url);
  if (emoji.endsWith(`@${url.host}`)) emoji = emoji.replace(/@[^@]+$/, "");
  let emojiCode = "";
  let tag: Emoji | null = null;
  if (emoji.includes("@")) {
    // In case of using a remote custom emoji:
    const [shortcode, domain] = emoji.split("@", 2);
    const reactionList = await db.query.reactions.findMany({
      with: { account: true },
      where: and(
        eq(reactions.postId, postId),
        eq(reactions.emoji, `:${shortcode}:`),
        isNotNull(reactions.customEmoji),
        isNotNull(reactions.emojiIri),
      ),
    });
    for (const reaction of reactionList) {
      if (
        reaction.customEmoji == null ||
        reaction.emojiIri == null ||
        !reaction.account.handle.endsWith(`@${domain}`)
      ) {
        continue;
      }
      await db.insert(reactions).values({
        ...reaction,
        accountId: owner.id,
      });
      emojiCode = reaction.emoji;
      tag = new Emoji({
        id: new URL(reaction.emojiIri),
        name: emojiCode,
        icon: new Image({
          url: new URL(reaction.customEmoji),
        }),
      });
      break;
    }
    if (emojiCode === "") return c.notFound();
  } else {
    const customEmoji = await db.query.customEmojis.findFirst({
      where: eq(customEmojis.shortcode, emoji),
    });
    if (customEmoji == null) {
      if (!/^[\p{Emoji}]+$/u.test(emoji)) return c.notFound();
      // Unicode emoji:
      await db.insert(reactions).values({
        postId,
        accountId: owner.id,
        emoji,
        customEmoji: null,
      });
      emojiCode = emoji;
    } else {
      // Local custom emoji:
      emojiCode = `:${emoji}:`;
      const emojiIri = fedCtx.getObjectUri(Emoji, { shortcode: emoji });
      await db.insert(reactions).values({
        postId,
        accountId: owner.id,
        emoji: emojiCode,
        customEmoji: customEmoji.url,
        emojiIri: emojiIri.href,
      });
      tag = new Emoji({
        id: emojiIri,
        name: emojiCode,
        icon: new Image({
          url: new URL(customEmoji.url),
        }),
      });
    }
  }
  const post = await db.query.posts.findFirst({
    where: eq(posts.id, postId),
    with: getPostRelations(owner.id),
  });
  if (post == null) return c.notFound();
  const activity = new EmojiReact({
    id: new URL(`/#react/${owner.id}/${postId}/${emoji}`, url),
    actor: fedCtx.getActorUri(owner.handle),
    tos: [new URL(post.account.iri), fedCtx.getFollowersUri(owner.handle)],
    cc: PUBLIC_COLLECTION,
    object: new URL(post.iri),
    content: emojiCode,
    tags: tag == null ? [] : [tag],
  });
  const orderingKey = getReactionOrderingKey(
    owner.account.iri,
    post.iri,
    emojiCode,
  );
  await fedCtx.sendActivity({ username: owner.handle }, "followers", activity, {
    orderingKey,
    preferSharedInbox: true,
    excludeBaseUris: [new URL(c.req.url)],
  });
  await fedCtx.sendActivity(
    { username: owner.handle },
    {
      id: new URL(post.account.iri),
      inboxId: new URL(post.account.inboxUrl),
      endpoints:
        post.account.sharedInboxUrl == null
          ? null
          : {
              sharedInbox: new URL(post.account.sharedInboxUrl),
            },
    },
    activity,
    {
      orderingKey,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(c.req.url)],
    },
  );
  return c.json(serializePost(post, owner, c.req.url));
}

app.put(
  "/:id/emoji_reactions/:emoji",
  tokenRequired,
  scopeRequired(["write:favourites"]),
  addEmojiReaction,
);

app.post(
  "/:id/react/:emoji",
  tokenRequired,
  scopeRequired(["write:favourites"]),
  addEmojiReaction,
);

async function removeEmojiReaction(
  c: Context<{ Variables: Variables }, "/:id/emoji_reactions/:emoji">,
): Promise<Response | TypedResponse> {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const fedCtx = federation.createContext(c.req.raw, undefined);
  const postId = c.req.param("id");
  if (!isUuid(postId)) return c.json({ error: "Record not found" }, 404);
  let emoji = c.req.param("emoji");
  const url = new URL(c.req.url);
  if (emoji.endsWith(`@${url.host}`)) emoji = emoji.replace(/@[^@]+$/, "");
  const unicode = /^[\p{Emoji}]+$/u.test(emoji);
  const deleted = await db
    .delete(reactions)
    .where(
      and(
        eq(reactions.postId, postId),
        eq(reactions.accountId, owner.id),
        eq(reactions.emoji, unicode ? emoji : `:${emoji}:`),
      ),
    )
    .returning();
  if (deleted.length < 1) return c.notFound();
  const [reaction] = deleted;
  const post = await db.query.posts.findFirst({
    where: eq(posts.id, postId),
    with: getPostRelations(owner.id),
  });
  if (post == null) return c.notFound();
  const activity = new Undo({
    id: new URL(`/#react/undo/${owner.id}/${postId}/${emoji}`, url),
    actor: fedCtx.getActorUri(owner.handle),
    tos: [new URL(post.account.iri), fedCtx.getFollowersUri(owner.handle)],
    cc: PUBLIC_COLLECTION,
    object: new EmojiReact({
      id: new URL(`/#react/${owner.id}/${postId}/${emoji}`, url),
      actor: fedCtx.getActorUri(owner.handle),
      tos: [new URL(post.account.iri), fedCtx.getFollowersUri(owner.handle)],
      cc: PUBLIC_COLLECTION,
      object: new URL(post.iri),
      content: reaction.emoji,
      tags:
        reaction.emojiIri == null || reaction.customEmoji == null
          ? []
          : [
              new Emoji({
                id: new URL(reaction.emojiIri),
                name: reaction.emoji,
                icon: new Image({
                  url: new URL(reaction.customEmoji),
                }),
              }),
            ],
    }),
  });
  const orderingKey = getReactionOrderingKey(
    owner.account.iri,
    post.iri,
    reaction.emoji,
  );
  await fedCtx.sendActivity({ username: owner.handle }, "followers", activity, {
    orderingKey,
    preferSharedInbox: true,
    excludeBaseUris: [new URL(c.req.url)],
  });
  await fedCtx.sendActivity(
    { username: owner.handle },
    {
      id: new URL(post.account.iri),
      inboxId: new URL(post.account.inboxUrl),
      endpoints:
        post.account.sharedInboxUrl == null
          ? null
          : {
              sharedInbox: new URL(post.account.sharedInboxUrl),
            },
    },
    activity,
    {
      orderingKey,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(c.req.url)],
    },
  );
  return c.json(serializePost(post, owner, c.req.url));
}

app.delete(
  "/:id/emoji_reactions/:emoji",
  tokenRequired,
  scopeRequired(["write:favourites"]),
  removeEmojiReaction,
);

app.post(
  "/:id/unreact/:emoji",
  tokenRequired,
  scopeRequired(["write:favourites"]),
  removeEmojiReaction,
);

const quotesQuerySchema = z.object({
  max_id: uuid.optional(),
  since_id: uuid.optional(),
  limit: z
    .string()
    .default("20")
    .transform((v) => Math.min(Number.parseInt(v, 10), 40)),
});

app.get("/:id/quotes", async (c) => {
  const token = await getAccessToken(c);
  const owner =
    token?.scopes.includes("read:statuses") || token?.scopes.includes("read")
      ? token?.accountOwner
      : null;
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "Record not found" }, 404);

  const visibilityScope = await getPostVisibilityScope(owner?.id);
  const post = await db.query.posts.findFirst({
    where: and(
      eq(posts.id, id),
      buildPostVisibilityConditions(visibilityScope),
    ),
  });
  if (post == null) return c.json({ error: "Record not found" }, 404);

  const url = new URL(c.req.url);
  const queryResult = quotesQuerySchema.safeParse(
    Object.fromEntries(url.searchParams),
  );
  if (!queryResult.success) {
    return c.json({ error: "Invalid query parameters" }, 400);
  }
  const query = queryResult.data;

  const quotes = await db.query.posts.findMany({
    where: and(
      eq(posts.quoteTargetId, id),
      or(eq(posts.quoteState, "accepted"), isNull(posts.quoteState)),
      isNull(posts.sharingId),
      buildPostVisibilityConditions(visibilityScope),
      buildMuteAndBlockConditions(owner?.id),
      query.max_id != null ? lt(posts.id, query.max_id) : undefined,
      query.since_id != null ? gt(posts.id, query.since_id) : undefined,
    ),
    with: getPostRelations(owner?.id),
    orderBy: [desc(posts.id)],
    limit: query.limit,
  });

  const nextMaxId =
    quotes.length >= query.limit ? quotes[quotes.length - 1].id : null;
  const nextLink = nextMaxId == null ? undefined : new URL(c.req.url);
  nextLink?.searchParams.set("max_id", nextMaxId ?? "");
  return c.json(
    quotes.map((p) => serializePost(p, owner, c.req.url)),
    200,
    nextLink == null ? undefined : { Link: `<${nextLink.href}>; rel="next"` },
  );
});

app.post(
  "/:id/quotes/:quoting_status_id/revoke",
  tokenRequired,
  scopeRequired(["write:statuses"]),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const id = c.req.param("id");
    const quotingStatusId = c.req.param("quoting_status_id");
    if (!isUuid(id) || !isUuid(quotingStatusId)) {
      return c.json({ error: "Record not found" }, 404);
    }

    const targetPost = await db.query.posts.findFirst({
      where: eq(posts.id, id),
    });
    if (targetPost == null) {
      return c.json({ error: "Record not found" }, 404);
    }
    if (targetPost.accountId !== owner.id) {
      return c.json({ error: "This status is not yours" }, 403);
    }

    const quotingPost = await db.query.posts.findFirst({
      where: and(eq(posts.id, quotingStatusId), eq(posts.quoteTargetId, id)),
    });
    if (quotingPost == null) {
      return c.json({ error: "Record not found" }, 404);
    }

    await db.transaction(async (tx) => {
      await tx
        .update(posts)
        .set({
          quoteState: "revoked",
          quoteTargetIri: quotingPost.quoteTargetIri ?? targetPost.iri,
          quoteAuthorizationIri: null,
          updated: new Date(),
        })
        .where(eq(posts.id, quotingStatusId));
      if (
        quotingPost.quoteState == null ||
        quotingPost.quoteState === "accepted"
      ) {
        await tx
          .update(posts)
          .set({
            quotesCount: sql`GREATEST(coalesce(${posts.quotesCount}, 0) - 1, 0)`,
          })
          .where(eq(posts.id, id));
      }
    });

    const updatedPost = await db.query.posts.findFirst({
      where: eq(posts.id, quotingStatusId),
      with: getPostRelations(owner.id),
    });
    if (updatedPost == null) {
      return c.json({ error: "Record not found" }, 404);
    }
    return c.json(serializePost(updatedPost, owner, c.req.url));
  },
);

export default app;
