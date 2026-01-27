import {
  Accept,
  type Add,
  Announce,
  Article,
  Block,
  ChatMessage,
  type Create,
  type Delete,
  Emoji,
  EmojiReact,
  Follow,
  Image,
  type InboxContext,
  isActor,
  Like,
  Link,
  type Move,
  Note,
  Question,
  type Reject,
  type Remove,
  type Undo,
  type Update,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  createEmojiReactionNotification,
  createFavouriteNotification,
  createFollowNotification,
  createFollowRequestNotification,
  createMentionNotifications,
  createQuotedUpdateNotifications,
  createQuoteNotification,
  createReblogNotification,
  createStatusNotification,
} from "../notification";
import {
  accountOwners,
  accounts,
  blocks,
  follows,
  likes,
  type NewLike,
  type NewPinnedPost,
  pinnedPosts,
  pollOptions,
  posts,
  reactions,
} from "../schema";
import { isUuid } from "../uuid";
import {
  persistAccount,
  REFRESH_ACTORS_ON_INTERACTION,
  refreshActorIfStale,
  removeFollower,
  unfollowAccount,
  updateAccountStats,
} from "./account";
import {
  isPost,
  persistPollVote,
  persistPost,
  persistSharingPost,
  toUpdate,
  updatePostStats,
} from "./post";

const inboxLogger = getLogger(["hollo", "inbox"]);

export async function onAccountUpdated(
  ctx: InboxContext<void>,
  update: Update,
): Promise<void> {
  const object = await update.getObject();
  if (!isActor(object)) return;
  await persistAccount(db, object, ctx.origin, ctx);
}

export async function onAccountDeleted(
  _ctx: InboxContext<void>,
  del: Delete,
): Promise<void> {
  const actorId = del.actorId;
  const objectId = del.objectId;
  if (actorId == null || objectId == null) return;
  if (objectId.href !== actorId.href) return;
  await db.delete(accounts).where(eq(accounts.iri, actorId.href));
}

export async function onFollowed(
  ctx: InboxContext<void>,
  follow: Follow,
): Promise<void> {
  if (follow.id == null) return;
  const actor = await follow.getActor();
  if (!isActor(actor) || actor.id == null) {
    inboxLogger.debug("Invalid actor: {actor}", { actor });
    return;
  }
  const object = await follow.getObject();
  if (!isActor(object) || object.id == null) {
    inboxLogger.debug("Invalid object: {object}", { object });
    return;
  }
  const following = await db.query.accounts.findFirst({
    where: eq(accounts.iri, object.id.href),
    with: { owner: true },
  });
  if (following?.owner == null) {
    inboxLogger.debug("Invalid following: {following}", { following });
    return;
  }
  const follower = await persistAccount(db, actor, ctx.origin, ctx);
  if (follower == null) return;
  let approves = !following.protected;
  if (approves) {
    const block = await db.query.blocks.findFirst({
      where: and(
        eq(blocks.accountId, following.id),
        eq(blocks.blockedAccountId, follower.id),
      ),
    });
    approves = block == null;
  }
  await db
    .insert(follows)
    .values({
      iri: follow.id.href,
      followingId: following.id,
      followerId: follower.id,
      approved: approves ? new Date() : null,
    })
    .onConflictDoNothing();
  if (approves) {
    await ctx.sendActivity(
      { username: following.owner.handle },
      actor,
      new Accept({
        id: new URL(
          `#accepts/${follower.iri}`,
          ctx.getActorUri(following.owner.handle),
        ),
        actor: object.id,
        object: follow,
      }),
      { excludeBaseUris: [new URL(ctx.origin)] },
    );
    await updateAccountStats(db, { id: following.id });
    // Create follow notification
    await createFollowNotification(follower, following.owner);
  } else {
    // Create follow request notification for protected accounts
    await createFollowRequestNotification(follower, following.owner);
  }
}

export async function onUnfollowed(
  ctx: InboxContext<void>,
  undo: Undo,
): Promise<void> {
  const object = await undo.getObject({ crossOrigin: "trust" });
  if (!(object instanceof Follow)) return;
  if (object.actorId?.href !== undo.actorId?.href || object.id == null) return;
  const actor = await undo.getActor();
  if (!isActor(actor) || actor.id == null) {
    inboxLogger.debug("Invalid actor: {actor}", { actor });
    return;
  }
  const account = await persistAccount(db, actor, ctx.origin, ctx);
  if (account == null) return;
  const deleted = await db
    .delete(follows)
    .where(
      and(eq(follows.iri, object.id.href), eq(follows.followerId, account.id)),
    )
    .returning({ followingId: follows.followingId });
  if (deleted.length > 0) {
    await updateAccountStats(db, { id: deleted[0].followingId });
  }
}

export async function onFollowAccepted(
  ctx: InboxContext<void>,
  accept: Accept,
): Promise<void> {
  const actor = await accept.getActor();
  if (!isActor(actor) || actor.id == null) {
    inboxLogger.debug("Invalid actor: {actor}", { actor });
    return;
  }
  const account = await persistAccount(db, actor, ctx.origin, ctx);
  if (account == null) return;
  if (accept.objectId != null) {
    const updated = await db
      .update(follows)
      .set({ approved: new Date() })
      .where(
        and(
          eq(follows.iri, accept.objectId.href),
          eq(follows.followingId, account.id),
        ),
      )
      .returning();
    if (updated.length > 0) {
      await updateAccountStats(db, { id: updated[0].followerId });
      return;
    }
  }
  const object = await accept.getObject({ crossOrigin: "trust" });
  if (object instanceof Follow) {
    if (object.actorId == null) return;
    await db
      .update(follows)
      .set({ approved: new Date() })
      .where(
        and(
          eq(
            follows.followerId,
            db
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.iri, object.actorId.href)),
          ),
          eq(follows.followingId, account.id),
        ),
      );
    await updateAccountStats(db, { iri: object.actorId.href });
  }
}

export async function onFollowRejected(
  ctx: InboxContext<void>,
  reject: Reject,
): Promise<void> {
  const actor = await reject.getActor();
  if (!isActor(actor) || actor.id == null) {
    inboxLogger.debug("Invalid actor: {actor}", { actor });
    return;
  }
  const account = await persistAccount(db, actor, ctx.origin, ctx);
  if (account == null) return;
  if (reject.objectId != null) {
    const deleted = await db
      .delete(follows)
      .where(
        and(
          eq(follows.iri, reject.objectId.href),
          eq(follows.followingId, account.id),
        ),
      )
      .returning();
    if (deleted.length > 0) {
      await updateAccountStats(db, { id: deleted[0].followerId });
      return;
    }
  }
  const object = await reject.getObject({ crossOrigin: "trust" });
  if (object instanceof Follow) {
    if (object.actorId == null) return;
    await db
      .delete(follows)
      .where(
        and(
          eq(
            follows.followerId,
            db
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.iri, object.actorId.href)),
          ),
          eq(follows.followingId, account.id),
        ),
      );
    await updateAccountStats(db, { iri: object.actorId.href });
  }
}

export async function onBlocked(
  ctx: InboxContext<void>,
  block: Block,
): Promise<void> {
  const blocker = await block.getActor();
  if (blocker == null) return;
  const object = ctx.parseUri(block.objectId);
  if (block.objectId == null || object?.type !== "actor") return;
  const blocked = await db.query.accountOwners.findFirst({
    with: { account: true },
    where: eq(accountOwners.handle, object.identifier),
  });
  if (blocked == null) return;
  const blockerAccount = await persistAccount(db, blocker, ctx.origin, ctx);
  if (blockerAccount == null) return;
  const result = await db
    .insert(blocks)
    .values({
      accountId: blockerAccount.id,
      blockedAccountId: blocked.id,
    })
    .onConflictDoNothing()
    .returning();
  if (result.length < 1) return;
  await unfollowAccount(
    db,
    ctx,
    { ...blocked.account, owner: blocked },
    blockerAccount,
  );
  await removeFollower(
    db,
    ctx,
    { ...blocked.account, owner: blocked },
    blockerAccount,
  );
}

export async function onUnblocked(
  ctx: InboxContext<void>,
  undo: Undo,
): Promise<void> {
  const object = await undo.getObject({ crossOrigin: "trust" });
  if (
    !(object instanceof Block) ||
    undo.actorId?.href !== object.actorId?.href
  ) {
    return;
  }
  const actor = await undo.getActor();
  if (actor == null) return;
  const blocker = await persistAccount(db, actor, ctx.origin, ctx);
  if (blocker == null) return;
  const target = ctx.parseUri(object.objectId);
  if (target?.type !== "actor") return;
  await db
    .delete(blocks)
    .where(
      and(
        eq(blocks.accountId, blocker.id),
        eq(
          blocks.blockedAccountId,
          db
            .select({ accountId: accountOwners.id })
            .from(accountOwners)
            .where(eq(accountOwners.handle, target.identifier)),
        ),
      ),
    );
}

export async function onPostCreated(
  ctx: InboxContext<void>,
  create: Create,
): Promise<void> {
  const object = await create.getObject();
  if (!isPost(object)) return;
  const post = await db.transaction(async (tx) => {
    const post = await persistPost(tx, object, ctx.origin, ctx);
    if (post?.replyTargetId != null) {
      await updatePostStats(tx, { id: post.replyTargetId });
    }
    return post;
  });

  // Refresh actor if stale (fire-and-forget)
  if (post?.account != null) {
    refreshActorIfStale(db, post.account, ctx.origin, ctx);
  }

  // Create status notification for reply target author (if this is a reply)
  // and mention notifications for other mentioned local users
  if (post != null) {
    let replyTargetAuthorId: typeof post.accountId | null = null;

    // If this is a reply, create a "status" notification for the original post author
    if (post.replyTargetId != null) {
      const replyTarget = await db.query.posts.findFirst({
        where: eq(posts.id, post.replyTargetId),
        with: {
          account: { with: { owner: true } },
        },
      });

      if (replyTarget != null) {
        replyTargetAuthorId = replyTarget.accountId;

        // Create status notification for the reply target author
        await createStatusNotification(post.account, post, replyTarget);
      }
    }

    // Create mention notifications for mentioned local users
    // Skip the reply target author since they already got a "status" notification
    if (post.mentions.length > 0) {
      const mentionedAccountsWithOwners = await db.query.accounts.findMany({
        where: inArray(
          accounts.id,
          post.mentions.map((m) => m.accountId),
        ),
        with: { owner: true },
      });

      await createMentionNotifications(
        post,
        mentionedAccountsWithOwners,
        replyTargetAuthorId,
      );
    }

    // Create quote notification if this post quotes another post
    if (post.quoteTargetId != null) {
      const quoteTarget = await db.query.posts.findFirst({
        where: eq(posts.id, post.quoteTargetId),
        with: {
          account: { with: { owner: true } },
        },
      });

      if (quoteTarget != null) {
        await createQuoteNotification(post.account, post, quoteTarget);
      }
    }
  }

  if (
    post?.replyTargetId != null &&
    (post.visibility === "public" || post.visibility === "unlisted")
  ) {
    const replyTarget = await db.query.posts.findFirst({
      where: eq(posts.id, post.replyTargetId),
      with: {
        account: { with: { owner: true } },
        replyTarget: true,
        quoteTarget: true,
        media: true,
        poll: { with: { options: true } },
        mentions: { with: { account: true } },
        replies: true,
      },
    });
    if (replyTarget?.account.owner != null) {
      await ctx.forwardActivity(
        { username: replyTarget.account.owner.handle },
        "followers",
        {
          skipIfUnsigned: true,
          preferSharedInbox: true,
          excludeBaseUris: [new URL(ctx.origin)],
        },
      );
      await ctx.sendActivity(
        { username: replyTarget.account.owner.handle },
        "followers",
        toUpdate(replyTarget, ctx),
        { preferSharedInbox: true, excludeBaseUris: [new URL(ctx.origin)] },
      );
    }
  }
}

export async function onPostUpdated(
  ctx: InboxContext<void>,
  update: Update,
): Promise<void> {
  const object = await update.getObject();
  if (!isPost(object)) return;

  // Get post ID before update to find quote posts
  const existingPost = object.id
    ? await db.query.posts.findFirst({
        where: eq(posts.iri, object.id.href),
      })
    : null;

  // Persist the updated post
  await persistPost(db, object, ctx.origin, ctx);

  // Create quoted_update notifications for users who quoted this post
  if (existingPost != null) {
    const quotePosts = await db.query.posts.findMany({
      where: eq(posts.quoteTargetId, existingPost.id),
      with: {
        account: { with: { owner: true } },
      },
    });

    if (quotePosts.length > 0) {
      const quoteAuthors = quotePosts.map((qp) => qp.account);
      await createQuotedUpdateNotifications(existingPost, quoteAuthors);
    }
  }
}

export async function onPostDeleted(
  _ctx: InboxContext<void>,
  del: Delete,
): Promise<void> {
  const actorId = del.actorId;
  const objectId = del.objectId;
  if (actorId == null || objectId == null) return;
  await db.transaction(async (tx) => {
    const deletedPosts = await tx
      .delete(posts)
      .where(eq(posts.iri, objectId.href))
      .returning();
    if (deletedPosts.length > 0) {
      const deletedPost = deletedPosts[0];
      if (deletedPost.replyTargetId != null) {
        await updatePostStats(tx, { id: deletedPost.replyTargetId });
      }
      if (deletedPost.sharingId != null) {
        await updatePostStats(tx, { id: deletedPost.sharingId });
      }
    }
  });
}

export async function onPostShared(
  ctx: InboxContext<void>,
  announce: Announce,
): Promise<void> {
  const object = await announce.getObject();
  if (!isPost(object)) return;
  const post = await db.transaction(async (tx) => {
    const post = await persistSharingPost(
      tx,
      announce,
      object,
      ctx.origin,
      ctx,
    );
    if (post?.sharingId != null) {
      await updatePostStats(tx, { id: post.sharingId });
    }
    return post;
  });
  // Refresh actor if stale (fire-and-forget)
  if (post?.account != null) {
    refreshActorIfStale(db, post.account, ctx.origin, ctx);
  }
  if (post?.sharing?.account?.owner != null) {
    await ctx.forwardActivity(
      { username: post.sharing.account.owner.handle },
      "followers",
      { skipIfUnsigned: true },
    );
  }
  // Create reblog notification
  if (post?.sharing != null && post.account != null) {
    await createReblogNotification(post.account, post.sharing);
  }
}

export async function onPostUnshared(
  ctx: InboxContext<void>,
  undo: Undo,
): Promise<void> {
  const object = await undo.getObject({ crossOrigin: "trust" });
  if (!(object instanceof Announce)) return;
  if (object.actorId?.href !== undo.actorId?.href) return;
  const sharer = object.actorId;
  const originalPost = object.objectId;
  if (sharer == null || originalPost == null) return;
  const original = await db.transaction(async (tx) => {
    const original = await tx.query.posts.findFirst({
      with: {
        account: { with: { owner: true } },
      },
      where: eq(posts.iri, originalPost.href),
    });
    if (original == null) return null;
    const deleted = await tx
      .delete(posts)
      .where(
        and(
          eq(
            posts.accountId,
            db
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.iri, sharer.href)),
          ),
          eq(posts.sharingId, original.id),
        ),
      )
      .returning();
    if (deleted.length > 0 && deleted[0].sharingId != null) {
      await updatePostStats(tx, { id: deleted[0].sharingId });
    }
    return original;
  });
  if (original?.account.owner != null) {
    await ctx.forwardActivity(
      { username: original.account.owner.handle },
      "followers",
      { skipIfUnsigned: true },
    );
  }
}

export async function onPostPinned(
  ctx: InboxContext<void>,
  add: Add,
): Promise<void> {
  if (add.targetId == null) return;
  const object = await add.getObject();
  if (!isPost(object)) return;
  const accountList = await db.query.accounts.findMany({
    where: eq(accounts.featuredUrl, add.targetId.href),
  });
  await db.transaction(async (tx) => {
    const post = await persistPost(tx, object, ctx.origin, ctx);
    if (post == null) return;
    for (const account of accountList) {
      await tx.insert(pinnedPosts).values({
        postId: post.id,
        accountId: account.id,
      } satisfies NewPinnedPost);
    }
  });
}

export async function onPostUnpinned(
  ctx: InboxContext<void>,
  remove: Remove,
): Promise<void> {
  if (remove.targetId == null) return;
  const object = await remove.getObject();
  if (!isPost(object)) return;
  const accountList = await db.query.accounts.findMany({
    where: eq(accounts.featuredUrl, remove.targetId.href),
  });
  await db.transaction(async (tx) => {
    const post = await persistPost(tx, object, ctx.origin, ctx);
    if (post == null) return;
    for (const account of accountList) {
      await tx
        .delete(pinnedPosts)
        .where(
          and(
            eq(pinnedPosts.postId, post.id),
            eq(pinnedPosts.accountId, account.id),
          ),
        );
    }
  });
}

export async function onLiked(
  ctx: InboxContext<void>,
  like: Like,
): Promise<void> {
  if (like.content != null) {
    await onEmojiReactionAdded(ctx, like);
    return;
  }
  if (like.objectId == null) return;
  const parsed = ctx.parseUri(like.objectId);
  if (parsed == null) return;
  const { type } = parsed;
  if (
    type === "object" &&
    (parsed.class === Note ||
      parsed.class === Article ||
      parsed.class === Question ||
      parsed.class === ChatMessage)
  ) {
    const actor = await like.getActor();
    if (actor == null) return;
    const account = await persistAccount(db, actor, ctx.origin, ctx);
    if (account == null) return;
    // Refresh actor if stale (fire-and-forget) when interaction refresh is enabled
    if (REFRESH_ACTORS_ON_INTERACTION) {
      refreshActorIfStale(db, account, ctx.origin, ctx);
    }
    // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
    const postId = parsed.values["id"];
    if (!isUuid(postId)) return;
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
      with: { account: { with: { owner: true } } },
    });
    if (post == null) return;
    await db.transaction(async (tx) => {
      await tx
        .insert(likes)
        .values({ postId, accountId: account.id } satisfies NewLike);
      await updatePostStats(tx, { id: postId });
    });
    await ctx.forwardActivity(
      // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
      { username: parsed.values["username"] },
      "followers",
      { skipIfUnsigned: true },
    );
    // Create favourite notification
    await createFavouriteNotification(account, post);
  } else {
    inboxLogger.debug("Unsupported object on Like: {objectId}", {
      objectId: like.objectId?.href,
    });
  }
}

export async function onUnliked(
  ctx: InboxContext<void>,
  undo: Undo,
): Promise<void> {
  const object = await undo.getObject({ crossOrigin: "trust" });
  if (
    !(object instanceof Like) ||
    object.actorId?.href !== undo.actorId?.href
  ) {
    return;
  }
  const like = object;
  if (like.content != null) {
    await onEmojiReactionRemoved(ctx, undo);
    return;
  }
  if (like.objectId == null) return;
  const parsed = ctx.parseUri(like.objectId);
  if (parsed == null) return;
  const { type } = parsed;
  if (
    type === "object" &&
    (parsed.class === Note ||
      parsed.class === Article ||
      parsed.class === Question ||
      parsed.class === ChatMessage)
  ) {
    const actor = await like.getActor();
    if (actor == null) return;
    const account = await persistAccount(db, actor, ctx.origin, ctx);
    if (account == null) return;
    // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
    const postId = parsed.values["id"];
    if (!isUuid(postId)) return;
    await db.transaction(async (tx) => {
      await tx
        .delete(likes)
        .where(and(eq(likes.postId, postId), eq(likes.accountId, account.id)));
      await updatePostStats(tx, { id: postId });
    });
    await ctx.forwardActivity(
      // biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
      { username: parsed.values["username"] },
      "followers",
      { skipIfUnsigned: true },
    );
  } else {
    inboxLogger.debug("Unsupported object on Undo<Like>: {objectId}", {
      objectId: like.objectId?.href,
    });
  }
}

export async function onEmojiReactionAdded(
  ctx: InboxContext<void>,
  react: EmojiReact | Like,
): Promise<void> {
  if (react.content == null || react.objectId == null) return;
  const object = ctx.parseUri(react.objectId);
  if (
    object?.type !== "object" ||
    (object.class !== Note &&
      object.class !== Article &&
      object.class !== Question &&
      object.class !== ChatMessage)
  ) {
    inboxLogger.debug("Unsupported object on EmojiReact: {objectId}", {
      objectId: react.objectId?.href,
    });
    return;
  }
  const { username, id } = object.values;
  if (!isUuid(id)) return;
  const emoji = react.content.toString().trim();
  if (emoji === "") return;
  const actor = await react.getActor();
  if (actor == null) return;
  const account = await persistAccount(db, actor, ctx.origin, ctx);
  if (account == null) return;
  // Refresh actor if stale (fire-and-forget) when interaction refresh is enabled
  if (REFRESH_ACTORS_ON_INTERACTION) {
    refreshActorIfStale(db, account, ctx.origin, ctx);
  }
  let emojiIri: URL | null = null;
  let customEmoji: URL | null = null;
  if (emoji.startsWith(":") && emoji.endsWith(":")) {
    for await (const tag of react.getTags()) {
      if (
        tag.id == null ||
        !(tag instanceof Emoji) ||
        tag.name?.toString()?.trim() !== emoji
      ) {
        continue;
      }
      const icon = await tag.getIcon();
      if (!(icon instanceof Image) || icon.url == null) continue;
      customEmoji = icon.url instanceof Link ? icon.url.href : icon.url;
      emojiIri = tag.id;
      if (customEmoji != null) break;
    }
  }
  const post = await db.query.posts.findFirst({
    where: eq(posts.id, id),
    with: { account: { with: { owner: true } } },
  });
  if (post == null) return;
  await db.insert(reactions).values({
    postId: id,
    accountId: account.id,
    emoji,
    customEmoji: customEmoji?.href,
    emojiIri: emojiIri?.href,
  });
  await ctx.forwardActivity({ username }, "followers", {
    skipIfUnsigned: true,
  });
  // Create emoji reaction notification
  await createEmojiReactionNotification(account, post);
}

export async function onEmojiReactionRemoved(
  ctx: InboxContext<void>,
  undo: Undo,
): Promise<void> {
  const object = await undo.getObject({ crossOrigin: "trust" });
  if (
    !(object instanceof Like || object instanceof EmojiReact) ||
    object.actorId?.href !== undo.actorId?.href ||
    object.content == null
  ) {
    return;
  }
  const actor = await undo.getActor();
  if (actor == null) return;
  const account = await persistAccount(db, actor, ctx.origin, ctx);
  if (account == null) return;
  const post = ctx.parseUri(object.objectId);
  if (
    post?.type !== "object" ||
    (post.class !== Note &&
      post.class !== Article &&
      post.class !== Question &&
      post.class !== ChatMessage)
  ) {
    return;
  }
  const { username, id } = post.values;
  if (!isUuid(id)) return;
  await db
    .delete(reactions)
    .where(
      and(
        eq(reactions.postId, id),
        eq(reactions.accountId, account.id),
        eq(reactions.emoji, object.content.toString().trim()),
      ),
    );
  await ctx.forwardActivity({ username }, "followers", {
    skipIfUnsigned: true,
  });
}

export async function onVoted(
  ctx: InboxContext<void>,
  create: Create,
): Promise<void> {
  const object = await create.getObject();
  if (
    !(object instanceof Note) ||
    object.replyTargetId == null ||
    object.attributionId == null ||
    object.name == null
  ) {
    return;
  }
  const vote = await db.transaction((tx) =>
    persistPollVote(tx, object, ctx.origin, ctx),
  );
  if (vote == null) return;
  const post = await db.query.posts.findFirst({
    with: {
      account: { with: { owner: true } },
      replyTarget: true,
      quoteTarget: true,
      media: true,
      poll: {
        with: {
          options: { orderBy: pollOptions.index },
          votes: { with: { account: true } },
        },
      },
      mentions: { with: { account: true } },
      replies: true,
    },
    where: eq(posts.pollId, vote.pollId),
  });
  if (post?.account.owner == null || post.poll == null) return;
  await ctx.sendActivity(
    { username: post.account.owner.handle },
    post.poll.votes.map((v) => ({
      id: new URL(v.account.iri),
      inboxId: new URL(v.account.inboxUrl),
      endpoints:
        v.account.sharedInboxUrl == null
          ? null
          : {
              sharedInbox: new URL(v.account.sharedInboxUrl),
            },
    })),
    toUpdate(post, ctx),
    { preferSharedInbox: true, excludeBaseUris: [new URL(ctx.origin)] },
  );
}

export async function onAccountMoved(
  ctx: InboxContext<void>,
  move: Move,
): Promise<void> {
  if (
    move.objectId == null ||
    move.targetId == null ||
    move.actorId?.href !== move.objectId.href
  ) {
    return;
  }
  const object = await move.getObject();
  if (!isActor(object)) return;
  const obj = await persistAccount(db, object, ctx.origin, ctx);
  if (obj == null) return;
  const target = await move.getTarget();
  if (
    !isActor(target) ||
    target.aliasIds.every((a) => a.href !== object.id?.href)
  ) {
    return;
  }
  const tgt = await persistAccount(db, target, ctx.origin, ctx);
  if (tgt == null) return;
  const followers = await db.query.follows.findMany({
    with: { follower: { with: { owner: true } } },
    where: eq(follows.followingId, obj.id),
  });
  for (const follower of followers) {
    if (follower.follower.owner == null) continue;
    const result = await db
      .insert(follows)
      .values({
        iri: new URL(`#follows/${crypto.randomUUID()}`, follower.follower.iri)
          .href,
        followingId: tgt.id,
        followerId: follower.followerId,
        shares: follower.shares,
        notify: follower.notify,
        languages: follower.languages,
        approved: tgt.owner == null || tgt.protected ? null : new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (tgt.owner != null || result.length < 1) continue;
    await ctx.sendActivity(
      { username: follower.follower.owner.handle },
      target,
      new Follow({
        id: new URL(result[0].iri),
        actor: new URL(follower.follower.iri),
        object: new URL(tgt.iri),
      }),
      { excludeBaseUris: [new URL(ctx.origin)] },
    );
  }
}
