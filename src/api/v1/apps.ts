import { base64 } from "@hexagon/base64";
import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db";
import { type Variables, tokenRequired } from "../../oauth/middleware";
import {
  type NewApplication,
  type Scope,
  applications,
  scopeEnum,
} from "../../schema";

const logger = getLogger(["hollo", "api", "v1", "apps"]);

const app = new Hono<{ Variables: Variables }>();

const applicationSchema = z.object({
  client_name: z.string().optional(),
  redirect_uris: z
    .union([z.string().trim(), z.array(z.string().trim())])
    .transform((v, ctx) => {
      const uris = Array.isArray(v) ? v : v.split(/\s+/g);
      for (const uri of uris) {
        const parsed = z.string().url().safeParse(uri);
        if (parsed.error != null) {
          for (const error of parsed.error.errors) {
            ctx.addIssue(error);
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
            code: z.ZodIssueCode.invalid_enum_value,
            options: scopeEnum.enumValues,
            received: scope,
          });
          return z.NEVER;
        }
        scopes.push(scope as Scope);
      }
      return scopes;
    })
    .optional(),
  website: z.string().url().optional(),
});

app.post("/", async (c) => {
  let form: z.infer<typeof applicationSchema>;
  const contentType = c.req.header("Content-Type");
  if (
    contentType === "application/json" ||
    contentType?.match(/^application\/json\s*;/)
  ) {
    const json = await c.req.json();
    // FIXME: this currently parses without a body
    const result = await applicationSchema.safeParseAsync(json);
    if (!result.success) {
      logger.debug("Invalid request: {error}", { error: result.error });
      return c.json({ error: "Invalid request", zod_error: result.error }, 400);
    }
    form = result.data;
  } else {
    const formData = await c.req.parseBody();
    // FIXME: this currently parses without a body
    const result = await applicationSchema.safeParseAsync(formData);
    if (!result.success) {
      logger.debug("Invalid request: {error}", { error: result.error });
      return c.json({ error: "Invalid request", zod_error: result.error }, 400);
    }
    form = result.data;
  }

  console.log({ form });

  if (form == null) {
    return c.json({ error: "Invalid request" }, 400);
  }
  const clientId = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer,
    true,
  );
  const clientSecret = base64.fromArrayBuffer(
    crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
    true,
  );
  const apps = await db
    .insert(applications)
    .values({
      id: crypto.randomUUID(),
      name: form.client_name ?? "",
      redirectUris: form.redirect_uris ?? [],
      scopes: form.scopes ?? (["read"] satisfies Scope[]),
      website: form.website,
      clientId,
      clientSecret,
      // TODO: Support public clients
      confidential: true,
    } satisfies NewApplication)
    .returning();
  const app = apps[0];
  const result = {
    id: app.id,
    name: app.name,
    website: app.website,
    redirect_uris: app.redirectUris,
    // redirect_uri is deprecated
    redirect_uri: app.redirectUris.join(" "),
    client_id: app.clientId,
    client_secret: app.clientSecret,
    // vapid_key is deprecated, it should be fetched from /api/v1/instance instead
    vapid_key: "",
  };
  logger.debug("Created application: {app}", { app: result });
  return c.json(result);
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
