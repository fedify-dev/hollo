import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { randomBytes, requestBody } from "../../helpers";
import { tokenRequired, type Variables } from "../../oauth/middleware";
import {
  applications,
  type NewApplication,
  type Scope,
  scopeEnum,
} from "../../schema";

const logger = getLogger(["hollo", "api", "v1", "apps"]);

const app = new Hono<{ Variables: Variables }>();

const applicationSchema = z
  .object({
    client_name: z.string().optional(),
    redirect_uris: z
      .union([z.string().trim(), z.array(z.string().trim())])
      .transform((v, ctx) => {
        const uris = Array.isArray(v) ? v : v.split(/\s+/g);
        for (const uri of uris) {
          const parsed = z.url().safeParse(uri);
          if (parsed.error != null) {
            for (const issue of parsed.error.issues) {
              ctx.addIssue({ ...issue });
            }
            return z.NEVER;
          }
        }
        return uris;
      })
      .optional(),
    scopes: z
      .string()
      .trim()
      .transform((v, ctx) => {
        const scopes: Scope[] = [];
        for (const scope of v.split(/\s+/g)) {
          if (!scopeEnum.enumValues.includes(scope as Scope)) {
            ctx.addIssue({
              code: z.ZodIssueCode.invalid_value,
              values: scopeEnum.enumValues,
              received: scope,
            });
            return z.NEVER;
          }
          scopes.push(scope as Scope);
        }
        return scopes;
      })
      .optional(),
    website: z.url().optional(),
  })
  .strict();

app.post("/", async (c) => {
  const result = await requestBody(c.req, applicationSchema);

  if (!result.success) {
    logger.debug("Invalid request: {error}", { error: result.error.issues });
    return c.json({ error: "invalid_request", zod_error: result.error }, 422);
  }

  const form = result.data;

  const clientId = randomBytes(16);
  const clientSecret = randomBytes(32);

  const uniqueScopes = [
    ...new Set(form.scopes ?? (["read"] satisfies Scope[])),
  ];

  const apps = await db
    .insert(applications)
    .values({
      id: crypto.randomUUID(),
      name: form.client_name ?? "",
      redirectUris: form.redirect_uris ?? [],
      scopes: uniqueScopes,
      website: form.website,
      clientId,
      clientSecret,
      // TODO: Support public clients
      confidential: true,
    } satisfies NewApplication)
    .returning();

  // FIXME: theoretically we could fail to insert the application, in which case
  // `app` would be undefined?
  const app = apps[0];

  const credentialApplication = {
    id: app.id,
    name: app.name,
    website: app.website,
    redirect_uris: app.redirectUris,
    // redirect_uri is deprecated
    redirect_uri: app.redirectUris.join(" "),
    client_id: app.clientId,
    client_secret: app.clientSecret,
    // This is a placeholder for Application Client Secrets potentially expiring:
    client_secret_expires_at: 0,
    // vapid_key is deprecated, it should be fetched from /api/v1/instance instead
    vapid_key: "",
  };

  logger.debug("Created application: {app}", { app: credentialApplication });
  return c.json(credentialApplication);
});

app.get("/verify_credentials", tokenRequired, async (c) => {
  const token = c.get("token");
  const app = token.application;
  return c.json({
    id: app.id,
    name: app.name,
    website: app.website,
    scopes: app.scopes,
    redirect_uris: app.redirectUris,
    redirect_uri: app.redirectUris.join(" "),
  });
});

export default app;
