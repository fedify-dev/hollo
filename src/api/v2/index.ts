import {
  Article,
  isActor,
  lookupObject,
  Note,
  type Object,
} from "@fedify/vocab";
import { zValidator } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { serializeAccount } from "../../entities/account";
import { getPostRelations, serializePost } from "../../entities/status";
import { federation } from "../../federation";
import { persistAccount } from "../../federation/account";
import { persistPost } from "../../federation/post";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { HANDLE_PATTERN } from "../../patterns";
import { type Account, accounts, posts } from "../../schema";
import { buildSearchFilter, parseSearchQuery } from "../../search";
import { uuid } from "../../uuid";
import { postMedia } from "../v1/media";
import instance from "./instance";
import notificationsRoutes from "./notifications";

const app = new Hono<{ Variables: Variables }>();

app.route("/instance", instance);
app.route("/notifications", notificationsRoutes);

app.post("/media", tokenRequired, scopeRequired(["write:media"]), postMedia);

app.get(
  "/search",
  tokenRequired,
  scopeRequired(["read:search"]),
  zValidator(
    "query",
    z.object({
      q: z.string(),
      type: z.enum(["accounts", "hashtags", "statuses"]).optional(),
      resolve: z.enum(["true", "false"]).default("false"),
      following: z.enum(["true", "false"]).default("false"),
      account_id: uuid.optional(),
      limit: z
        .string()
        .regex(/\d+/)
        .default("20")
        .transform((v) => Math.min(40, Math.max(1, Number.parseInt(v, 10)))),
      offset: z
        .string()
        .regex(/\d+/)
        .default("0")
        .transform((v) => Number.parseInt(v, 10)),
    }),
  ),
  async (c) => {
    const logger = getLogger(["hollo", "api", "v2", "search"]);
    const owner = c.get("token").accountOwner;
    if (owner == null) return c.json({ error: "invalid_token" }, 401);
    const query = c.req.valid("query");
    const q = query.q.trim();
    // Check if query is a URL (for post search optimization)
    const isUrlQuery = q.startsWith("http://") || q.startsWith("https://");
    // Check if query is a WebFinger handle (e.g., @user@domain or user@domain)
    const isHandleQuery = HANDLE_PATTERN.test(q);
    // Remote lookup should only be attempted for URL or handle queries
    const isResolvableQuery = isUrlQuery || isHandleQuery;
    const users =
      query.offset < 1
        ? await db.query.accounts.findMany({
            with: { successor: true },
            where: or(
              eq(accounts.iri, q),
              eq(accounts.url, q),
              eq(accounts.handle, q),
              eq(accounts.handle, `@${q}`),
            ),
          })
        : [];
    const statuses =
      query.offset < 1
        ? await db.query.posts.findMany({
            where: and(
              or(eq(posts.iri, q), eq(posts.url, q)),
              isNull(posts.sharingId),
              lte(posts.published, sql`NOW() + INTERVAL '5 minutes'`),
            ),
            with: getPostRelations(owner.id),
          })
        : [];
    const fedCtx = federation.createContext(c.req.raw, undefined);
    const options = {
      documentLoader: await fedCtx.getDocumentLoader({
        username: owner.handle,
      }),
      contextLoader: fedCtx.contextLoader,
    };
    let resolved: Object | null = null;
    if (
      query.resolve === "true" &&
      isResolvableQuery &&
      query.offset < 1 &&
      users.length < 1 &&
      statuses.length < 1
    ) {
      try {
        resolved = await lookupObject(q, options);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        logger.warn("Failed to resolve object: {error}", { error });
      }
    }
    if (query.type == null || query.type === "accounts") {
      const hits = await db.query.accounts.findMany({
        where: ilike(accounts.handle, `%${q}%`),
        limit: query.limit,
        offset: query.offset,
      });
      if (isActor(resolved)) {
        const resolvedAccount = await persistAccount(
          db,
          resolved,
          c.req.url,
          options,
        );
        if (resolvedAccount != null) hits.unshift(resolvedAccount);
      }
      for (const hit of hits) {
        const a = hit as unknown as Account;
        if (users.some((u) => u.id === a.id)) continue;
        users.push({
          ...a,
          successor:
            a.successorId == null
              ? null
              : ((await db.query.accounts.findFirst({
                  where: eq(accounts.id, a.successorId),
                })) ?? null),
        });
      }
    }
    if (query.type == null || query.type === "statuses") {
      // Skip full-text search for URL queries (already handled by cache lookup)
      // Only perform content search for non-URL queries
      if (!isUrlQuery) {
        // Parse search query with advanced operators
        const searchAst = parseSearchQuery(q);
        const searchFilter = searchAst
          ? buildSearchFilter(searchAst)
          : sql`TRUE`;

        let filter = and(searchFilter, isNull(posts.sharingId))!;
        if (query.account_id != null) {
          filter = and(filter, eq(posts.accountId, query.account_id))!;
        }
        const hits = await db.query.posts.findMany({
          where: filter,
          limit: query.limit,
          offset: query.offset,
        });
        const result =
          hits == null || hits.length < 1
            ? []
            : await db.query.posts.findMany({
                where: inArray(
                  posts.id,
                  // biome-ignore lint/complexity/useLiteralKeys: tsc rants about this (TS4111)
                  hits.map((hit) => hit["id"]),
                ),
                with: getPostRelations(owner.id),
                orderBy: [
                  desc(eq(posts.iri, q)),
                  desc(eq(posts.url, q)),
                  desc(posts.published),
                  desc(posts.updated),
                ],
              });
        for (const post of result) {
          if (statuses.some((s) => s.id === post.id)) continue;
          statuses.push(post);
        }
      }
      // Handle resolved object from lookupObject (for URL queries)
      if (resolved instanceof Note || resolved instanceof Article) {
        const resolvedPost = await persistPost(
          db,
          resolved,
          c.req.url,
          options,
        );
        if (resolvedPost != null) {
          // Check if already in statuses from cache lookup
          if (!statuses.some((s) => s.id === resolvedPost.id)) {
            // Fetch with relations
            const fullPost = await db.query.posts.findFirst({
              where: eq(posts.id, resolvedPost.id),
              with: getPostRelations(owner.id),
            });
            if (fullPost != null) statuses.push(fullPost);
          }
        }
      }
    }
    return c.json({
      accounts: users
        .slice(0, query.limit)
        .map((u) => serializeAccount(u, c.req.url)),
      statuses: statuses
        .slice(0, query.limit)
        .map((s) => serializePost(s, owner, c.req.url)),
      hashtags: [],
    });
  },
);

export default app;
