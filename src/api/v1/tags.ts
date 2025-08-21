import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { serializeTag } from "../../entities/tag";
import {
  scopeRequired,
  tokenRequired,
  type Variables,
} from "../../oauth/middleware";
import { accountOwners } from "../../schema";

const app = new Hono<{ Variables: Variables }>();

app.use(tokenRequired);

app.get("/:id", (c) => {
  const owner = c.get("token").accountOwner;
  const tag = c.req.param("id");
  return c.json(serializeTag(tag, owner, c.req.url));
});

app.post("/:id/follow", scopeRequired(["write:follows"]), async (c) => {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const tag = c.req.param("id");
  await db.update(accountOwners).set({
    followedTags: sql`array_append(${accountOwners.followedTags}, ${tag})`,
  });
  return c.json({ ...serializeTag(tag, null, c.req.url), following: true });
});

app.post("/:id/unfollow", scopeRequired(["write:follows"]), async (c) => {
  const owner = c.get("token").accountOwner;
  if (owner == null) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const tag = c.req.param("id");
  await db.update(accountOwners).set({
    followedTags: sql`array_remove(${accountOwners.followedTags}, ${tag})`,
  });
  return c.json({ ...serializeTag(tag, null, c.req.url), following: false });
});

export default app;
