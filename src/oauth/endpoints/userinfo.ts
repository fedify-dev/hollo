import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../../db";
import { accountOwners } from "../../schema";
import { scopeRequired, tokenRequired, type Variables } from "../middleware";

const app = new Hono<{ Variables: Variables }>();

app.on(
  ["GET", "POST"],
  "/",
  tokenRequired,
  scopeRequired(["profile"]),
  async (c) => {
    const { accountOwnerId } = c.get("token");
    if (accountOwnerId == null) {
      return c.json(
        { error: "This method requires an authenticated user" },
        401,
      );
    }
    const accountOwner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.id, accountOwnerId),
      with: { account: { with: { successor: true } } },
    });
    if (accountOwner == null) {
      return c.json({ error: "invalid_token" }, 401);
    }

    const defaultAvatarUrl = new URL(
      "/image/avatars/original/missing.png",
      c.req.url,
    ).href;

    return c.json({
      iss: new URL("/", c.req.url).href,
      sub: accountOwner.account.iri,
      name: accountOwner.account.name,
      preferredUsername: accountOwner.handle,
      profile: accountOwner.account.url,
      picture: accountOwner.account.avatarUrl ?? defaultAvatarUrl,
    });
  },
);

export default app;
