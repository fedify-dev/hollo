import { isIP } from "node:net";
import { serve } from "@hono/node-server";
import { behindProxy } from "x-forwarded-fetch";
import app from "../src/index";
import { configureSentry } from "../src/sentry";

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
configureSentry(process.env["SENTRY_DSN"]);

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const BEHIND_PROXY = process.env["BEHIND_PROXY"] === "true";

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const BIND = process.env["BIND"];

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const PORT = Number.parseInt(process.env["PORT"] ?? "3000", 10);

if (!Number.isInteger(PORT)) {
  console.error("Invalid PORT: must be an integer");
  process.exit(1);
}

if (BIND && BIND !== "localhost" && !isIP(BIND)) {
  console.error(
    "Invalid BIND: must be an IP address or localhost, if specified",
  );
  process.exit(1);
}

serve(
  {
    fetch: BEHIND_PROXY
      ? behindProxy(app.fetch.bind(app))
      : app.fetch.bind(app),
    port: PORT,
    hostname: BIND,
  },
  (info) => {
    let host = info.address;
    // We override it here to show localhost instead of what it resolves to:
    if (BIND === "localhost") {
      host = "localhost";
    } else if (info.family === "IPv6") {
      host = `[${info.address}]`;
    }

    console.log(`Listening on http://${host}:${info.port}/`);
  },
);
