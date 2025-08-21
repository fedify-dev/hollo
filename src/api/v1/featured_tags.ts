import { zValidator } from "@hono/zod-validator";
import {
  and,
  count,
  type ExtractTablesWithRelations,
  eq,
  max,
  sql,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { z } from "zod";
import db from "../../db";
import { serializeFeaturedTag } from "../../entities/tag";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import type * as schema from "../../schema";
import { featuredTags, posts } from "../../schema";
import { isUuid, type Uuid, uuidv7 } from "../../uuid";

const app = new Hono<{ Variables: Variables }>();

app.get("/", tokenRequired, scopeRequired(["read:accounts"]), async (c) => {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "The access token is invalid." }, 401);
  }
  const tags = await db.query.featuredTags.findMany({
    where: eq(featuredTags.accountOwnerId, owner.id),
  });
  const stats = await getFeaturedTagStats(db, owner.id);
  return c.json(
    tags.map((tag) => serializeFeaturedTag(tag, stats[tag.name], c.req.url)),
  );
});

app.post(
  "/",
  tokenRequired,
  scopeRequired(["write:accounts"]),
  zValidator("json", z.object({ name: z.string().trim().min(1) })),
  async (c) => {
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json({ error: "The access token is invalid." }, 401);
    }
    let name = c.req.valid("json").name;
    if (name.startsWith("#")) name = name.substring(1);
    const result = await db
      .insert(featuredTags)
      .values({
        id: uuidv7(),
        accountOwnerId: owner.id,
        name,
        created: new Date(),
      })
      .returning();
    const stats = await getFeaturedTagStats(db, owner.id);
    return c.json(serializeFeaturedTag(result[0], stats[name], c.req.url), 201);
  },
);

app.delete(
  "/:id",
  tokenRequired,
  scopeRequired(["write:accounts"]),
  async (c) => {
    const featuredTagId = c.req.param("id");
    if (!isUuid(featuredTagId)) {
      return c.json({ error: "Record not found" }, 404);
    }
    const owner = c.get("token").accountOwner;
    if (owner == null) {
      return c.json({ error: "The access token is invalid." }, 401);
    }
    const result = await db
      .delete(featuredTags)
      .where(
        and(
          eq(featuredTags.accountOwnerId, owner.id),
          eq(featuredTags.id, featuredTagId),
        ),
      )
      .returning();
    if (result.length < 1) return c.json({ error: "Record not found" }, 404);
    return c.json({});
  },
);

async function getFeaturedTagStats(
  db: PgDatabase<
    PostgresJsQueryResultHKT,
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >,
  ownerId: Uuid,
): Promise<Record<string, { posts: number; lastPublished: Date | null }>> {
  const result = await db
    .select({
      name: featuredTags.name,
      posts: count(),
      lastPublished: max(posts.published),
    })
    .from(featuredTags)
    .leftJoin(posts, sql`${posts.tags} ? lower('#' || ${featuredTags.name})`)
    .where(
      and(
        eq(featuredTags.accountOwnerId, ownerId),
        eq(posts.visibility, "public"),
      ),
    )
    .groupBy(featuredTags.name);
  const stats: Record<string, { posts: number; lastPublished: Date | null }> =
    {};
  for (const row of result) {
    stats[row.name] = row;
  }
  return stats;
}

export default app;
