import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../../db";
import { serializeTag } from "../../entities/tag";
import {
  scopeRequired,
  tokenRequired,
  withAccountOwner,
  type AccountOwnerVariables,
} from "../../oauth/middleware";
import { accountOwners } from "../../schema";

const app = new Hono<{ Variables: AccountOwnerVariables }>();

app.use(tokenRequired);

// GET /:id is "OAuth: Public, or User token" per Mastodon API spec — client
// credentials tokens (no accountOwnerId) are valid and return following: false.
app.get("/:id", async (c) => {
  const { accountOwnerId } = c.get("token");
  const tag = c.req.param("id");
  if (accountOwnerId == null) {
    return c.json(serializeTag(tag, null, c.req.url));
  }
  const owner = await db.query.accountOwners.findFirst({
    where: eq(accountOwners.id, accountOwnerId),
  });
  return c.json(serializeTag(tag, owner, c.req.url));
});

app.post(
  "/:id/follow",
  scopeRequired(["write:follows"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");
    const tag = c.req.param("id");
    await db
      .update(accountOwners)
      .set({
        followedTags: sql`array_append(${accountOwners.followedTags}, ${tag})`,
      })
      .where(eq(accountOwners.id, owner.id));
    return c.json({ ...serializeTag(tag, null, c.req.url), following: true });
  },
);

app.post(
  "/:id/unfollow",
  scopeRequired(["write:follows"]),
  withAccountOwner,
  async (c) => {
    const owner = c.get("accountOwner");
    const tag = c.req.param("id");
    await db
      .update(accountOwners)
      .set({
        followedTags: sql`array_remove(${accountOwners.followedTags}, ${tag})`,
      })
      .where(eq(accountOwners.id, owner.id));
    return c.json({ ...serializeTag(tag, null, c.req.url), following: false });
  },
);

export default app;
