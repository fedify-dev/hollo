import { and, inArray, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import metadata from "../../../package.json" with { type: "json" };
import { db } from "../../db";
import { serializeAccountOwner } from "../../entities/account";
import { accountOwners, posts } from "../../schema";

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
  return c.json({
    api_versions: {
      mastodon: 2,
    },
    domain: url.host,
    title: url.host,
    version: metadata.version,
    source_url: "https://github.com/fedify-dev/hollo",
    description: `A Hollo instance at ${url.host}`,
    usage: {
      users: {
        active_month: 0, // TODO
      },
    },
    // TODO: thumbnail
    languages: languages.map(({ language }) => language),
    configuration: {
      // TODO: urls
      accounts: {
        // TODO
        max_featured_tags: 0,
        max_pinned_statuses: 0,
      },
      statuses: {
        // TODO
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
        image_size_limit: 1024 * 1024 * 32, // 32MiB
        image_matrix_limit: 16_777_216,
        // TODO
        video_size_limit: 1024 * 1024 * 128, // 128MiB
        video_frame_rate_limit: 120,
        video_matrix_limit: 16_777_216,
      },
      polls: {
        max_options: 10,
        max_characters_per_option: 100,
        min_expiration: 60 * 5,
        max_expiration: 60 * 60 * 24 * 14,
      },
      translation: {
        enabled: false,
      },
      // TODO: webpush
      vapid: {
        public_key: "",
      },
    },
    registrations: {
      enabled: false,
      approval_required: true,
      message: null,
    },
    contact: {
      email: credential.email,
      account: serializeAccountOwner(accountOwner, c.req.url),
    },
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
