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
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { db } from "../db";
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
    const object = await undo.getObject();
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

export default federation;
