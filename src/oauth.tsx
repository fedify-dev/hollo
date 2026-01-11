import { zValidator } from "@hono/zod-validator";
import { getLogger } from "@logtape/logtape";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "./db.ts";
import { requestBody } from "./helpers.ts";
import { loginRequired } from "./login.ts";
import { OOB_REDIRECT_URI } from "./oauth/constants.ts";
import revokeEndpoint from "./oauth/endpoints/revoke.ts";
import userInfoEndpoint from "./oauth/endpoints/userinfo.ts";
import {
  calculatePKCECodeChallenge,
  createAccessGrant,
  createAccessToken,
  createClientCredential,
} from "./oauth/helpers.ts";
import {
  type ClientAuthenticationVariables,
  clientAuthentication,
} from "./oauth/middleware.ts";
import { scopesSchema } from "./oauth/validators.ts";
import { AuthorizationPage } from "./pages/oauth/authorization.tsx";
import { AuthorizationCodePage } from "./pages/oauth/authorization_code.tsx";
import { accessGrants, accountOwners, applications } from "./schema.ts";
import { uuid } from "./uuid.ts";

const logger = getLogger(["hollo", "oauth"]);

const app = new Hono<{ Variables: ClientAuthenticationVariables }>();

const validatePKCEParameters = (
  form: Partial<{ code_challenge: string; code_challenge_method: string }>,
) => {
  if (
    (form.code_challenge && form.code_challenge_method === undefined) ||
    (form.code_challenge_method && form.code_challenge === undefined)
  ) {
    return {
      error: "invalid_request",
      error_description:
        "Missing code_challenge or code_challenge_method parameters",
    };
  }

  if (
    form.code_challenge_method !== undefined &&
    form.code_challenge_method !== "S256"
  ) {
    return {
      error: "invalid_request",
      error_description:
        "PKCE code_challenge_method must be S256, other methods are not supported",
    };
  }
};

app.route("/userinfo", userInfoEndpoint);
app.route("/revoke", revokeEndpoint);

app.get(
  "/authorize",
  zValidator(
    "query",
    z.object({
      response_type: z.enum(["code"]),
      client_id: z.string(),
      redirect_uri: z.url().optional(),
      scope: scopesSchema.optional(),
      state: z.string().optional(),
      // PKCE: we only support S256 code challenges
      code_challenge: z.string().optional(),
      code_challenge_method: z.string().optional(),
    }),
  ),
  loginRequired,
  async (c) => {
    const data = c.req.valid("query");

    const application = await db.query.applications.findFirst({
      where: eq(applications.clientId, data.client_id),
    });
    if (application == null) {
      return c.json({ error: "invalid_client_id" }, 400);
    }

    const scopes = data.scope ?? ["read"];
    if (scopes.some((s) => !application.scopes.includes(s))) {
      return c.json({ error: "invalid_scope" }, 400);
    }

    // Use the first redirect URI as default if not provided
    const redirectUri = data.redirect_uri ?? application.redirectUris[0];

    if (!application.redirectUris.includes(redirectUri)) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }

    const pkceValidationError = validatePKCEParameters(data);
    if (pkceValidationError) {
      return c.json(pkceValidationError, 400);
    }

    const accountOwners = await db.query.accountOwners.findMany({
      with: { account: true },
    });

    return c.html(
      <AuthorizationPage
        accountOwners={accountOwners}
        application={application}
        redirectUri={redirectUri}
        scopes={scopes}
        state={data.state}
        codeChallenge={data.code_challenge}
        codeChallengeMethod={data.code_challenge_method}
      />,
    );
  },
);

app.post(
  "/authorize",
  loginRequired,
  zValidator(
    "form",
    z.object({
      account_id: uuid,
      application_id: uuid,
      redirect_uri: z.url().optional(),
      scopes: scopesSchema,
      state: z.string().optional(),
      // we only support S256:
      code_challenge: z.string().optional(),
      code_challenge_method: z.string().optional(),
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

    const accountOwner = await db.query.accountOwners.findFirst({
      where: eq(accountOwners.id, form.account_id),
    });
    if (accountOwner == null) {
      return c.notFound();
    }

    const pkceValidationError = validatePKCEParameters(form);
    if (pkceValidationError) {
      return c.json(pkceValidationError, 400);
    }

    if (form.scopes.some((s) => !application.scopes.includes(s))) {
      return c.json({ error: "invalid_scope" }, 400);
    }

    // Use the first redirect URI as default if not provided
    const redirectUri = form.redirect_uri ?? application.redirectUris[0];

    if (!application.redirectUris.includes(redirectUri)) {
      return c.json({ error: "invalid_redirect_uri" }, 400);
    }

    const url = new URL(redirectUri);
    if (form.decision === "deny") {
      url.searchParams.set("error", "access_denied");
      url.searchParams.set(
        "error_description",
        "The resource owner or authorization server denied the request.",
      );
    } else {
      const accessGrant = await createAccessGrant(
        application.id,
        accountOwner.id,
        form.scopes,
        redirectUri,
        form.code_challenge,
        form.code_challenge_method,
      );

      if (redirectUri === OOB_REDIRECT_URI) {
        return c.html(
          <AuthorizationCodePage
            application={application}
            code={accessGrant.code}
          />,
        );
      }

      url.searchParams.set("code", accessGrant.code);

      if (form.state != null) {
        url.searchParams.set("state", form.state);
      }
    }
    return c.redirect(url.href);
  },
);

const INVALID_GRANT_ERROR_DESCRIPTION =
  "The provided authorization code is invalid, expired, revoked, " +
  "does not match the redirection URI used in the authorization " +
  "request, or was issued to another client.";

const INVALID_GRANT_ERROR = {
  error: "invalid_grant",
  error_description: INVALID_GRANT_ERROR_DESCRIPTION,
};

const tokenRequestSchema = z.discriminatedUnion("grant_type", [
  // Use z.object() instead of z.strictObject() to allow clients to send
  // additional parameters like 'redirect_uri' which are commonly sent but not
  // required by RFC 6749 for client_credentials grant type.
  // See also <https://github.com/fedify-dev/hollo/issues/163>:
  z.object({
    grant_type: z.literal("client_credentials"),
    scope: scopesSchema.optional(),
    // client_id and client_secret are present but consumed by the
    // clientAuthentication middleware:
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
  }),
  // Use z.object() instead of z.strictObject() to allow clients to send
  // additional parameters like 'scope' which are commonly sent but not
  // required by RFC 6749 for authorization_code grant type.
  // See also <https://github.com/fedify-dev/hollo/issues/163>:
  z.object({
    grant_type: z.literal("authorization_code"),
    redirect_uri: z.url(),
    code: z.string(),
    code_verifier: z.string().optional(),
    // client_id and client_secret are present but consumed by the
    // clientAuthentication middleware:
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
  }),
]);

app.post("/token", clientAuthentication, async (c) => {
  const client = c.get("client");
  const result = await requestBody(c.req, tokenRequestSchema);

  logger.debug("Token request received for client: {clientId}", {
    clientId: client.clientId,
  });

  if (!result.success) {
    logger.debug("Token request validation failed: {error}", {
      error: result.error.issues,
    });
    if (
      result.error.issues.length === 1 &&
      result.error.issues[0].code === "invalid_union"
    ) {
      return c.json(
        {
          error: "unsupported_grant_type",
          error_description:
            "The authorization grant type is not supported by the authorization server.",
        },
        400,
      );
    }

    return c.json({ error: "invalid_request", zod_error: result.error }, 400);
  }

  const form = result.data;
  if (form.grant_type === "authorization_code") {
    const authorizationCode = form.code;

    return await db
      .transaction(
        async (tx) => {
          const accessGrantResult = await tx
            .select()
            .from(accessGrants)
            .for("update")
            .where(eq(accessGrants.code, authorizationCode))
            .limit(1);

          const accessGrant = accessGrantResult[0];

          if (
            accessGrant === undefined ||
            accessGrant.applicationId !== client.id ||
            accessGrant?.revoked !== null
          ) {
            logger.debug(
              "Invalid grant: code not found or already revoked. " +
                "Code exists: {exists}, application match: {appMatch}, " +
                "revoked: {revoked}",
              {
                exists: accessGrant !== undefined,
                appMatch: accessGrant?.applicationId === client.id,
                revoked: accessGrant?.revoked,
              },
            );
            return c.json(INVALID_GRANT_ERROR, 400);
          }

          if (accessGrant.codeChallenge && accessGrant.codeChallengeMethod) {
            if (
              !form.code_verifier ||
              accessGrant.codeChallengeMethod !== "S256"
            ) {
              return c.json(INVALID_GRANT_ERROR, 400);
            }

            const expectedCodeChallenge = await calculatePKCECodeChallenge(
              form.code_verifier,
            );

            if (expectedCodeChallenge !== accessGrant.codeChallenge) {
              return c.json(INVALID_GRANT_ERROR, 400);
            }
          }

          const notAfter =
            accessGrant.created.valueOf() + accessGrant.expiresIn;
          if (Date.now() > notAfter) {
            return c.json(INVALID_GRANT_ERROR, 400);
          }

          if (accessGrant.redirectUri !== form.redirect_uri) {
            logger.debug(
              "Invalid grant: redirect_uri mismatch. " +
                "Expected: {expected}, received: {received}",
              {
                expected: accessGrant.redirectUri,
                received: form.redirect_uri,
              },
            );
            return c.json(INVALID_GRANT_ERROR, 400);
          }

          // Revoke the access grant:
          await tx
            .update(accessGrants)
            .set({
              revoked: new Date(),
            })
            .where(eq(accessGrants.id, accessGrant.id));

          // create the access token
          const accessToken = await createAccessToken(accessGrant, tx);

          /* v8 ignore start */
          // TODO: This scenario requires an insert to the database failing, so not sure how to test:
          if (accessToken === undefined) {
            return c.json(
              {
                error: "server_error",
                error_description:
                  "We could not issue an access token at this time",
              },
              500,
            );
          }
          /* v8 ignore stop */

          return c.json(
            {
              access_token: accessToken.token,
              token_type: accessToken.type,
              scope: accessToken.scope,
              created_at: accessToken.created,
            },
            200,
          );
        },
        {
          accessMode: "read write",
          isolationLevel: "serializable",
          deferrable: true,
        },
      )
      /* v8 ignore start */
      /* I'm not sure how we'd ever test this scenario */
      .catch((err) => {
        logger.error("An unknown error occurred", err);

        return c.json(
          {
            error: "server_error",
            error_description:
              "We could not issue an access token at this time",
          },
          500,
        );
      });
    /* v8 ignore stop */
  }

  if (form.grant_type === "client_credentials") {
    // Public clients cannot use the client_credentials grant flow
    if (!client.confidential) {
      return c.json(
        {
          error: "unauthorized_client",
          error_description:
            "The authenticated client is not authorized to use this authorization grant type.",
        },
        400,
      );
    }

    if (form.scope?.some((s) => !client.scopes.includes(s))) {
      return c.json(
        {
          error: "invalid_scope",
          error_description:
            "The requested scope is invalid, unknown, or malformed.",
        },
        400,
      );
    }

    const clientCredential = await createClientCredential(client, form.scope);

    return c.json({
      access_token: clientCredential.token,
      token_type: clientCredential.type,
      scope: clientCredential.scope,
      created_at: clientCredential.created,
    });
  }
});

export default app;
