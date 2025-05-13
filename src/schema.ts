import { isNotNull, relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  interval,
  json,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { PreviewCard } from "./previewcard";
import type { Uuid } from "./uuid";

const currentTimestamp = sql`CURRENT_TIMESTAMP`;

export const credentials = pgTable("credentials", {
  email: varchar("email", { length: 254 }).primaryKey(),
  passwordHash: text("password_hash").notNull(),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;

export const totps = pgTable("totps", {
  issuer: text("issuer").notNull(),
  label: text("label").notNull(),
  algorithm: text("algorithm").notNull(),
  digits: smallint("digits").notNull(),
  period: smallint("period").notNull(),
  secret: text("secret").notNull(),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type Totp = typeof totps.$inferSelect;
export type NewTotp = typeof totps.$inferInsert;

export const accountTypeEnum = pgEnum("account_type", [
  "Application",
  "Group",
  "Organization",
  "Person",
  "Service",
]);

export type AccountType = (typeof accountTypeEnum.enumValues)[number];

export const accounts = pgTable("accounts", {
  id: uuid("id").$type<Uuid>().primaryKey(),
  iri: text("iri").notNull().unique(),
  type: accountTypeEnum("type").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  handle: text("handle").notNull().unique(),
  bioHtml: text("bio_html"),
  url: text("url"),
  protected: boolean("protected").notNull().default(false),
  avatarUrl: text("avatar_url"),
  coverUrl: text("cover_url"),
  inboxUrl: text("inbox_url").notNull(),
  followersUrl: text("followers_url"),
  sharedInboxUrl: text("shared_inbox_url"),
  featuredUrl: text("featured_url"),
  followingCount: bigint("following_count", { mode: "number" }).default(0),
  followersCount: bigint("followers_count", { mode: "number" }).default(0),
  postsCount: bigint("posts_count", { mode: "number" }).default(0),
  fieldHtmls: json("field_htmls")
    .notNull()
    .default({})
    .$type<Record<string, string>>(),
  emojis: jsonb("emojis").notNull().default({}).$type<Record<string, string>>(),
  sensitive: boolean("sensitive").notNull().default(false),
  successorId: uuid("successor_id")
    .$type<Uuid>()
    .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
  aliases: text("aliases").array().notNull().default(sql`(ARRAY[]::text[])`),
  instanceHost: text("instance_host")
    .notNull()
    .references(() => instances.host),
  published: timestamp("published", { withTimezone: true }),
  updated: timestamp("updated", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export const accountRelations = relations(accounts, ({ one, many }) => ({
  owner: one(accountOwners, {
    fields: [accounts.id],
    references: [accountOwners.id],
  }),
  successor: one(accounts, {
    fields: [accounts.successorId],
    references: [accounts.id],
    relationName: "successor",
  }),
  predecessors: many(accounts, { relationName: "successor" }),
  following: many(follows, { relationName: "following" }),
  followers: many(follows, { relationName: "follower" }),
  posts: many(posts),
  mentions: many(mentions),
  likes: many(likes),
  pinnedPosts: many(pinnedPosts),
  mutes: many(mutes, { relationName: "muter" }),
  mutedBy: many(mutes, { relationName: "muted" }),
  blocks: many(blocks, { relationName: "blocker" }),
  blockedBy: many(blocks, { relationName: "blocked" }),
  instance: one(instances),
}));

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export const postVisibilityEnum = pgEnum("post_visibility", [
  "public",
  "unlisted",
  "private",
  "direct",
]);

export type PostVisibility = (typeof postVisibilityEnum.enumValues)[number];

export const themeColorEnum = pgEnum("theme_color", [
  "amber",
  "azure",
  "blue",
  "cyan",
  "fuchsia",
  "green",
  "grey",
  "indigo",
  "jade",
  "lime",
  "orange",
  "pink",
  "pumpkin",
  "purple",
  "red",
  "sand",
  "slate",
  "violet",
  "yellow",
  "zinc",
]);

export type ThemeColor = (typeof themeColorEnum.enumValues)[number];

export const THEME_COLORS: readonly ThemeColor[] = themeColorEnum.enumValues;

export const accountOwners = pgTable("account_owners", {
  id: uuid("id")
    .$type<Uuid>()
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  handle: text("handle").notNull().unique(),
  rsaPrivateKeyJwk: jsonb("rsa_private_key_jwk").$type<JsonWebKey>().notNull(),
  rsaPublicKeyJwk: jsonb("rsa_public_key_jwk").$type<JsonWebKey>().notNull(),
  ed25519PrivateKeyJwk: jsonb("ed25519_private_key_jwk")
    .$type<JsonWebKey>()
    .notNull(),
  ed25519PublicKeyJwk: jsonb("ed25519_public_key_jwk")
    .$type<JsonWebKey>()
    .notNull(),
  fields: json("fields").notNull().default({}).$type<Record<string, string>>(),
  bio: text("bio"),
  followedTags: text("followed_tags").array().notNull().default([]),
  visibility: postVisibilityEnum("visibility").notNull().default("public"),
  language: text("language").notNull().default("en"),
  discoverable: boolean().notNull().default(false),
  themeColor: themeColorEnum("theme_color").notNull(),
});

export type AccountOwner = typeof accountOwners.$inferSelect;
export type NewAccountOwner = typeof accountOwners.$inferInsert;

export const accountOwnerRelations = relations(
  accountOwners,
  ({ one, many }) => ({
    account: one(accounts, {
      fields: [accountOwners.id],
      references: [accounts.id],
    }),
    accessTokens: many(accessTokens),
    bookmarks: many(bookmarks),
    markers: many(markers),
    featuredTags: many(featuredTags),
    lists: many(lists),
  }),
);

export const instances = pgTable("instances", {
  host: text("host").notNull().primaryKey(),
  software: text("software"),
  softwareVersion: text("software_version"),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type Instance = typeof instances.$inferSelect;
export type NewInstance = typeof instances.$inferInsert;

export const instanceRelations = relations(instances, ({ many }) => ({
  accounts: many(accounts),
}));

export const follows = pgTable(
  "follows",
  {
    iri: text("iri").notNull().unique(),
    followingId: uuid("following_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    followerId: uuid("follower_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    shares: boolean("shares").notNull().default(true),
    notify: boolean("notify").notNull().default(false),
    languages: text("languages").array(),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    approved: timestamp("approved", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.followingId, table.followerId] }),
    check("ck_follows_self", sql`${table.followingId} != ${table.followerId}`),
  ],
);

export type Follow = typeof follows.$inferSelect;
export type NewFollow = typeof follows.$inferInsert;

export const followRelations = relations(follows, ({ one }) => ({
  following: one(accounts, {
    fields: [follows.followingId],
    references: [accounts.id],
    relationName: "follower",
  }),
  follower: one(accounts, {
    fields: [follows.followerId],
    references: [accounts.id],
    relationName: "following",
  }),
}));

export const scopeEnum = pgEnum("scope", [
  "read",
  "read:accounts",
  "read:blocks",
  "read:bookmarks",
  "read:favourites",
  "read:filters",
  "read:follows",
  "read:lists",
  "read:mutes",
  "read:notifications",
  "read:search",
  "read:statuses",
  "write",
  "write:accounts",
  "write:blocks",
  "write:bookmarks",
  "write:conversations",
  "write:favourites",
  "write:filters",
  "write:follows",
  "write:lists",
  "write:media",
  "write:mutes",
  "write:notifications",
  "write:reports",
  "write:statuses",
  "follow",
  "push",
]);

export type Scope = (typeof scopeEnum.enumValues)[number];

export const applications = pgTable("applications", {
  id: uuid("id").$type<Uuid>().primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  scopes: scopeEnum("scopes").array().notNull(),
  website: text("website"),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret").notNull(),
  confidential: boolean("confidential").default(false).notNull(),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;

export const applicationRelations = relations(applications, ({ many }) => ({
  accessTokens: many(accessTokens),
}));

export const accessGrants = pgTable(
  "access_grants",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    code: text("code").notNull().unique(),
    expiresIn: integer("expires_in").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scopes: scopeEnum("scopes").array().notNull(),
    applicationId: uuid("application_id")
      .$type<Uuid>()
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    resourceOwnerId: uuid("resource_owner_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountOwners.id, { onDelete: "cascade" }),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    revoked: timestamp("revoked", { withTimezone: true }),
  },
  (table) => [index().on(table.resourceOwnerId)],
);

export type AccessGrant = typeof accessGrants.$inferSelect;
export type NewAccessGrant = typeof accessGrants.$inferInsert;

export const accessGrantRelations = relations(accessGrants, ({ one }) => ({
  application: one(applications, {
    fields: [accessGrants.applicationId],
    references: [applications.id],
  }),
  accountOwner: one(accountOwners, {
    fields: [accessGrants.resourceOwnerId],
    references: [accountOwners.id],
  }),
}));

export const grantTypeEnum = pgEnum("grant_type", [
  "authorization_code",
  "client_credentials",
]);

export type GrantType = (typeof grantTypeEnum.enumValues)[number];

export const accessTokens = pgTable("access_tokens", {
  code: text("code").primaryKey(),
  applicationId: uuid("application_id")
    .$type<Uuid>()
    .notNull()
    .references(() => applications.id, { onDelete: "cascade" }),
  accountOwnerId: uuid("account_owner_id")
    .$type<Uuid>()
    .references(() => accountOwners.id, { onDelete: "cascade" }),
  grant_type: grantTypeEnum("grant_type")
    .notNull()
    .default("authorization_code"),
  scopes: scopeEnum("scopes").array().notNull(),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type AccessToken = typeof accessTokens.$inferSelect;
export type NewAccessToken = typeof accessTokens.$inferInsert;

export const accessTokenRelations = relations(accessTokens, ({ one }) => ({
  application: one(applications, {
    fields: [accessTokens.applicationId],
    references: [applications.id],
  }),
  accountOwner: one(accountOwners, {
    fields: [accessTokens.accountOwnerId],
    references: [accountOwners.id],
  }),
}));

export const postTypeEnum = pgEnum("post_type", [
  "Article",
  "Note",
  "Question",
]);

export type PostType = (typeof postTypeEnum.enumValues)[number];

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    iri: text("iri").notNull().unique(),
    type: postTypeEnum("type").notNull(),
    accountId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id")
      .$type<Uuid>()
      .references(() => applications.id, { onDelete: "set null" }),
    replyTargetId: uuid("reply_target_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => posts.id, { onDelete: "set null" }),
    sharingId: uuid("sharing_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => posts.id, { onDelete: "cascade" }),
    quoteTargetId: uuid("quote_target_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => posts.id, { onDelete: "set null" }),
    visibility: postVisibilityEnum("visibility").notNull(),
    summary: text("summary"),
    contentHtml: text("content_html"),
    content: text("content"),
    pollId: uuid("poll_id")
      .$type<Uuid>()
      .references(() => polls.id, { onDelete: "set null" }),
    language: text("language"),
    tags: jsonb("tags").notNull().default({}).$type<Record<string, string>>(),
    emojis: jsonb("emojis")
      .notNull()
      .default({})
      .$type<Record<string, string>>(),
    sensitive: boolean("sensitive").notNull().default(false),
    url: text("url"),
    previewCard: jsonb("preview_card").$type<PreviewCard>(),
    repliesCount: bigint("replies_count", { mode: "number" }).default(0),
    sharesCount: bigint("shares_count", { mode: "number" }).default(0),
    likesCount: bigint("likes_count", { mode: "number" }).default(0),
    idempotenceKey: text("idempotence_key"),
    published: timestamp("published", { withTimezone: true }),
    updated: timestamp("updated", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique("posts_id_actor_id_unique").on(table.id, table.accountId),
    unique().on(table.pollId),
    unique().on(table.accountId, table.sharingId),
    index().on(table.sharingId),
    index().on(table.accountId),
    index().on(table.accountId, table.sharingId),
    index().on(table.replyTargetId),
    index().on(table.visibility, table.accountId),
    index()
      .on(table.visibility, table.accountId, table.sharingId)
      .where(isNotNull(table.sharingId)),
    index()
      .on(table.visibility, table.accountId, table.replyTargetId)
      .where(isNotNull(table.replyTargetId)),
  ],
);

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;

export const postRelations = relations(posts, ({ one, many }) => ({
  account: one(accounts, {
    fields: [posts.accountId],
    references: [accounts.id],
  }),
  application: one(applications, {
    fields: [posts.applicationId],
    references: [applications.id],
  }),
  replyTarget: one(posts, {
    fields: [posts.replyTargetId],
    references: [posts.id],
    relationName: "reply",
  }),
  replies: many(posts, { relationName: "reply" }),
  likes: many(likes),
  reactions: many(reactions),
  sharing: one(posts, {
    fields: [posts.sharingId],
    references: [posts.id],
    relationName: "share",
  }),
  shares: many(posts, { relationName: "share" }),
  quoteTarget: one(posts, {
    fields: [posts.quoteTargetId],
    references: [posts.id],
    relationName: "quote",
  }),
  quotes: many(posts, { relationName: "quote" }),
  media: many(media),
  poll: one(polls, {
    fields: [posts.pollId],
    references: [polls.id],
  }),
  mentions: many(mentions),
  bookmarks: many(bookmarks),
  pin: one(pinnedPosts, {
    fields: [posts.id, posts.accountId],
    references: [pinnedPosts.postId, pinnedPosts.accountId],
  }),
}));

export const media = pgTable(
  "media",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    postId: uuid("post_id")
      .$type<Uuid>()
      .references(() => posts.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    url: text("url").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    description: text("description"),
    thumbnailType: text("thumbnail_type").notNull(),
    thumbnailUrl: text("thumbnail_url").notNull(),
    thumbnailWidth: integer("thumbnail_width").notNull(),
    thumbnailHeight: integer("thumbnail_height").notNull(),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [index().on(table.postId)],
);

export type Medium = typeof media.$inferSelect;
export type NewMedium = typeof media.$inferInsert;

export const mediumRelations = relations(media, ({ one }) => ({
  post: one(posts, {
    fields: [media.postId],
    references: [posts.id],
  }),
}));

export const polls = pgTable("polls", {
  id: uuid("id").$type<Uuid>().primaryKey(),
  multiple: boolean("multiple").notNull().default(false),
  votersCount: bigint("voters_count", { mode: "number" }).notNull().default(0),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type Poll = typeof polls.$inferSelect;
export type NewPoll = typeof polls.$inferInsert;

export const pollRelations = relations(polls, ({ many }) => ({
  posts: many(posts),
  options: many(pollOptions),
  votes: many(pollVotes),
}));

export const pollOptions = pgTable(
  "poll_options",
  {
    pollId: uuid("poll_id")
      .$type<Uuid>()
      .references(() => polls.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    title: text("title").notNull(),
    votesCount: bigint("votes_count", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.pollId, table.index] }),
    unique().on(table.pollId, table.title),
    index().on(table.pollId, table.index),
  ],
);

export type PollOption = typeof pollOptions.$inferSelect;
export type NewPollOption = typeof pollOptions.$inferInsert;

export const pollOptionRelations = relations(pollOptions, ({ one, many }) => ({
  poll: one(polls, {
    fields: [pollOptions.pollId],
    references: [polls.id],
  }),
  votes: many(pollVotes),
}));

export const pollVotes = pgTable(
  "poll_votes",
  {
    pollId: uuid("poll_id")
      .$type<Uuid>()
      .notNull()
      .references(() => polls.id, { onDelete: "cascade" }),
    optionIndex: integer("option_index").notNull(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({
      columns: [table.pollId, table.optionIndex, table.accountId],
    }),
    foreignKey({
      columns: [table.pollId, table.optionIndex],
      foreignColumns: [pollOptions.pollId, pollOptions.index],
    }),
    index().on(table.pollId, table.accountId),
  ],
);

export type PollVote = typeof pollVotes.$inferSelect;
export type NewPollVote = typeof pollVotes.$inferInsert;

export const pollVoteRelations = relations(pollVotes, ({ one }) => ({
  poll: one(polls, {
    fields: [pollVotes.pollId],
    references: [polls.id],
  }),
  option: one(pollOptions, {
    fields: [pollVotes.pollId, pollVotes.optionIndex],
    references: [pollOptions.pollId, pollOptions.index],
  }),
  account: one(accounts, {
    fields: [pollVotes.accountId],
    references: [accounts.id],
  }),
}));

export const mentions = pgTable(
  "mentions",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.accountId] }),
    index().on(table.postId, table.accountId),
  ],
);

export type Mention = typeof mentions.$inferSelect;
export type NewMention = typeof mentions.$inferInsert;

export const mentionRelations = relations(mentions, ({ one }) => ({
  post: one(posts, {
    fields: [mentions.postId],
    references: [posts.id],
  }),
  account: one(accounts, {
    fields: [mentions.accountId],
    references: [accounts.id],
  }),
}));

export const pinnedPosts = pgTable(
  "pinned_posts",
  {
    index: bigserial("index", { mode: "number" }).notNull().primaryKey(),
    postId: uuid("post_id").$type<Uuid>().notNull(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique().on(table.postId, table.accountId),
    foreignKey({
      columns: [table.postId, table.accountId],
      foreignColumns: [posts.id, posts.accountId],
    }).onDelete("cascade"),
    index().on(table.accountId, table.postId),
  ],
);

export const pinnedPostRelations = relations(pinnedPosts, ({ one }) => ({
  post: one(posts, {
    fields: [pinnedPosts.postId, pinnedPosts.accountId],
    references: [posts.id, posts.accountId],
  }),
  account: one(accounts, {
    fields: [pinnedPosts.accountId],
    references: [accounts.id],
  }),
}));

export type PinnedPost = typeof pinnedPosts.$inferSelect;
export type NewPinnedPost = typeof pinnedPosts.$inferInsert;

export const likes = pgTable(
  "likes",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.accountId] }),
    index().on(table.accountId, table.postId),
  ],
);

export type Like = typeof likes.$inferSelect;
export type NewLike = typeof likes.$inferInsert;

export const likeRelations = relations(likes, ({ one }) => ({
  post: one(posts, {
    fields: [likes.postId],
    references: [posts.id],
  }),
  account: one(accounts, {
    fields: [likes.accountId],
    references: [accounts.id],
  }),
}));

export const reactions = pgTable(
  "reactions",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    customEmoji: text("custom_emoji"),
    emojiIri: text("emoji_iri"),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.accountId, table.emoji] }),
    index().on(table.postId),
    index().on(table.postId, table.accountId),
  ],
);

export type Reaction = typeof reactions.$inferSelect;
export type NewReaction = typeof reactions.$inferInsert;

export const reactionRelations = relations(reactions, ({ one }) => ({
  post: one(posts, {
    fields: [reactions.postId],
    references: [posts.id],
  }),
  account: one(accounts, {
    fields: [reactions.accountId],
    references: [accounts.id],
  }),
}));

export const bookmarks = pgTable(
  "bookmarks",
  {
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    accountOwnerId: uuid("account_owner_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountOwners.id, { onDelete: "cascade" }),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.accountOwnerId] }),
    index().on(table.postId, table.accountOwnerId),
  ],
);

export type Bookmark = typeof bookmarks.$inferSelect;
export type NewBookmark = typeof bookmarks.$inferInsert;

export const bookmarkRelations = relations(bookmarks, ({ one }) => ({
  post: one(posts, {
    fields: [bookmarks.postId],
    references: [posts.id],
  }),
  accountOwner: one(accountOwners, {
    fields: [bookmarks.accountOwnerId],
    references: [accountOwners.id],
  }),
}));

export const markerTypeEnum = pgEnum("marker_type", ["notifications", "home"]);

export type MarkerType = (typeof markerTypeEnum.enumValues)[number];

export const markers = pgTable(
  "markers",
  {
    accountOwnerId: uuid("account_owner_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountOwners.id, { onDelete: "cascade" }),
    type: markerTypeEnum("type").notNull(),
    lastReadId: text("last_read_id").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updated: timestamp("updated", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [primaryKey({ columns: [table.accountOwnerId, table.type] })],
);

export type Marker = typeof markers.$inferSelect;
export type NewMarker = typeof markers.$inferInsert;

export const markerRelations = relations(markers, ({ one }) => ({
  accountOwner: one(accountOwners, {
    fields: [markers.accountOwnerId],
    references: [accountOwners.id],
  }),
}));

export const featuredTags = pgTable(
  "featured_tags",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    accountOwnerId: uuid("account_owner_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountOwners.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    created: timestamp("created", { withTimezone: true }),
  },
  (table) => [unique().on(table.accountOwnerId, table.name)],
);

export type FeaturedTag = typeof featuredTags.$inferSelect;
export type NewFeaturedTag = typeof featuredTags.$inferInsert;

export const featuredTagRelations = relations(featuredTags, ({ one }) => ({
  accountOwner: one(accountOwners, {
    fields: [featuredTags.accountOwnerId],
    references: [accountOwners.id],
  }),
}));

export const listRepliesPolicyEnum = pgEnum("list_replies_policy", [
  "followed",
  "list",
  "none",
]);

export type ListRepliesPolicy =
  (typeof listRepliesPolicyEnum.enumValues)[number];

export const lists = pgTable("lists", {
  id: uuid("id").$type<Uuid>().primaryKey(),
  accountOwnerId: uuid("account_owner_id")
    .$type<Uuid>()
    .notNull()
    .references(() => accountOwners.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  repliesPolicy: listRepliesPolicyEnum("replies_policy")
    .notNull()
    .default("list"),
  exclusive: boolean("exclusive").notNull().default(false),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;

export const listRelations = relations(lists, ({ one, many }) => ({
  accountOwner: one(accountOwners, {
    fields: [lists.accountOwnerId],
    references: [accountOwners.id],
  }),
  members: many(listMembers),
}));

export const listMembers = pgTable(
  "list_members",
  {
    listId: uuid("list_id")
      .$type<Uuid>()
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [primaryKey({ columns: [table.listId, table.accountId] })],
);

export type ListMember = typeof listMembers.$inferSelect;
export type NewListMember = typeof listMembers.$inferInsert;

export const listMemberRelations = relations(listMembers, ({ one }) => ({
  list: one(lists, {
    fields: [listMembers.listId],
    references: [lists.id],
  }),
  account: one(accounts, {
    fields: [listMembers.accountId],
    references: [accounts.id],
  }),
}));

export const mutes = pgTable(
  "mutes",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    mutedAccountId: uuid("muted_account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    notifications: boolean("notifications").notNull().default(true),
    duration: interval("duration"),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    unique("mutes_account_id_muted_account_id_unique").on(
      table.accountId,
      table.mutedAccountId,
    ),
  ],
);

export type Mute = typeof mutes.$inferSelect;
export type NewMute = typeof mutes.$inferInsert;

export const muteRelations = relations(mutes, ({ one }) => ({
  account: one(accounts, {
    fields: [mutes.accountId],
    references: [accounts.id],
    relationName: "muter",
  }),
  targetAccount: one(accounts, {
    fields: [mutes.mutedAccountId],
    references: [accounts.id],
    relationName: "muted",
  }),
}));

export const blocks = pgTable(
  "blocks",
  {
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    blockedAccountId: uuid("blocked_account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    created: timestamp("created", { withTimezone: true, mode: "string" })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.blockedAccountId] }),
    index().on(table.accountId),
    index().on(table.blockedAccountId),
  ],
);

export type Block = typeof blocks.$inferSelect;
export type NewBlock = typeof blocks.$inferInsert;

export const blockRelations = relations(blocks, ({ one }) => ({
  account: one(accounts, {
    fields: [blocks.accountId],
    references: [accounts.id],
    relationName: "blocker",
  }),
  blockedAccount: one(accounts, {
    fields: [blocks.blockedAccountId],
    references: [accounts.id],
    relationName: "blocked",
  }),
}));

export const customEmojis = pgTable("custom_emojis", {
  shortcode: text("shortcode").primaryKey(),
  url: text("url").notNull(),
  category: text("category"),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type CustomEmoji = typeof customEmojis.$inferSelect;
export type NewCustomEmoji = typeof customEmojis.$inferInsert;

export const reports = pgTable("reports", {
  id: uuid("id").$type<Uuid>().primaryKey(),
  iri: text("iri").notNull().unique(),
  accountId: uuid("account_id")
    .$type<Uuid>()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  targetAccountId: uuid("target_account_id")
    .$type<Uuid>()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
  comment: text("comment").notNull(),
  // No relationship, we're just storing a set of Post IDs in here:
  posts: uuid("posts")
    .array()
    .$type<Uuid[]>()
    .notNull()
    .default(sql`'{}'::uuid[]`),
});

export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;

export const reportRelations = relations(reports, ({ one }) => ({
  account: one(accounts, {
    fields: [reports.accountId],
    references: [accounts.id],
  }),
  targetAccount: one(accounts, {
    fields: [reports.targetAccountId],
    references: [accounts.id],
  }),
}));

export const timelinePosts = pgTable(
  "timeline_posts",
  {
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountOwners.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.postId] }),
    index().on(table.accountId, table.postId),
  ],
);

export type TimelinePost = typeof timelinePosts.$inferSelect;
export type NewTimelinePost = typeof timelinePosts.$inferInsert;

export const timelinePostRelations = relations(timelinePosts, ({ one }) => ({
  account: one(accountOwners, {
    fields: [timelinePosts.accountId],
    references: [accountOwners.id],
  }),
  post: one(posts, {
    fields: [timelinePosts.postId],
    references: [posts.id],
  }),
}));

export const listPosts = pgTable(
  "list_posts",
  {
    listId: uuid("list_id")
      .$type<Uuid>()
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.listId, table.postId] }),
    index().on(table.listId, table.postId),
  ],
);

export type ListPost = typeof listPosts.$inferSelect;
export type NewListPost = typeof listPosts.$inferInsert;

export const listPostRelations = relations(listPosts, ({ one }) => ({
  list: one(lists, {
    fields: [listPosts.listId],
    references: [lists.id],
  }),
  post: one(posts, {
    fields: [listPosts.postId],
    references: [posts.id],
  }),
}));
