import { importJwk } from "@fedify/fedify";
import {
  Emoji,
  Endpoints,
  getActorClassByTypeName,
  Hashtag,
  Image,
  Like,
  PropertyValue,
} from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { and, count, desc, eq, ilike, inArray, isNotNull } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { db } from "../db";
import {
  accountOwners,
  accounts,
  follows,
  likes,
  pinnedPosts,
  pollOptions,
  posts,
} from "../schema";
import { toTemporalInstant } from "./date";
import { federation } from "./federation";
import { toAnnounce, toCreate, toObject } from "./post";

federation
  .setActorDispatcher("/@{identifier}", async (ctx, identifier) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, identifier),
      with: { account: { with: { successor: true } } },
    });
    if (owner == null) return null;
    const account = owner.account;
    const cls = getActorClassByTypeName(account.type);
    return new cls({
      id: new URL(account.iri),
      name: account.name,
      preferredUsername: identifier,
      summary: account.bioHtml,
      url: account.url ? new URL(account.url) : null,
      manuallyApprovesFollowers: account.protected,
      icon: account.avatarUrl
        ? new Image({ url: new URL(account.avatarUrl) })
        : null,
      image: account.coverUrl
        ? new Image({ url: new URL(account.coverUrl) })
        : null,
      published: account.published
        ? toTemporalInstant(account.published)
        : null,
      publicKey: (await ctx.getActorKeyPairs(identifier))[0].cryptographicKey,
      assertionMethods: (await ctx.getActorKeyPairs(identifier)).map(
        (pair) => pair.multikey,
      ),
      followers: ctx.getFollowersUri(identifier),
      following: ctx.getFollowingUri(identifier),
      outbox: ctx.getOutboxUri(identifier),
      liked: ctx.getLikedUri(identifier),
      featured: ctx.getFeaturedUri(identifier),
      featuredTags: ctx.getFeaturedTagsUri(identifier),
      inbox: ctx.getInboxUri(identifier),
      endpoints: new Endpoints({
        sharedInbox: ctx.getInboxUri(),
      }),
      successor:
        account.successor == null ? null : new URL(account.successor.iri),
      aliases: uniq(account.aliases).map((a) => new URL(a)),
      attachments: Object.entries(account.fieldHtmls).map(
        ([name, value]) =>
          new PropertyValue({
            name,
            value,
          }),
      ),
      tags: Object.entries(account.emojis).map(
        ([shortcode, url]) =>
          new Emoji({
            id: ctx.getObjectUri(Emoji, { shortcode }),
            name: `:${shortcode.replace(/^:|:$/g, "")}:`,
            icon: new Image({ url: new URL(url) }),
          }),
      ),
      discoverable: owner.discoverable,
    });
  })
  .mapHandle((_, handle) => handle)
  .setKeyPairsDispatcher(async (_ctx, identifier) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, identifier),
    });
    if (owner == null) return [];
    return [
      {
        privateKey: await importJwk(owner.rsaPrivateKeyJwk, "private"),
        publicKey: await importJwk(owner.rsaPublicKeyJwk, "public"),
      },
      {
        privateKey: await importJwk(owner.ed25519PrivateKeyJwk, "private"),
        publicKey: await importJwk(owner.ed25519PublicKeyJwk, "public"),
      },
    ];
  });

const followersLogger = getLogger(["hollo", "federation", "followers"]);

federation
  .setFollowersDispatcher(
    "/@{identifier}/followers",
    async (_ctx, identifier, cursor, filter) => {
      const owner = await db.query.accountOwners.findFirst({
        where: eq(accountOwners.handle, identifier),
      });
      if (owner == null) return null;
      followersLogger.debug(
        "Gathering followers for {identifier} with cursor {cursor} and filter {filter}...",
        { identifier, cursor, filter },
      );
      const offset = cursor == null ? undefined : Number.parseInt(cursor, 10);
      if (offset != null && !Number.isInteger(offset)) return null;
      const followers = await db.query.accounts.findMany({
        where: and(
          inArray(
            accounts.id,
            db
              .select({ id: follows.followerId })
              .from(follows)
              .where(
                and(
                  eq(follows.followingId, owner.id),
                  isNotNull(follows.approved),
                ),
              ),
          ),
          filter == null
            ? undefined
            : ilike(accounts.iri, `${filter.origin}/%`),
        ),
        offset,
        orderBy: accounts.id,
        limit: offset == null ? undefined : 41,
      });
      const items = offset == null ? followers : followers.slice(0, 40);
      const result = {
        items: items.map((f) => ({
          id: new URL(f.iri),
          inboxId: new URL(f.inboxUrl),
          endpoints: {
            sharedInbox: f.sharedInboxUrl ? new URL(f.sharedInboxUrl) : null,
          },
        })),
        nextCursor:
          offset != null && followers.length > 40 ? `${offset + 40}` : null,
      };
      followersLogger.debug(
        "Gathered {followers} followers for {identifier} with cursor {cursor} and filter {filter}.",
        { followers: result.items.length, identifier, cursor, filter },
      );
      return result;
    },
  )
  .setFirstCursor(async (_ctx, _identifier) => "0")
  .setCounter(async (_ctx, identifier) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, identifier),
      with: { account: true },
    });
    return owner == null ? 0 : owner.account.followersCount;
  });

federation
  .setFollowingDispatcher(
    "/@{identifier}/following",
    async (_ctx, identifier, cursor) => {
      const owner = await db.query.accountOwners.findFirst({
        where: eq(accountOwners.handle, identifier),
      });
      if (owner == null || cursor == null) return null;
      const offset = Number.parseInt(cursor, 10);
      if (!Number.isInteger(offset)) return null;
      const following = await db.query.accounts.findMany({
        where: inArray(
          accounts.id,
          db
            .select({ id: follows.followingId })
            .from(follows)
            .where(
              and(
                eq(follows.followerId, owner.id),
                isNotNull(follows.approved),
              ),
            ),
        ),
        offset,
        orderBy: accounts.id,
        limit: 41,
      });
      return {
        items: following.slice(0, 40).map((f) => new URL(f.iri)),
        nextCursor: following.length > 40 ? `${offset + 40}` : null,
      };
    },
  )
  .setFirstCursor(async (_ctx, _identifier) => "0")
  .setCounter(async (_ctx, identifier) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, identifier),
      with: { account: true },
    });
    return owner == null ? 0 : owner.account.followingCount;
  });

federation
  .setOutboxDispatcher(
    "/@{identifier}/outbox",
    async (ctx, identifier, cursor) => {
      if (cursor == null) return null;
      const owner = await db.query.accountOwners.findFirst({
        where: eq(accountOwners.handle, identifier),
      });
      if (owner == null) return null;
      const items = await db.query.posts.findMany({
        where: and(
          eq(posts.accountId, owner.id),
          inArray(posts.visibility, ["public", "unlisted"]),
        ),
        orderBy: desc(posts.published),
        offset: Number.parseInt(cursor, 10),
        limit: 41,
        with: {
          account: { with: { owner: true } },
          replyTarget: true,
          quoteTarget: true,
          media: true,
          poll: { with: { options: true } },
          mentions: { with: { account: true } },
          sharing: { with: { account: true } },
          replies: true,
        },
      });
      return {
        items: items
          .slice(0, 40)
          .map((p) =>
            p.sharing == null ? toCreate(p, ctx) : toAnnounce(p, ctx),
          ),
        nextCursor:
          items.length > 40 ? `${Number.parseInt(cursor, 10) + 40}` : null,
      };
    },
  )
  .setFirstCursor(async (_ctx, _identifier) => "0")
  .setCounter(async (_ctx, identifier) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, identifier),
    });
    if (owner == null) return null;
    const result = await db
      .select({ cnt: count() })
      .from(posts)
      .where(
        and(
          eq(posts.accountId, owner.id),
          inArray(posts.visibility, ["public", "unlisted"]),
        ),
      );
    if (result.length < 1) return 0;
    return result[0].cnt;
  });

federation
  .setLikedDispatcher(
    "/@{identifier}/liked",
    async (_ctx, identifier, cursor) => {
      if (cursor == null) return null;
      const owner = await db.query.accountOwners.findFirst({
        where: eq(accountOwners.handle, identifier),
        with: { account: true },
      });
      if (owner == null) return null;
      const items = await db.query.likes.findMany({
        where: eq(likes.accountId, owner.id),
        orderBy: desc(likes.created),
        offset: Number.parseInt(cursor, 10),
        limit: 41,
        with: { post: true },
      });
      return {
        items: items.slice(0, 40).map(
          (like) =>
            new Like({
              id: new URL(
                `#likes/${like.created.toISOString()}`,
                owner.account.iri,
              ),
              actor: new URL(owner.account.iri),
              object: new URL(like.post.iri),
            }),
        ),
        nextCursor:
          items.length > 40 ? `${Number.parseInt(cursor, 10) + 40}` : null,
      };
    },
  )
  .setFirstCursor(async (_ctx, _identifier) => "0")
  .setCounter(async (_ctx, identifier) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, identifier),
    });
    if (owner == null) return null;
    const result = await db
      .select({ cnt: count() })
      .from(likes)
      .where(eq(likes.accountId, owner.id));
    if (result.length < 1) return 0;
    return result[0].cnt;
  });

federation.setFeaturedDispatcher(
  "/@{identifier}/pinned",
  async (ctx, identifier) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, identifier),
      with: { account: true },
    });
    if (owner == null) return null;
    const items = await db.query.pinnedPosts.findMany({
      where: eq(pinnedPosts.accountId, owner.id),
      orderBy: desc(pinnedPosts.index),
      with: {
        post: {
          with: {
            account: { with: { owner: true } },
            replyTarget: true,
            quoteTarget: true,
            media: true,
            poll: { with: { options: { orderBy: pollOptions.index } } },
            mentions: { with: { account: true } },
            replies: true,
          },
        },
      },
    });
    return {
      items: items
        .map((p) => p.post)
        .filter((p) => p.visibility === "public" || p.visibility === "unlisted")
        .map((p) => toObject(p, ctx)),
    };
  },
);

federation.setFeaturedTagsDispatcher(
  "/@{identifier}/tags",
  async (ctx, identifier) => {
    const owner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.handle, identifier),
      with: { account: true, featuredTags: true },
    });
    if (owner == null) return null;
    const items = owner.featuredTags.map(
      (tag) =>
        new Hashtag({
          name: `#${tag.name}`,
          href: new URL(`/tags/${tag.name}?handle=${owner.handle}`, ctx.url),
        }),
    );
    return { items };
  },
);
