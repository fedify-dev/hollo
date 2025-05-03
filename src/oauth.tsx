import { zValidator } from "@hono/zod-validator";
import { eq, not } from "drizzle-orm";
import { escape } from "es-toolkit";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { Layout } from "./components/Layout";
import { db } from "./db";
import { HOLLO_RELAY_ACTOR_ID } from "./entities/relay";
import { loginRequired } from "./login";
import {
  createAccessToken,
  createAuthorizationCode,
  createClientCredential,
} from "./oauth/helpers";
import type { Variables } from "./oauth/middleware";
import { scopesSchema } from "./oauth/validators";
import {
  type Account,
  type AccountOwner,
  type Application,
  type Scope,
  accessTokens,
  accountOwners as accountOwnersTable,
  applications,
  scopeEnum,
} from "./schema";
import { renderCustomEmojis } from "./text";
import { uuid } from "./uuid";

const app = new Hono<{ Variables: Variables }>();

app.get(
  "/authorize",
  zValidator(
    "query",
    z.object({
      response_type: z.enum(["code"]),
      client_id: z.string(),
      redirect_uri: z.string().url(),
      scope: scopesSchema.optional(),
      state: z.string().optional(),
    }),
  ),
  loginRequired,
  async (c) => {
    const data = c.req.valid("query");
    const application = await db.query.applications.findFirst({
      where: eq(applications.clientId, data.client_id),
    });
    if (application == null) return c.json({ error: "invalid_client_id" }, 400);
    const scopes = data.scope ?? ["read"];
    if (scopes.some((s) => !application.scopes.includes(s))) {
      return c.json({ error: "invalid_scope" }, 400);
    }
    if (!application.redirectUris.includes(data.redirect_uri)) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }
    const accountOwners = await db.query.accountOwners.findMany({
      where: not(eq(accountOwnersTable.id, HOLLO_RELAY_ACTOR_ID)),
      with: { account: true },
    });
    return c.html(
      <AuthorizationPage
        accountOwners={accountOwners}
        application={application}
        redirectUri={data.redirect_uri}
        scopes={scopes}
        state={data.state}
      />,
    );
  },
);

interface AuthorizationPageProps {
  accountOwners: (AccountOwner & { account: Account })[];
  application: Application;
  redirectUri: string;
  scopes: Scope[];
  state?: string;
}

function AuthorizationPage(props: AuthorizationPageProps) {
  return (
    <Layout title={`Hollo: Authorize ${props.application.name}`}>
      <hgroup>
        <h1>Authorize {props.application.name}</h1>
        <p>Do you want to authorize this application to access your account?</p>
      </hgroup>
      <p>It allows the application to:</p>
      <ul>
        {props.scopes.map((scope) => (
          <li key={scope}>
            <code>{scope}</code>
          </li>
        ))}
      </ul>
      <form action="/oauth/authorize" method="post">
        <p>Choose an account to authorize:</p>
        {props.accountOwners.map((accountOwner, i) => {
          const accountName = renderCustomEmojis(
            escape(accountOwner.account.name),
            accountOwner.account.emojis,
          );
          return (
            <label>
              <input
                type="radio"
                name="account_id"
                value={accountOwner.id}
                checked={i === 0}
              />
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: xss protected */}
              <strong dangerouslySetInnerHTML={{ __html: accountName }} />
              <p style="margin-left: 1.75em; margin-top: 0.25em;">
                <small>{accountOwner.account.handle}</small>
              </p>
            </label>
          );
        })}
        <input
          type="hidden"
          name="application_id"
          value={props.application.id}
        />
        <input type="hidden" name="redirect_uri" value={props.redirectUri} />
        <input type="hidden" name="scopes" value={props.scopes.join(" ")} />
        {props.state != null && (
          <input type="hidden" name="state" value={props.state} />
        )}
        <div role="group">
          {props.redirectUri !== "urn:ietf:wg:oauth:2.0:oob" && (
            <button
              type="submit"
              class="secondary"
              name="decision"
              value="deny"
            >
              Deny
            </button>
          )}
          <button type="submit" name="decision" value="allow">
            Allow
          </button>
        </div>
      </form>
    </Layout>
  );
}

app.post(
  "/authorize",
  loginRequired,
  zValidator(
    "form",
    z.object({
      account_id: uuid,
      application_id: uuid,
      redirect_uri: z.string().url(),
      scopes: scopesSchema,
      state: z.string().optional(),
      decision: z.enum(["allow", "deny"]),
    }),
  ),
  async (c) => {
    const form = c.req.valid("form");
    const application = await db.query.applications.findFirst({
      where: eq(applications.id, form.application_id),
    });
    if (application == null) {
      return c.notFound();
    }

    if (form.scopes.some((s) => !application.scopes.includes(s))) {
      return c.json({ error: "invalid_scope" }, 400);
    }

    if (!application.redirectUris.includes(form.redirect_uri)) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }

    const url = new URL(form.redirect_uri);
    if (form.decision === "deny") {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set(
        "error_description",
        "The resource owner or authorization server denied the request.",
      );
    } else {
      const code = await createAuthorizationCode(
        application.id,
        form.account_id,
        form.scopes,
      );

      if (form.redirect_uri === "urn:ietf:wg:oauth:2.0:oob") {
        return c.html(
          <AuthorizationCodePage application={application} code={code} />,
        );
      }

      url.searchParams.set("code", code);

      if (form.state != null) {
        url.searchParams.set("state", form.state);
      }
    }
    return c.redirect(url.href);
  },
);

interface AuthorizationCodePageProps {
  application: Application;
  code: string;
}

function AuthorizationCodePage(props: AuthorizationCodePageProps) {
  return (
    <Layout title={"Hollo: Authorization Code"}>
      <hgroup>
        <h1>Authorization Code</h1>
        <p>Here is your authorization code.</p>
      </hgroup>
      <pre>{props.code}</pre>
      <p>
        Copy this code and paste it into <em>{props.application.name}</em>.
      </p>
    </Layout>
  );
}

const tokenRequestSchema = z.object({
  grant_type: z.enum(["authorization_code", "client_credentials"]),
  code: z.string().optional(),
  client_id: z.string(),
  client_secret: z.string(),
  redirect_uri: z.string().url().optional(),
  scope: scopesSchema.optional(),
});

app.post("/token", cors(), async (c) => {
  let form: z.infer<typeof tokenRequestSchema>;
  const contentType = c.req.header("Content-Type");
  if (
    contentType === "application/json" ||
    contentType?.match(/^application\/json\s*;/)
  ) {
    const json = await c.req.json();
    const result = await tokenRequestSchema.safeParseAsync(json);
    if (!result.success) {
      return c.json({ error: "Invalid request", zod_error: result.error }, 400);
    }
    form = result.data;
  } else {
    const formData = await c.req.parseBody();
    const result = await tokenRequestSchema.safeParseAsync(formData);
    if (!result.success) {
      return c.json({ error: "Invalid request", zod_error: result.error }, 400);
    }
    form = result.data;
  }

  const application = await db.query.applications.findFirst({
    where: eq(applications.clientId, form.client_id),
  });
  if (application == null || application.clientSecret !== form.client_secret) {
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
  if (form.scope?.some((s) => !application.scopes.includes(s))) {
    return c.json(
      {
        error: "invalid_scope",
        error_description:
          "The requested scope is invalid, unknown, or malformed.",
      },
      400,
    );
  }
  if (form.grant_type === "authorization_code") {
    if (form.code == null) {
      return c.json(
        {
          error: "invalid_request",
          error_description: "The authorization code is required.",
        },
        400,
      );
    }

    if (!form.redirect_uri) {
      return c.json(
        {
          error: "invalid_request",
          error_description:
            "The authorization code grant flow requires a redirect URI.",
        },
        400,
      );
    }

    const token = await db.query.accessTokens.findFirst({
      where: eq(accessTokens.code, form.code),
      with: { application: true },
    });

    if (token == null || token.grant_type !== "authorization_code") {
      return c.json(
        {
          error: "invalid_grant",
          error_description:
            "The provided authorization code is invalid, expired, revoked, " +
            "does not match the redirection URI used in the authorization " +
            "request, or was issued to another client.",
        },
        400,
      );
    }

    // Validate that the redirect URI given is registered with the Application
    // (since we"re not tracking Access Grants which would bind the redirect URI
    // to the code)
    if (!token.application.redirectUris.includes(form.redirect_uri)) {
      return c.json(
        {
          error: "invalid_request",
          error_description: "Invalid redirect URI.",
        },
        400,
      );
    }

    const accessToken = await createAccessToken(token);

    return c.json({
      access_token: accessToken.token,
      token_type: accessToken.type,
      scope: accessToken.scope,
      created_at: accessToken.createdAt,
    });
  }

  if (form.grant_type === "client_credentials") {
    const clientCredential = await createClientCredential(
      application,
      form.scope,
    );

    return c.json({
      access_token: clientCredential.token,
      token_type: clientCredential.type,
      scope: clientCredential.scope,
      created_at: clientCredential.createdAt,
    });
  }

  return c.json(
    {
      error: "unsupported_grant_type",
      error_description:
        "The authorization grant type is not supported by the authorization server.",
    },
    400,
  );
});

export async function oauthAuthorizationServer(c: Context) {
  const url = new URL(c.req.url);

  return c.json({
    issuer: new URL("/", url).href,
    authorization_endpoint: new URL("/oauth/authorize", url).href,
    token_endpoint: new URL("/oauth/token", url).href,
    // Not yet supported by Hollo:
    // "revocation_endpoint": "",
    scopes_supported: scopeEnum.enumValues,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      // Not supported by Hollo:
      // "client_secret_basic",
    ],
    app_registration_endpoint: new URL("/api/v1/apps", url).href,
  });
}

export default app;
