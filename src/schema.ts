import { isNotNull, sql } from "drizzle-orm";
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
  uniqueIndex,
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

export const passkeys = pgTable("passkeys", {
  id: text("id").primaryKey(),
  credentialEmail: varchar("credential_email", { length: 254 })
    .notNull()
    .references(() => credentials.email, { onDelete: "cascade" }),
  publicKey: text("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull(),
  transports: text("transports")
    .array()
    .notNull()
    .default(sql`(ARRAY[]::text[])`),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  nickname: text("nickname").notNull(),
  lastUsed: timestamp("last_used", { withTimezone: true }),
  created: timestamp("created", { withTimezone: true })
    .notNull()
    .default(currentTimestamp),
});

export type Passkey = typeof passkeys.$inferSelect;
export type NewPasskey = typeof passkeys.$inferInsert;

// One row per in-flight passkey *login* ceremony.  The signed cookie sent
// to the browser holds just `id`; the actual WebAuthn challenge lives
// here so /finish can atomically `DELETE … WHERE id AND expires_at > now()
// RETURNING challenge`, making a captured cookie + assertion pair good
// for at most one /finish call even within the TTL.  Registration is
// already bound to the logged-in session, so it doesn't need this.
export const passkeyLoginChallenges = pgTable(
  "passkey_login_challenges",
  {
    id: text("id").primaryKey(),
    challenge: text("challenge").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [index().on(table.expiresAt)],
);

export type PasskeyLoginChallenge = typeof passkeyLoginChallenges.$inferSelect;
export type NewPasskeyLoginChallenge =
  typeof passkeyLoginChallenges.$inferInsert;

export const accountTypeEnum = pgEnum("account_type", [
  "Application",
  "Group",
  "Organization",
  "Person",
  "Service",
]);

export type AccountType = (typeof accountTypeEnum.enumValues)[number];

export const accounts = pgTable(
  "accounts",
  {
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
    emojis: jsonb("emojis")
      .notNull()
      .default({})
      .$type<Record<string, string>>(),
    sensitive: boolean("sensitive").notNull().default(false),
    successorId: uuid("successor_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => accounts.id, { onDelete: "cascade" }),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`(ARRAY[]::text[])`),
    instanceHost: text("instance_host")
      .notNull()
      .references(() => instances.host),
    published: timestamp("published", { withTimezone: true }),
    updated: timestamp("updated", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    fetched: timestamp("fetched", { withTimezone: true }),
  },
  (table) => [
    index("accounts_handle_trgm_idx").using(
      "gin",
      table.handle.op("gin_trgm_ops"),
    ),
    index("accounts_name_trgm_idx").using("gin", table.name.op("gin_trgm_ops")),
    check(
      "ck_accounts_field_htmls_object",
      sql`json_typeof(${table.fieldHtmls}) = 'object'`,
    ),
    check(
      "ck_accounts_emojis_object",
      sql`jsonb_typeof(${table.emojis}) = 'object'`,
    ),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export const postVisibilityEnum = pgEnum("post_visibility", [
  "public",
  "unlisted",
  "private",
  "direct",
]);

export type PostVisibility = (typeof postVisibilityEnum.enumValues)[number];

export const quoteStateEnum = pgEnum("quote_state", [
  "pending",
  "accepted",
  "rejected",
  "revoked",
  "unauthorized",
]);

export type QuoteState = (typeof quoteStateEnum.enumValues)[number];

export const quoteApprovalPolicyEnum = pgEnum("quote_approval_policy", [
  "public",
  "followers",
  "nobody",
]);

export type QuoteApprovalPolicy =
  (typeof quoteApprovalPolicyEnum.enumValues)[number];

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

export const accountOwners = pgTable(
  "account_owners",
  {
    id: uuid("id")
      .$type<Uuid>()
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    handle: text("handle").notNull().unique(),
    rsaPrivateKeyJwk: jsonb("rsa_private_key_jwk")
      .$type<JsonWebKey>()
      .notNull(),
    rsaPublicKeyJwk: jsonb("rsa_public_key_jwk").$type<JsonWebKey>().notNull(),
    ed25519PrivateKeyJwk: jsonb("ed25519_private_key_jwk")
      .$type<JsonWebKey>()
      .notNull(),
    ed25519PublicKeyJwk: jsonb("ed25519_public_key_jwk")
      .$type<JsonWebKey>()
      .notNull(),
    fields: json("fields")
      .notNull()
      .default({})
      .$type<Record<string, string>>(),
    bio: text("bio"),
    followedTags: text("followed_tags").array().notNull().default([]),
    visibility: postVisibilityEnum("visibility").notNull().default("public"),
    language: text("language").notNull().default("en"),
    discoverable: boolean().notNull().default(false),
    expandSpoilers: boolean("expand_spoilers").notNull().default(false),
    followingListPublic: boolean("following_list_public")
      .notNull()
      .default(false),
    themeColor: themeColorEnum("theme_color").notNull(),
  },
  (table) => [
    check(
      "ck_account_owners_rsa_private_key_jwk_object",
      sql`jsonb_typeof(${table.rsaPrivateKeyJwk}) = 'object'`,
    ),
    check(
      "ck_account_owners_rsa_public_key_jwk_object",
      sql`jsonb_typeof(${table.rsaPublicKeyJwk}) = 'object'`,
    ),
    check(
      "ck_account_owners_ed25519_private_key_jwk_object",
      sql`jsonb_typeof(${table.ed25519PrivateKeyJwk}) = 'object'`,
    ),
    check(
      "ck_account_owners_ed25519_public_key_jwk_object",
      sql`jsonb_typeof(${table.ed25519PublicKeyJwk}) = 'object'`,
    ),
    check(
      "ck_account_owners_fields_object",
      sql`json_typeof(${table.fields}) = 'object'`,
    ),
  ],
);

export type AccountOwner = typeof accountOwners.$inferSelect;
export type NewAccountOwner = typeof accountOwners.$inferInsert;

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
    index()
      .on(table.followingId, table.approved)
      .where(isNotNull(table.approved)),
    index("follows_follower_id_following_id_approved_index")
      .on(table.followerId, table.followingId)
      .where(isNotNull(table.approved)),
    index().on(table.followingId, table.created),
  ],
);

export type Follow = typeof follows.$inferSelect;
export type NewFollow = typeof follows.$inferInsert;

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
  "profile",
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

export const accessGrants = pgTable(
  "access_grants",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    code: text("code").notNull().unique(),
    expiresIn: integer("expires_in").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scopes: scopeEnum("scopes").array().notNull(),
    codeChallenge: text("code_challenge"),
    codeChallengeMethod: varchar("code_challenge_method", { length: 256 }),
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
    quoteTargetIri: text("quote_target_iri"),
    quoteState: quoteStateEnum("quote_state"),
    quoteAuthorizationIri: text("quote_authorization_iri"),
    quoteApprovalPolicy: quoteApprovalPolicyEnum(
      "quote_approval_policy",
    ).default("public"),
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
    quotesCount: bigint("quotes_count", { mode: "number" }).default(0),
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
    index().on(table.accountId, table.replyTargetId),
    index().on(table.quoteTargetId).where(isNotNull(table.quoteTargetId)),
    index().on(table.visibility, table.accountId),
    index()
      .on(table.visibility, table.accountId, table.sharingId)
      .where(isNotNull(table.sharingId)),
    index()
      .on(table.visibility, table.accountId, table.replyTargetId)
      .where(isNotNull(table.replyTargetId)),
    index("posts_content_html_trgm_idx").using(
      "gin",
      table.contentHtml.op("gin_trgm_ops"),
    ),
    index("posts_updated_index").on(table.updated),
    index("posts_actor_id_updated_index").on(table.accountId, table.updated),
    index("posts_actor_id_published_index").on(
      table.accountId,
      table.published,
    ),
    index("posts_actor_id_language_index")
      .on(table.accountId, table.language)
      .where(isNotNull(table.language)),
    index("posts_tags_gin_idx").using("gin", table.tags),
  ],
);

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;

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
    thumbnailCleaned: boolean("thumbnail_cleaned").notNull().default(false),
  },
  (table) => [index().on(table.postId)],
);

export type Medium = typeof media.$inferSelect;
export type NewMedium = typeof media.$inferInsert;

export const polls = pgTable(
  "polls",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    multiple: boolean("multiple").notNull().default(false),
    votersCount: bigint("voters_count", { mode: "number" })
      .notNull()
      .default(0),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [index("polls_expires_index").on(table.expires)],
);

export type Poll = typeof polls.$inferSelect;
export type NewPoll = typeof polls.$inferInsert;

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
    index().on(table.created),
  ],
);

export type Like = typeof likes.$inferSelect;
export type NewLike = typeof likes.$inferInsert;

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
    index().on(table.created),
  ],
);

export type Reaction = typeof reactions.$inferSelect;
export type NewReaction = typeof reactions.$inferInsert;

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
    index().on(table.accountId),
  ],
);

export type Mute = typeof mutes.$inferSelect;
export type NewMute = typeof mutes.$inferInsert;

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
    .$type<Uuid>()
    .notNull()
    .default(sql`'{}'::uuid[]`),
});

export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;

export const notificationTypeEnum = pgEnum("notification_type", [
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
  "quote",
  "quoted_update",
]);

export type NotificationType = (typeof notificationTypeEnum.enumValues)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    accountOwnerId: uuid("account_owner_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountOwners.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    actorAccountId: uuid("actor_account_id")
      .$type<Uuid>()
      .references(() => accounts.id, { onDelete: "cascade" }),
    targetPostId: uuid("target_post_id")
      .$type<Uuid>()
      .references(() => posts.id, { onDelete: "cascade" }),
    targetAccountId: uuid("target_account_id")
      .$type<Uuid>()
      .references(() => accounts.id, { onDelete: "cascade" }),
    targetPollId: uuid("target_poll_id")
      .$type<Uuid>()
      .references(() => polls.id, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull(),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [
    index().on(table.accountOwnerId, table.created),
    index().on(table.accountOwnerId, table.readAt),
    index().on(table.groupKey),
    index().on(table.created),
    uniqueIndex("notifications_poll_account_owner_id_target_poll_id_unique")
      .on(table.accountOwnerId, table.targetPollId)
      .where(sql`${table.type} = 'poll' AND ${table.targetPollId} IS NOT NULL`),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export const notificationGroups = pgTable(
  "notification_groups",
  {
    groupKey: text("group_key").primaryKey(),
    accountOwnerId: uuid("account_owner_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountOwners.id, { onDelete: "cascade" }),
    type: notificationTypeEnum("type").notNull(),
    targetPostId: uuid("target_post_id")
      .$type<Uuid>()
      .references(() => posts.id, { onDelete: "cascade" }),
    notificationsCount: integer("notifications_count").notNull().default(0),
    mostRecentNotificationId: uuid("most_recent_notification_id")
      .$type<Uuid>()
      .references(() => notifications.id, { onDelete: "cascade" }),
    sampleAccountIds: uuid("sample_account_ids")
      .array()
      .$type<Uuid>()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    latestPageNotificationAt: timestamp("latest_page_notification_at", {
      withTimezone: true,
    }),
    pageMinId: uuid("page_min_id").$type<Uuid>(),
    pageMaxId: uuid("page_max_id").$type<Uuid>(),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    updated: timestamp("updated", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index().on(table.accountOwnerId, table.updated),
    index().on(table.accountOwnerId, table.type),
  ],
);

export type NotificationGroup = typeof notificationGroups.$inferSelect;
export type NewNotificationGroup = typeof notificationGroups.$inferInsert;

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

// Import Job Status Enum
export const importJobStatusEnum = pgEnum("import_job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export type ImportJobStatus = (typeof importJobStatusEnum.enumValues)[number];

// Import Job Category Enum
export const importJobCategoryEnum = pgEnum("import_job_category", [
  "following_accounts",
  "lists",
  "muted_accounts",
  "blocked_accounts",
  "bookmarks",
]);

export type ImportJobCategory =
  (typeof importJobCategoryEnum.enumValues)[number];

// Import Jobs Table
export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    accountOwnerId: uuid("account_owner_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accountOwners.id, { onDelete: "cascade" }),
    category: importJobCategoryEnum("category").notNull(),
    status: importJobStatusEnum("status").notNull().default("pending"),
    totalItems: integer("total_items").notNull().default(0),
    processedItems: integer("processed_items").notNull().default(0),
    successfulItems: integer("successful_items").notNull().default(0),
    failedItems: integer("failed_items").notNull().default(0),
    errorMessage: text("error_message"),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index().on(table.accountOwnerId, table.status),
    index().on(table.status, table.created),
  ],
);

export type ImportJob = typeof importJobs.$inferSelect;
export type NewImportJob = typeof importJobs.$inferInsert;

// Import Job Items Table
export const importJobItems = pgTable(
  "import_job_items",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    jobId: uuid("job_id")
      .$type<Uuid>()
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    status: importJobStatusEnum("status").notNull().default("pending"),
    data: jsonb("data").notNull().$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [index().on(table.jobId, table.status)],
);

export type ImportJobItem = typeof importJobItems.$inferSelect;
export type NewImportJobItem = typeof importJobItems.$inferInsert;

// Import Job Relations

// Cleanup Job Status Enum
export const cleanupJobStatusEnum = pgEnum("cleanup_job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export type CleanupJobStatus = (typeof cleanupJobStatusEnum.enumValues)[number];

// Cleanup Job Category Enum
export const cleanupJobCategoryEnum = pgEnum("cleanup_job_category", [
  "cleanup_thumbnails",
]);

export type CleanupJobCategory =
  (typeof cleanupJobCategoryEnum.enumValues)[number];

// Cleanup Jobs Table
export const cleanupJobs = pgTable(
  "cleanup_jobs",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    category: cleanupJobCategoryEnum("category").notNull(),
    status: cleanupJobStatusEnum("status").notNull().default("pending"),
    totalItems: integer("total_items").notNull().default(0),
    processedItems: integer("processed_items").notNull().default(0),
    successfulItems: integer("successful_items").notNull().default(0),
    failedItems: integer("failed_items").notNull().default(0),
    errorMessage: text("error_message"),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index().on(table.status, table.created)],
);

export type CleanupJob = typeof cleanupJobs.$inferSelect;
export type NewCleanupJob = typeof cleanupJobs.$inferInsert;

// Cleanup Job Items Table
export const cleanupJobItems = pgTable(
  "cleanup_job_items",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    jobId: uuid("job_id")
      .$type<Uuid>()
      .notNull()
      .references(() => cleanupJobs.id, { onDelete: "cascade" }),
    status: cleanupJobStatusEnum("status").notNull().default("pending"),
    data: jsonb("data").notNull().$type<Record<string, unknown>>(),
    errorMessage: text("error_message"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [index().on(table.jobId, table.status)],
);

export type CleanupJobItem = typeof cleanupJobItems.$inferSelect;
export type NewCleanupJobItem = typeof cleanupJobItems.$inferInsert;

// Cleanup Job Relations

export const remoteReplyScrapeJobStatusEnum = pgEnum(
  "remote_reply_scrape_job_status",
  ["pending", "processing", "completed", "failed"],
);

export type RemoteReplyScrapeJobStatus =
  (typeof remoteReplyScrapeJobStatusEnum.enumValues)[number];

export const remoteReplyScrapeJobs = pgTable(
  "remote_reply_scrape_jobs",
  {
    id: uuid("id").$type<Uuid>().primaryKey(),
    postId: uuid("post_id")
      .$type<Uuid>()
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    postIri: text("post_iri").notNull(),
    repliesIri: text("replies_iri").notNull().unique(),
    baseUrl: text("base_url").notNull(),
    originHost: text("origin_host").notNull(),
    depth: integer("depth").notNull().default(0),
    status: remoteReplyScrapeJobStatusEnum("status")
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    fetchedItems: integer("fetched_items").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    errorMessage: text("error_message"),
    created: timestamp("created", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updated: timestamp("updated", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index("remote_reply_scrape_jobs_claim_index").on(
      table.status,
      table.nextAttemptAt,
      table.created,
    ),
    index("remote_reply_scrape_jobs_origin_claim_index").on(
      table.originHost,
      table.status,
      table.nextAttemptAt,
      table.created,
    ),
    index("remote_reply_scrape_jobs_stale_processing_index").on(
      table.status,
      table.updated,
    ),
  ],
);

export type RemoteReplyScrapeJob = typeof remoteReplyScrapeJobs.$inferSelect;
export type NewRemoteReplyScrapeJob = typeof remoteReplyScrapeJobs.$inferInsert;

export const remoteReplyScrapeOrigins = pgTable(
  "remote_reply_scrape_origins",
  {
    originHost: text("origin_host").primaryKey(),
    nextRequestAt: timestamp("next_request_at", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    lastRequestAt: timestamp("last_request_at", { withTimezone: true }),
    processingJobId: uuid("processing_job_id").$type<Uuid>(),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    updated: timestamp("updated", { withTimezone: true })
      .notNull()
      .default(currentTimestamp),
  },
  (table) => [
    index().on(table.nextRequestAt),
    index().on(table.processingJobId),
  ],
);

export type RemoteReplyScrapeOrigin =
  typeof remoteReplyScrapeOrigins.$inferSelect;
