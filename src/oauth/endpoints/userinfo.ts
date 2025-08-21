import { Hono } from "hono";
import { scopeRequired, tokenRequired, type Variables } from "../middleware";

const app = new Hono<{ Variables: Variables }>();

app.on(["GET", "POST"], "/", tokenRequired, scopeRequired(["profile"]), (c) => {
  const accountOwner = c.get("token").accountOwner;

  if (!accountOwner) {
    return c.json(
      {
        error: "This method requires an authenticated user",
      },
      401,
    );
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
});

export default app;
