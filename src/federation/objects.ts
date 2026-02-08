import { Emoji, Flag, Note } from "@fedify/vocab";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "../db";
import {
  accountOwners,
  accounts,
  customEmojis,
  follows,
  pollOptions,
  posts,
  reports,
} from "../schema";
import { isUuid } from "../uuid";
import { toEmoji } from "./emoji";
import { federation } from "./federation";
import { toObject } from "./post";

federation.setObjectDispatcher(
  Note,
  "/@{username}/{id}",
  async (ctx, values) => {
    if (!values.id?.match(/^[-a-f0-9]+$/)) return null;
    const owner = await db.query.accountOwners.findFirst({
      where: like(accountOwners.handle, values.username),
      with: { account: true },
    });
    if (owner == null) return null;
    if (!isUuid(values.id)) return null;
    const post = await db.query.posts.findFirst({
      where: and(
        eq(posts.id, values.id),
        eq(posts.accountId, owner.account.id),
      ),
      with: {
        account: { with: { owner: true } },
        replyTarget: true,
        quoteTarget: true,
        media: true,
        poll: { with: { options: { orderBy: pollOptions.index } } },
        mentions: { with: { account: true } },
        replies: true,
      },
    });
    if (post == null) return null;
    if (post.visibility === "private") {
      const keyOwner = await ctx.getSignedKeyOwner();
      if (keyOwner?.id == null) return null;
      const found = await db.query.follows.findFirst({
        where: and(
          inArray(
            follows.followerId,
            db
              .select({ id: accounts.id })
              .from(accounts)
              .where(eq(accounts.iri, keyOwner.id.href)),
          ),
          eq(follows.followingId, owner.id),
        ),
      });
      if (found == null) return null;
    } else if (post.visibility === "direct") {
      const keyOwner = await ctx.getSignedKeyOwner();
      const keyOwnerId = keyOwner?.id;
      if (keyOwnerId == null) return null;
      const found = post.mentions.some(
        (m) => m.account.iri === keyOwnerId.href,
      );
      if (!found) return null;
    }
    return toObject(post, ctx);
  },
);

federation.setObjectDispatcher(
  Emoji,
  "/emojis/:{shortcode}:",
  async (ctx, { shortcode }) => {
    const emoji = await db.query.customEmojis.findFirst({
      where: eq(customEmojis.shortcode, shortcode),
    });
    if (emoji == null) return null;
    return toEmoji(ctx, emoji);
  },
);

federation.setObjectDispatcher(Flag, "/reports/{id}", async (ctx, { id }) => {
  if (!isUuid(id)) return null;
  const report = await db.query.reports.findFirst({
    where: eq(reports.id, id),
    with: {
      account: {
        columns: { iri: true },
      },
      targetAccount: {
        columns: {
          iri: true,
        },
      },
    },
  });

  if (report == null) return null;

  // Perform some access control on fetching a Flag activity
  const keyOwner = await ctx.getSignedKeyOwner();
  const keyOwnerId = keyOwner?.id;
  if (keyOwnerId == null) return null;

  // compare the keyOwner who signed the request with the targetAccount
  // Note: this won't work if it's the instance actor doing the fetch and not the targetAccount:
  if (keyOwnerId.href !== report.targetAccount.iri) {
    return null;
  }

  // Fetch the posts for the Flag activity:
  let targetPosts: { iri: string }[] = [];
  if (report.posts.length > 0) {
    targetPosts = await db.query.posts.findMany({
      where: and(
        inArray(posts.id, report.posts),
        eq(posts.accountId, report.targetAccountId),
      ),
      columns: {
        iri: true,
      },
    });
  }

  return new Flag({
    id: new URL(report.iri),
    actor: new URL(report.account.iri),
    // For Mastodon compatibility, objects must include the target account IRI along with the posts:
    objects: targetPosts
      .map((post) => new URL(post.iri))
      .concat(new URL(report.targetAccount.iri)),
    content: report.comment,
  });
});
