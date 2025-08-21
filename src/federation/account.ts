import {
  type Actor,
  Announce,
  Block,
  type Context,
  Create,
  type DocumentLoader,
  Emoji,
  Follow,
  formatSemVer,
  getActorHandle,
  getActorTypeName,
  getNodeInfo,
  isActor,
  Link,
  lookupObject,
  PropertyValue,
  Reject,
  Undo,
} from "@fedify/fedify";
import {
  and,
  count,
  type ExtractTablesWithRelations,
  eq,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { NewPinnedPost, Post } from "../schema";
import * as schema from "../schema";
import { type Uuid, uuidv7 } from "../uuid";
import { iterateCollection } from "./collection";
import { toDate } from "./date";
import {
  isPost,
  persistPost,
  persistSharingPost,
  updatePostStats,
} from "./post";

export const REMOTE_ACTOR_FETCH_POSTS = Number.parseInt(
  // biome-ignore lint/complexity/useLiteralKeys: tsc rants about this (TS4111)
  process.env["REMOTE_ACTOR_FETCH_POSTS"] ?? "10",
  10,
);

export async function persistAccount(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  actor: Actor,
  baseUrl: string | URL,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
    skipUpdate?: boolean;
  } = {},
): Promise<(schema.Account & { owner: schema.AccountOwner | null }) | null> {
  const opts = { ...options, suppressError: true };
  if (
    actor.id == null ||
    actor.inboxId == null ||
    (actor.name == null && actor.preferredUsername == null)
  ) {
    return null;
  }
  const existingAccount = await db.query.accounts.findFirst({
    with: { owner: true },
    where: eq(schema.accounts.iri, actor.id.href),
  });
  if (options.skipUpdate && existingAccount != null) return existingAccount;
  if (existingAccount?.owner != null) return existingAccount;
  let handle: string;
  try {
    handle = await getActorHandle(actor);
  } catch (e) {
    if (e instanceof TypeError) return null;
    throw e;
  }
  const avatar = await actor.getIcon(opts);
  const cover = await actor.getImage(opts);
  const followers = await actor.getFollowers(opts);
  const successor = await actor.getSuccessor(opts);
  const successorId =
    successor == null
      ? null
      : ((
          await persistAccount(db, successor, baseUrl, {
            ...options,
            skipUpdate: true,
          })
        )?.id ?? null);
  const fieldHtmls: Record<string, string> = {};
  for await (const attachment of actor.getAttachments(opts)) {
    if (
      attachment instanceof PropertyValue &&
      attachment.name != null &&
      attachment.value != null
    ) {
      fieldHtmls[attachment.name.toString()] = attachment.value.toString();
    }
  }
  const emojis: Record<string, string> = {};
  for await (const tag of actor.getTags(opts)) {
    if (tag instanceof Emoji && tag.name != null) {
      const icon = await tag.getIcon(opts);
      if (icon?.url == null) continue;
      let href: string;
      if (icon.url instanceof Link) {
        if (icon.url.href == null) continue;
        href = icon.url.href.href;
      } else href = icon.url.href;
      emojis[tag.name.toString()] = href;
    }
  }
  const nodeInfo = await getNodeInfo(actor.id, {
    parse: "best-effort",
  });
  const instanceValues: Omit<schema.NewInstance, "host"> = {
    software: nodeInfo?.software.name ?? null,
    softwareVersion:
      nodeInfo?.software == null ||
      formatSemVer(nodeInfo.software.version) === "0.0.0"
        ? null
        : formatSemVer(nodeInfo.software.version),
  };
  await db
    .insert(schema.instances)
    .values({
      host: actor.id.host,
      ...instanceValues,
    })
    .onConflictDoUpdate({
      target: schema.instances.host,
      set: instanceValues,
    });
  const values: Omit<schema.NewAccount, "id" | "iri"> = {
    type: getActorTypeName(actor),
    name: actor?.name?.toString() ?? actor?.preferredUsername?.toString() ?? "",
    handle,
    bioHtml: actor.summary?.toString(),
    url: actor.url instanceof Link ? actor.url.href?.href : actor.url?.href,
    protected: actor.manuallyApprovesFollowers ?? false,
    avatarUrl:
      avatar?.url instanceof Link ? avatar.url.href?.href : avatar?.url?.href,
    coverUrl:
      cover?.url instanceof Link ? cover.url.href?.href : cover?.url?.href,
    inboxUrl: actor.inboxId.href,
    followersUrl: (followers?.id ?? actor?.followersId)?.href,
    sharedInboxUrl: actor.endpoints?.sharedInbox?.href,
    featuredUrl: actor.featuredId?.href,
    followingCount: (await actor.getFollowing(opts))?.totalItems ?? 0,
    followersCount: followers?.totalItems ?? 0,
    postsCount: (await actor.getOutbox(opts))?.totalItems ?? 0,
    successorId,
    aliases: actor?.aliasIds?.map((alias) => alias.href) ?? [],
    instanceHost: actor.id.host,
    fieldHtmls,
    emojis,
    published: toDate(actor.published),
  };
  await db
    .insert(schema.accounts)
    .values({
      id: uuidv7(),
      iri: actor.id.href,
      ...values,
    })
    .onConflictDoUpdate({
      target: schema.accounts.iri,
      set: values,
      setWhere: eq(schema.accounts.iri, actor.id.href),
    });
  const account = await db.query.accounts.findFirst({
    with: { owner: true },
    where: eq(schema.accounts.iri, actor.id.href),
  });
  if (account == null) return null;
  const [{ posts }] = await db
    .select({ posts: count() })
    .from(schema.posts)
    .where(eq(schema.posts.accountId, account.id));
  if (posts > 0) return account;
  const featuredCollection = await actor.getFeatured(opts);
  if (featuredCollection != null) {
    const posts: Post[] = [];
    for await (const item of iterateCollection(featuredCollection, opts)) {
      if (!isPost(item)) continue;
      const post = await persistPost(db, item, baseUrl, {
        ...options,
        account,
        skipUpdate: true,
      });
      if (post == null) continue;
      posts.unshift(post);
    }
    for (const post of posts) {
      await db
        .insert(schema.pinnedPosts)
        .values({
          postId: post.id,
          accountId: post.accountId,
        } satisfies NewPinnedPost)
        .onConflictDoNothing();
    }
  }
  return account;
}

export async function persistAccountPosts(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  account: schema.Account & { owner: schema.AccountOwner | null },
  fetchPosts: number,
  baseUrl: URL | string,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
    suppressError?: boolean;
  } = {},
): Promise<void> {
  if (fetchPosts < 1) return;
  const actor = await lookupObject(account.iri, options);
  if (!isActor(actor)) return;
  const outboxCollection = await actor.getOutbox(options);
  if (outboxCollection != null) {
    let i = 0;
    for await (const activity of iterateCollection(outboxCollection, options)) {
      if (activity instanceof Create) {
        const item = await activity.getObject(options);
        if (!isPost(item)) continue;
        const post = await persistPost(db, item, baseUrl, {
          ...options,
          account,
          skipUpdate: true,
        });
        if (post?.replyTargetId != null) i++;
      } else if (activity instanceof Announce) {
        const item = await activity.getObject(options);
        if (!isPost(item)) continue;
        await db.transaction(async (tx) => {
          const post = await persistSharingPost(tx, activity, item, baseUrl, {
            ...options,
            account,
          });
          if (post?.sharingId != null) {
            await updatePostStats(tx, { id: post.sharingId });
          }
          if (post != null) i++;
        });
      }
      if (i >= fetchPosts) break;
    }
  }
}

export async function persistAccountByIri(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  iri: string,
  baseUrl: URL | string,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<schema.Account | null> {
  const account = await db.query.accounts.findFirst({
    where: eq(schema.accounts.iri, iri),
  });
  if (account != null) return account;
  const actor = await lookupObject(iri, options);
  if (!isActor(actor) || actor.id == null) return null;
  return await persistAccount(db, actor, baseUrl, options);
}

export async function updateAccountStats(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  account: { id: Uuid } | { iri: string },
): Promise<void> {
  const id =
    "id" in account
      ? account.id
      : db
          .select({ id: schema.accounts.id })
          .from(schema.accounts)
          .where(eq(schema.accounts.iri, account.iri));
  const followingCount = db
    .select({ cnt: count() })
    .from(schema.follows)
    .where(
      and(
        eq(schema.follows.followerId, id),
        isNotNull(schema.follows.approved),
      ),
    );
  const followersCount = db
    .select({ cnt: count() })
    .from(schema.follows)
    .where(
      and(
        eq(schema.follows.followingId, id),
        isNotNull(schema.follows.approved),
      ),
    );
  const postsCount = db
    .select({ cnt: count() })
    .from(schema.posts)
    .where(eq(schema.posts.accountId, id));
  await db
    .update(schema.accounts)
    .set({
      followingCount: sql`${followingCount}`,
      followersCount: sql`${followersCount}`,
      postsCount: sql`${postsCount}`,
    })
    .where(
      and(
        "id" in account
          ? eq(schema.accounts.id, account.id)
          : eq(schema.accounts.iri, account.iri),
        inArray(
          schema.accounts.id,
          db.select({ id: schema.accountOwners.id }).from(schema.accountOwners),
        ),
      ),
    );
}

export async function followAccount(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  ctx: Context<unknown>,
  follower: schema.Account & { owner: schema.AccountOwner | null },
  following: schema.Account & { owner: schema.AccountOwner | null },
  options: {
    shares?: boolean;
    notify?: boolean;
    languages?: string[];
  } = {},
): Promise<schema.Follow | null> {
  if (follower.owner == null) {
    throw new TypeError("Only local accounts can follow other accounts");
  }
  const result = await db
    .insert(schema.follows)
    .values({
      iri: new URL(`#follows/${crypto.randomUUID()}`, follower.iri).href,
      followingId: following.id,
      followerId: follower.id,
      shares: options.shares ?? true,
      notify: options.notify ?? false,
      languages: options.languages ?? null,
      approved:
        following.owner == null || following.protected ? null : new Date(),
    } satisfies schema.NewFollow)
    .onConflictDoNothing()
    .returning();
  if (result.length < 1) return null;
  await updateAccountStats(db, follower);
  await updateAccountStats(db, following);
  const follow = result[0];
  if (following.owner == null) {
    await ctx.sendActivity(
      { username: follower.owner.handle },
      [
        {
          id: new URL(following.iri),
          inboxId: new URL(following.inboxUrl),
        },
      ],
      new Follow({
        id: new URL(follow.iri),
        actor: new URL(follower.iri),
        object: new URL(following.iri),
      }),
      { excludeBaseUris: [new URL(ctx.origin)] },
    );
  }
  return follow;
}

export async function unfollowAccount(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  ctx: Context<unknown>,
  follower: schema.Account & { owner: schema.AccountOwner | null },
  following: schema.Account & { owner: schema.AccountOwner | null },
): Promise<schema.Follow | null> {
  if (follower.owner == null) {
    throw new TypeError("Only local accounts can unfollow other accounts");
  }
  const result = await db
    .delete(schema.follows)
    .where(
      and(
        eq(schema.follows.followingId, following.id),
        eq(schema.follows.followerId, follower.id),
      ),
    )
    .returning();
  if (result.length < 1) return null;
  await updateAccountStats(db, follower);
  await updateAccountStats(db, following);
  if (following.owner == null) {
    await ctx.sendActivity(
      { username: follower.owner.handle },
      [
        {
          id: new URL(following.iri),
          inboxId: new URL(following.inboxUrl),
        },
      ],
      new Undo({
        id: new URL(`#unfollows/${crypto.randomUUID()}`, follower.iri),
        actor: new URL(follower.iri),
        object: new Follow({
          id: new URL(result[0].iri),
          actor: new URL(follower.iri),
          object: new URL(following.iri),
        }),
      }),
      { excludeBaseUris: [new URL(ctx.origin)] },
    );
  }
  return result[0];
}

export async function removeFollower(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  ctx: Context<unknown>,
  following: schema.Account & { owner: schema.AccountOwner | null },
  follower: schema.Account & { owner: schema.AccountOwner | null },
): Promise<schema.Follow | null> {
  if (following.owner == null) {
    throw new TypeError("Only local accounts can remove followers");
  }
  const result = await db
    .delete(schema.follows)
    .where(
      and(
        eq(schema.follows.followingId, following.id),
        eq(schema.follows.followerId, follower.id),
      ),
    )
    .returning();
  if (result.length < 1) return null;
  await ctx.sendActivity(
    { username: following.owner.handle },
    {
      id: new URL(follower.iri),
      inboxId: new URL(follower.inboxUrl),
      endpoints:
        follower.sharedInboxUrl == null
          ? null
          : {
              sharedInbox: new URL(follower.sharedInboxUrl),
            },
    },
    new Reject({
      id: new URL(`#reject/${crypto.randomUUID()}`, following.iri),
      actor: new URL(following.iri),
      object: new Follow({
        id: new URL(result[0].iri),
        actor: new URL(follower.iri),
        object: new URL(following.iri),
      }),
    }),
    { excludeBaseUris: [new URL(ctx.origin)] },
  );
  return result[0];
}

export async function blockAccount(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  ctx: Context<unknown>,
  blocker: schema.AccountOwner & { account: schema.Account },
  blockee: schema.Account & { owner: schema.AccountOwner | null },
): Promise<schema.Block | null> {
  const result = await db
    .insert(schema.blocks)
    .values({
      accountId: blocker.id,
      blockedAccountId: blockee.id,
    })
    .returning();
  if (result.length < 1) return null;
  if (blockee.owner == null) {
    await unfollowAccount(
      db,
      ctx,
      { ...blocker.account, owner: blocker },
      blockee,
    );
    await removeFollower(
      db,
      ctx,
      { ...blocker.account, owner: blocker },
      blockee,
    );
    await ctx.sendActivity(
      { username: blocker.handle },
      { id: new URL(blockee.iri), inboxId: new URL(blockee.inboxUrl) },
      new Block({
        id: new URL(`#block/${blockee.id}`, blocker.account.iri),
        actor: new URL(blocker.account.iri),
        object: new URL(blockee.iri),
      }),
      { excludeBaseUris: [new URL(ctx.origin)] },
    );
  }
  return result[0];
}

// TODO: define unblockAccount()
