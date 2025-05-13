import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { auth } from "hono/utils/basic-auth";
import { db } from "../db.ts";
import {
  type AccessToken,
  type Account,
  type AccountOwner,
  type Application,
  type Scope,
  accessTokens,
  applications,
} from "../schema.ts";

import { z } from "zod";

export type Variables = {
  token: AccessToken & {
    application: Application;
    accountOwner:
      | (AccountOwner & { account: Account & { successor: Account | null } })
      | null;
  };
};

export type ClientAuthenticationVariables = {
  client: Application;
};

type ClientCredentials =
  | {
      authentication: "client_secret_basic" | "client_secret_post";
      client_id: string;
      client_secret: string;
    }
  | {
      authentication: "none";
      client_id: string;
      client_secret: undefined;
    };

const clientCredentialsSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
});

export const clientAuthentication = createMiddleware<{
  Variables: ClientAuthenticationVariables;
}>(async (c, next) => {
  let clientCredentials: ClientCredentials[] = [];

  // client authentication: client_secret_basic
  if (c.req.header("Authorization")?.trim().startsWith("Basic ")) {
    const credentials = auth(c.req.raw);
    if (credentials?.username && credentials.password) {
      clientCredentials.push({
        authentication: "client_secret_basic",
        client_id: credentials.username,
        client_secret: credentials.password,
      });
    }
  }

  // client authentication: client_secret_post
  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const result = await clientCredentialsSchema.safeParse(body);

    if (result.success) {
      clientCredentials.push({
        authentication: "client_secret_post",
        client_id: result.data.client_id,
        client_secret: result.data.client_secret,
      });
    }
  }

  // client authentication: none
  const client_id_param = c.req.query("client_id");
  const client_secret_param = c.req.query("client_secret");
  if (client_id_param && client_secret_param === undefined) {
    clientCredentials.push({
      authentication: "none",
      client_id: client_id_param,
      client_secret: undefined,
    });
  }

  if (clientCredentials.length > 1) {
    return c.json(
      {
        error: "invalid_request",
        error_description:
          "The request includes includes multiple credentials or utilizes more than one mechanism for authenticating the client",
      },
      400,
    );
  }

  if (clientCredentials.length === 0) {
    return c.json(
      {
        error: "invalid_client",
        error_description:
          "Client authentication failed due to no client authentication included, or unsupported authentication method",
      },
      401,
    );
  }

  let client: Application | undefined;
  if (
    clientCredentials[0].authentication === "client_secret_basic" ||
    clientCredentials[0].authentication === "client_secret_post"
  ) {
    client = await db.query.applications.findFirst({
      where: and(
        eq(applications.clientId, clientCredentials[0].client_id),
        eq(applications.clientSecret, clientCredentials[0].client_secret),
        eq(applications.confidential, true),
      ),
    });
  } else {
    // client authentication method is none, which only works for non-confidential clients:
    client = await db.query.applications.findFirst({
      where: and(
        eq(applications.clientId, clientCredentials[0].client_id),
        eq(applications.confidential, false),
      ),
    });
  }

  if (!client) {
    return c.json(
      {
        error: "invalid_client",
        error_description:
          "Client authentication failed due to unknown client, " +
          "no client authentication included, or unsupported authentication " +
          "method.",
      },
      401,
    );
  }

  c.set("client", client);
  await next();
});

export const tokenRequired = createMiddleware<{ Variables: Variables }>(
  async (c, next) => {
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
  },
);

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
