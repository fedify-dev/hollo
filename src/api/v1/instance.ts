import { and, count, inArray, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import metadata from "../../../package.json" with { type: "json" };
import { db } from "../../db";
import { serializeAccountOwner } from "../../entities/account";
import { accountOwners, instances, posts } from "../../schema";

const app = new Hono();

app.get("/", async (c) => {
  const url = new URL(c.req.url);
  const credential = await db.query.credentials.findFirst();
  if (credential == null) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    with: { account: { with: { successor: true } } },
    orderBy: accountOwners.id,
  });
  if (accountOwner == null) return c.notFound();
  const languages = await db
    .select({ language: posts.language })
    .from(posts)
    .where(
      and(
        isNotNull(posts.language),
        inArray(
          posts.accountId,
          db.select({ id: accountOwners.id }).from(accountOwners),
        ),
      ),
    )
    .groupBy(posts.language);
  const [{ userCount }] = await db
    .select({ userCount: count() })
    .from(accountOwners);
  const [{ statusCount }] = await db
    .select({ statusCount: count() })
    .from(posts);
  const [{ domainCount }] = await db
    .select({ domainCount: count() })
    .from(instances);
  return c.json({
    uri: url.host,
    title: url.host,
    short_description: `A Hollo instance at ${url.host}`,
    description: `A Hollo instance at ${url.host}`,
    email: credential.email,
    version: metadata.version,
    urls: {}, // TODO: streaming_api URL
    stats: {
      user_count: userCount,
      status_count: statusCount,
      domain_count: domainCount,
    },
    // TODO: Allow instance admins to customize the thumbnail image
    thumbnail: `${url.origin}/public/favicon.png`,
    languages: languages.map(({ language }) => language),
    registrations: false,
    approval_required: true,
    invites_enabled: false,
    configuration: {
      accounts: {
        // TODO: Make this configurable
        max_featured_tags: 10,
      },
      statuses: {
        // TODO: Make these configurable
        max_characters: 10000,
        max_media_attachments: 8,
        characters_reserved_per_url: 256,
      },
      media_attachments: {
        supported_mime_types: [
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
          "video/mp4",
          "video/webm",
        ],
        // TODO: Make these configurable
        image_size_limit: 1024 * 1024 * 32, // 32MiB
        image_matrix_limit: 16_777_216,
        video_size_limit: 1024 * 1024 * 128, // 128MiB
        video_frame_rate_limit: 120,
        video_matrix_limit: 16_777_216,
      },
      polls: {
        // TODO: Make these configurable
        max_options: 10,
        max_characters_per_option: 100,
        min_expiration: 60 * 5,
        max_expiration: 60 * 60 * 24 * 14,
      },
    },
    contact_account: serializeAccountOwner(accountOwner, c.req.url),
    rules: [],
    feature_quote: true,
    fedibird_capabilities: [
      "emoji_reaction",
      "enable_wide_emoji",
      "enable_wide_emoji_reaction",
    ],
  });
});

export default app;
