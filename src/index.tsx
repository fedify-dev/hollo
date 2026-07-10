import { join, relative } from "node:path";

import "./logging";

import { federation } from "@fedify/hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { captureException } from "@sentry/core";
import { type Context, Hono, type Next } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import api from "./api";
import { isRequestAbortError } from "./db-cancel";
import fedi from "./federation";
import image from "./image";
import oauth from "./oauth";
import oauthMetadataEndpoint from "./oauth/endpoints/metadata";
import pages from "./pages";
import proxy from "./proxy";
import { DRIVE_DISK, FS_STORAGE_PATH } from "./storage-config";

const app = new Hono();

app.onError((err, _) => {
  if (isRequestAbortError(err)) return new Response(null, { status: 499 });
  captureException(err);
  // Let HTTPException carry its own status/body through to the client.
  // Middleware like `hono/csrf` signals a refusal by throwing
  // `HTTPException(403, { res })`; rethrowing would surface that as a
  // generic 500 to the caller and defeat the protection.
  if (err instanceof HTTPException) return err.getResponse();
  throw err;
});

if (DRIVE_DISK === "fs") {
  app.use(
    "/assets/*",
    serveStatic({
      root: relative(process.cwd(), FS_STORAGE_PATH!),
      rewriteRequestPath: (path) => path.substring("/assets".length),
    }),
  );
}

app.use(
  "/public/*",
  serveStatic({
    root: relative(process.cwd(), join(import.meta.dirname, "public")),
    rewriteRequestPath: (path) => path.substring("/public".length),
  }),
);

const CorsPolicy = (allowMethods: string[]) =>
  cors({
    origin: "*",
    allowMethods: allowMethods,
  });

// Mastodon's CORS policy also allows `/@:username` and `/users/:username`
// the /api router adds its own cors policy middleware:
app.use("/.well-known/*", CorsPolicy(["GET"]));
app.use("/nodeinfo/*", CorsPolicy(["GET"]));
app.use("/oauth/token", CorsPolicy(["POST"]));
app.use("/oauth/revoke", CorsPolicy(["POST"]));
app.use("/oauth/userinfo", CorsPolicy(["GET", "POST"]));

app.route("/.well-known/oauth-authorization-server", oauthMetadataEndpoint);

async function preventSharedCollectionCaching(c: Context, next: Next) {
  await next();
  c.header("Cache-Control", "private, no-store");
}

app.use(
  "/:handle{@[^/]+}/:id{[-a-f0-9]+}/replies",
  preventSharedCollectionCaching,
);
app.use(
  "/:handle{@[^/]+}/:id{[-a-f0-9]+}/reactions",
  preventSharedCollectionCaching,
);

app.use(federation(fedi, (_) => undefined));

app.route("/", pages);
app.route("/oauth", oauth);
app.route("/api", api);
app.route("/image", image);
app.route("/proxy", proxy);

app.get("/nodeinfo/2.0", (c) => c.redirect("/nodeinfo/2.1"));

export default app;
