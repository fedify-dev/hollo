import { zValidator } from "@hono/zod-validator";
import { Temporal } from "@js-temporal/polyfill";
import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { serializeAccount } from "../../entities/account";
import { getPostRelations, serializePost } from "../../entities/status";
import { serializeTag } from "../../entities/tag";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import {
  accounts as accountsTable,
  blocks,
  bookmarks,
  likes,
  mutes,
} from "../../schema";
import { uuid } from "../../uuid";
import accounts from "./accounts";
import apps from "./apps";
import featured_tags from "./featured_tags";
import follow_requests from "./follow_requests";
import instance from "./instance";
import lists from "./lists";
import markers from "./markers";
import media from "./media";
import notifications from "./notifications";
import polls from "./polls";
import reports from "./reports";
import statuses from "./statuses";
import tags from "./tags";
import timelines from "./timelines";

const app = new Hono<{ Variables: Variables }>();

app.route("/apps", apps);
app.route("/accounts", accounts);
app.route("/featured_tags", featured_tags);
app.route("/follow_requests", follow_requests);
app.route("/instance", instance);
app.route("/lists", lists);
app.route("/markers", markers);
app.route("/media", media);
app.route("/notifications", notifications);
app.route("/polls", polls);
app.route("/statuses", statuses);
app.route("/tags", tags);
app.route("/timelines", timelines);
app.route("/reports", reports);

app.get(
  "/preferences",
  tokenRequired,
  scopeRequired(["read:accounts"]),
  (c) => {
    return c.json({
      // TODO
      "posting:default:visibility": "public",
      "posting:default:sensitive": false,
      "posting:default:language": null,
      "reading:expand:media": "default",
      "reading:expand:spoilers": false,
    });
  },
);

app.get("/custom_emojis", async (c) => {
  const emojis = await db.query.customEmojis.findMany();
  return c.json(
    emojis.map((emoji) => ({
      shortcode: emoji.shortcode,
      url: emoji.url,
      static_url: emoji.url,
      visible_in_picker: true,
      category: emoji.category,
    })),
  );
});

app.get("/announcements", (c) => {
  return c.json([]);
});

app.get(
  "/favourites",
  tokenRequired,
  scopeRequired(["read:favourites"]),
  zValidator(
    "query",
    z.object({
      before: z.iso.datetime().optional(),
      limit: z
        .string()
        .default("20")
        .transform((v) => Number.parseInt(v, 10)),
    }),
  ),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const query = c.req.valid("query");
    const favourites = await db.query.likes.findMany({
      where: and(
        eq(likes.accountId, owner.id),
        query.before == null
          ? undefined
          : lt(likes.created, new Date(query.before)),
      ),
      with: {
        post: { with: getPostRelations(owner.id) },
      },
      orderBy: [desc(likes.created)],
      limit: query.limit,
    });
    return c.json(
      favourites.map((like) => serializePost(like.post, owner, c.req.url)),
      200,
      favourites.length < query.limit
        ? {}
        : {
            Link: `<${
              new URL(
                `?before=${encodeURIComponent(
                  favourites[favourites.length - 1].created.toISOString(),
                )}&limit=${query.limit}`,
                c.req.url,
              ).href
            }>; rel="next"`,
          },
    );
  },
);

app.get(
  "/bookmarks",
  tokenRequired,
  scopeRequired(["read:bookmarks"]),
  zValidator(
    "query",
    z.object({
      before: z.iso.datetime().optional(),
      limit: z
        .string()
        .default("20")
        .transform((v) => Number.parseInt(v, 10)),
    }),
  ),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    const query = c.req.valid("query");
    const bookmarkList = await db.query.bookmarks.findMany({
      where: and(
        eq(bookmarks.accountOwnerId, owner.id),
        query.before == null
          ? undefined
          : lt(bookmarks.created, new Date(query.before)),
      ),
      with: {
        post: { with: getPostRelations(owner.id) },
      },
      orderBy: [desc(bookmarks.created)],
      limit: query.limit,
    });
    return c.json(
      bookmarkList.map((bm) => serializePost(bm.post, owner, c.req.url)),
      200,
      bookmarkList.length < query.limit
        ? {}
        : {
            Link: `<${
              new URL(
                `?before=${encodeURIComponent(
                  bookmarkList[bookmarkList.length - 1].created.toISOString(),
                )}&limit=${query.limit}`,
                c.req.url,
              ).href
            }>; rel="next"`,
          },
    );
  },
);

app.get(
  "/followed_tags",
  tokenRequired,
  scopeRequired(["read:follows"]),
  (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }
    return c.json(
      owner.followedTags.map((tag) => serializeTag(tag, owner, c.req.url)),
    );
  },
);

app.get(
  "/mutes",
  tokenRequired,
  scopeRequired(["read:mutes"]),
  zValidator(
    "query",
    z.object({
      max_id: uuid.optional(),
      since_id: uuid.optional(),
      limit: z
        .string()
        .default("40")
        .transform((v) => {
          const parsed = Number.parseInt(v, 10);
          return Math.min(parsed, 80);
        }),
    }),
  ),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }

    const muteList = await db.query.mutes.findMany({
      where: eq(mutes.accountId, owner.id),
    });

    if (muteList.length < 1) return c.json([]);

    const query = c.req.valid("query");

    const mutedAccounts = await db.query.accounts.findMany({
      where: and(
        inArray(
          accountsTable.id,
          muteList.map((m) => m.mutedAccountId),
        ),
        query.max_id == null ? undefined : lte(accountsTable.id, query.max_id),
        query.since_id == null
          ? undefined
          : gte(accountsTable.id, query.since_id),
      ),
      with: { owner: true, successor: true },
      orderBy: [desc(accountsTable.id)],
      limit: query.limit ?? 40,
    });

    return c.json(mutedAccounts.map((a) => serializeAccount(a, c.req.url)));
  },
);

app.get(
  "/blocks",
  tokenRequired,
  scopeRequired(["read:blocks"]),
  zValidator(
    "query",
    z.object({
      until: z.iso.datetime().optional(),
      limit: z
        .string()
        .default("40")
        .transform((v) => {
          const parsed = Number.parseInt(v, 10);
          return Math.min(parsed, 80);
        }),
    }),
  ),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        422,
      );
    }

    const query = c.req.valid("query");
    const blockList = await db.query.blocks.findMany({
      where: and(
        eq(blocks.accountId, owner.id),
        query.until == null ? undefined : lte(blocks.created, query.until),
      ),
      orderBy: desc(blocks.created),
      limit: query.limit + 1,
      with: {
        blockedAccount: { with: { owner: true, successor: true } },
      },
    });

    let next: URL | null = null;
    if (blockList.length > query.limit) {
      next = new URL(c.req.url);
      next.searchParams.set(
        "until",
        Temporal.Instant.from(blockList[query.limit].created).toString(),
      );
    }

    return c.json(
      blockList
        .slice(0, query.limit)
        .map((b) => serializeAccount(b.blockedAccount, c.req.url)),
      {
        headers: next == null ? {} : { Link: `<${next.href}>; rel="next"` },
      },
    );
  },
);

export default app;
