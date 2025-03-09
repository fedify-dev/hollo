import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import db from "../db.ts";
import {
  type AccessToken,
  type Account,
  type AccountOwner,
  type Application,
  type Scope,
  accessTokens,
} from "../schema.ts";

export type Variables = {
  token: AccessToken & {
    application: Application;
    accountOwner:
      | (AccountOwner & { account: Account & { successor: Account | null } })
      | null;
  };
};

export const tokenRequired = createMiddleware(async (c, next) => {
  const authorization = c.req.header("Authorization");
  if (authorization == null) return c.json({ error: "unauthorized" }, 401);
  const match = /^(?:bearer)\s+(.+)$/i.exec(authorization);
  if (match == null) return c.json({ error: "unauthorized" }, 401);
  const token = match[1];

  const accessToken = await db.query.accessTokens.findFirst({
    where: eq(accessTokens.code, token),
    with: {
      accountOwner: { with: { account: { with: { successor: true } } } },
      application: true,
    },
  });

  if (accessToken === undefined) {
    return c.json({ error: "invalid_token" }, 401);
  }

  c.set("token", accessToken);
  await next();
});

export function scopeRequired(scopes: Scope[]) {
  return createMiddleware(async (c, next) => {
    const token = c.get("token");
    if (
      !scopes.some(
        (s) =>
          token.scopes.includes(s) ||
          token.scopes.includes(s.replace(/:[^:]+$/, "")) ||
          ([
            "read:blocks",
            "write:blocks",
            "read:follows",
            "write:follows",
            "read:mutes",
            "write:mutes",
          ].includes(s) &&
            token.scopes.includes("follow")),
      )
    ) {
      return c.json({ error: "insufficient_scope" }, 403);
    }
    await next();
  });
}
