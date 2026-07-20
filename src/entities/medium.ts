import {
  and,
  eq,
  exists,
  ilike,
  isNull,
  lt,
  not,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import db from "../db";
import { proxyUrl } from "../media-proxy";
import {
  accountOwners,
  accounts,
  bookmarks,
  likes,
  media,
  posts,
  reactions,
  type Medium,
} from "../schema";
import { STORAGE_URL_BASE } from "../storage-config";

function normalizeAttachmentType(type: string): string {
  if (["image", "video", "audio", "gifv", "unknown"].includes(type)) {
    return type;
  }
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "unknown";
}

export function serializeMedium(
  medium: Medium,
  baseUrl: URL | string,
  // oxlint-disable-next-line typescript/no-explicit-any
): Record<string, any> {
  const previewSource = medium.thumbnailCleaned ? null : medium.thumbnailUrl;
  return {
    id: medium.id,
    type: normalizeAttachmentType(medium.type),
    url: proxyUrl(medium.url, baseUrl),
    preview_url: proxyUrl(previewSource, baseUrl),
    remote_url: null,
    text_url: null,
    meta: {
      original: {
        width: medium.width,
        height: medium.height,
        size: `${medium.width}x${medium.height}`,
        aspect: medium.width / medium.height,
      },
      small: medium.thumbnailCleaned
        ? undefined
        : {
            width: medium.thumbnailWidth,
            height: medium.thumbnailHeight,
            size: `${medium.thumbnailWidth}x${medium.thumbnailHeight}`,
            aspect: medium.thumbnailWidth / medium.thumbnailHeight,
          },
      focus: { x: 0, y: 0 },
    },
    description: medium.description,
    blurhash: null,
  };
}

export async function getMediaWithDeletableThumbnails(
  before: Date,
): Promise<Medium[]> {
  const sharingPosts = alias(posts, "sharingPosts");
  const quotingPosts = alias(posts, "quotingPosts");

  return await db
    .select({
      id: media.id,
      position: media.position,
      type: media.type,
      url: media.url,
      description: media.description,
      postId: media.postId,
      width: media.width,
      height: media.height,
      thumbnailType: media.thumbnailType,
      thumbnailWidth: media.thumbnailWidth,
      thumbnailHeight: media.thumbnailHeight,
      thumbnailUrl: media.thumbnailUrl,
      thumbnailCleaned: media.thumbnailCleaned,
      created: media.created,
    })
    .from(media)
    .innerJoin(posts, eq(media.postId, posts.id))
    .innerJoin(accounts, eq(posts.accountId, accounts.id))
    .where(
      and(
        not(media.thumbnailCleaned),
        ilike(media.thumbnailUrl, `${STORAGE_URL_BASE}%`),
        lt(media.created, before),
        notExists(
          db
            .select()
            .from(accountOwners)
            .where(eq(accounts.id, accountOwners.id)),
        ),
        notExists(
          db.select().from(bookmarks).where(eq(posts.id, bookmarks.postId)),
        ),
        notExists(
          db
            .select()
            .from(likes)
            .where(
              and(
                eq(posts.id, likes.postId),
                exists(
                  db
                    .select()
                    .from(accountOwners)
                    .where(eq(likes.accountId, accountOwners.id)),
                ),
              ),
            ),
        ),
        notExists(
          db
            .select()
            .from(reactions)
            .where(
              and(
                eq(posts.id, reactions.postId),
                exists(
                  db
                    .select()
                    .from(accountOwners)
                    .where(eq(reactions.accountId, accountOwners.id)),
                ),
              ),
            ),
        ),
        notExists(
          db
            .select()
            .from(sharingPosts)
            .where(
              and(
                eq(posts.id, sharingPosts.sharingId),
                exists(
                  db
                    .select()
                    .from(accountOwners)
                    .where(eq(sharingPosts.accountId, accountOwners.id)),
                ),
              ),
            ),
        ),
        notExists(
          db
            .select()
            .from(quotingPosts)
            .where(
              and(
                eq(posts.id, quotingPosts.quoteTargetId),
                or(
                  eq(quotingPosts.quoteState, "accepted"),
                  isNull(quotingPosts.quoteState),
                ),
                exists(
                  db
                    .select()
                    .from(accountOwners)
                    .where(eq(quotingPosts.accountId, accountOwners.id)),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(media.created);
}
