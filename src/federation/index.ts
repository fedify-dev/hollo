import {
  Accept,
  Activity,
  Add,
  Announce,
  Block,
  Create,
  Delete,
  EmojiReact,
  Follow,
  isActor,
  Like,
  Move,
  Note,
  Reject,
  Remove,
  Undo,
  Update,
} from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { accounts, follows } from "../schema";
import { updateAccountStats } from "./account";
import "./actor";
import { federation } from "./federation";

export { federation } from "./federation";

import {
  onAccountDeleted,
  onAccountMoved,
  onAccountUpdated,
  onBlocked,
  onEmojiReactionAdded,
  onEmojiReactionRemoved,
  onFollowAccepted,
  onFollowed,
  onFollowRejected,
  onLiked,
  onPostCreated,
  onPostDeleted,
  onPostPinned,
  onPostShared,
  onPostUnpinned,
  onPostUnshared,
  onPostUpdated,
  onUnblocked,
  onUnfollowed,
  onUnliked,
  onVoted,
} from "./inbox";
import "./nodeinfo";
import "./objects";
import { isPost } from "./post";

const inboxLogger = getLogger(["hollo", "federation", "inbox"]);

federation
  .setInboxListeners("/@{identifier}/inbox", "/inbox")
  .setSharedKeyDispatcher(async (_) => {
    const anyOwner = await db.query.accountOwners.findFirst();
    return anyOwner ?? null;
  })
  .on(Follow, onFollowed)
  .on(Accept, onFollowAccepted)
  .on(Reject, onFollowRejected)
  .on(Create, async (ctx, create) => {
    const object = await create.getObject();
    if (
      object instanceof Note &&
      object.replyTargetId != null &&
      object.attributionId != null &&
      object.name != null
    ) {
      await onVoted(ctx, create);
    } else if (isPost(object)) {
      await onPostCreated(ctx, create);
    } else {
      inboxLogger.debug("Unsupported object on Create: {object}", { object });
    }
  })
  .on(Like, onLiked)
  .on(EmojiReact, onEmojiReactionAdded)
  .on(Announce, async (ctx, announce) => {
    const object = await announce.getObject();
    if (isPost(object)) {
      await onPostShared(ctx, announce);
    } else {
      inboxLogger.debug("Unsupported object on Announce: {object}", { object });
    }
  })
  .on(Update, async (ctx, update) => {
    const object = await update.getObject();
    if (isActor(object)) {
      await onAccountUpdated(ctx, update);
    } else if (isPost(object)) {
      await onPostUpdated(ctx, update);
    } else {
      inboxLogger.debug("Unsupported object on Update: {object}", { object });
    }
  })
  .on(Delete, async (ctx, del) => {
    const actorId = del.actorId;
    const objectId = del.objectId;
    if (actorId == null || objectId == null) return;
    if (objectId.href === actorId.href) {
      await onAccountDeleted(ctx, del);
    } else {
      await onPostDeleted(ctx, del);
    }
  })
  .on(Add, onPostPinned)
  .on(Remove, onPostUnpinned)
  .on(Block, onBlocked)
  .on(Move, onAccountMoved)
  .on(Undo, async (ctx, undo) => {
    const object = await undo.getObject({ crossOrigin: "trust" });
    if (
      object instanceof Activity &&
      object.actorId?.href !== undo.actorId?.href
    ) {
      return;
    }
    if (object instanceof Follow) {
      await onUnfollowed(ctx, undo);
    } else if (object instanceof Block) {
      await onUnblocked(ctx, undo);
    } else if (object instanceof Like) {
      await onUnliked(ctx, undo);
    } else if (object instanceof EmojiReact) {
      await onEmojiReactionRemoved(ctx, undo);
    } else if (object instanceof Announce) {
      await onPostUnshared(ctx, undo);
    } else {
      inboxLogger.debug("Unsupported object on Undo: {object}", { object });
    }
  });

const outboxLogger = getLogger(["hollo", "federation", "outbox"]);

export async function onOutboxPermanentFailure(
  statusCode: number,
  actorIds: readonly URL[],
  inbox: URL,
): Promise<void> {
  outboxLogger.warning(
    "Permanent delivery failure to inbox {inbox} " +
      "(HTTP {statusCode}): cleaning up associated records",
    { inbox: inbox.href, statusCode },
  );

  for (const actorId of actorIds) {
    if (statusCode === 410) {
      // 410 Gone: the actor is permanently gone — delete the account record.
      // ON DELETE CASCADE will clean up follows, mentions, likes, etc.
      // Before deleting, collect affected local account IDs for stat updates.
      const affectedFollowings = await db
        .select({ followingId: follows.followingId })
        .from(follows)
        .innerJoin(accounts, eq(follows.followerId, accounts.id))
        .where(eq(accounts.iri, actorId.href));
      const affectedFollowers = await db
        .select({ followerId: follows.followerId })
        .from(follows)
        .innerJoin(accounts, eq(follows.followingId, accounts.id))
        .where(eq(accounts.iri, actorId.href));
      await db.delete(accounts).where(eq(accounts.iri, actorId.href));
      for (const { followingId } of affectedFollowings) {
        await updateAccountStats(db, { id: followingId });
      }
      for (const { followerId } of affectedFollowers) {
        await updateAccountStats(db, { id: followerId });
      }
      outboxLogger.info("Deleted account {actorId} due to 410 Gone", {
        actorId: actorId.href,
      });
    } else {
      // 404 etc.: only the inbox is gone — remove incoming follower
      // relationships to stop future delivery attempts.
      const account = await db.query.accounts.findFirst({
        where: eq(accounts.iri, actorId.href),
      });
      if (account == null) continue;
      const deleted = await db
        .delete(follows)
        .where(eq(follows.followerId, account.id))
        .returning({ followingId: follows.followingId });
      for (const { followingId } of deleted) {
        await updateAccountStats(db, { id: followingId });
      }
      outboxLogger.info(
        "Removed {count} follow(s) for actor {actorId} " +
          "due to HTTP {statusCode}",
        {
          count: deleted.length,
          actorId: actorId.href,
          statusCode,
        },
      );
    }
  }
}

federation.setOutboxPermanentFailureHandler(async (_ctx, values) => {
  await onOutboxPermanentFailure(
    values.statusCode,
    values.actorIds,
    values.inbox,
  );
});

export default federation;
