import { isIP } from "node:net";
import { serve } from "@hono/node-server";
import { behindProxy } from "x-forwarded-fetch";
import { federation } from "../src/federation";
import { startImportWorker, stopImportWorker } from "../src/import/worker";
import app from "../src/index";
import { configureSentry } from "../src/sentry";

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
configureSentry(process.env["SENTRY_DSN"]);

// biome-ignore lint/complexity/useLiteralKeys: tsc complains about this (TS4111)
const NODE_TYPE = process.env["NODE_TYPE"] ?? "all";

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

if (!["all", "web", "worker"].includes(NODE_TYPE)) {
  console.error(
    'Invalid NODE_TYPE: must be "all", "web", or "worker", if specified',
  );
  process.exit(1);
}

// Start web server if running as web or all node
if (NODE_TYPE === "web" || NODE_TYPE === "all") {
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
}

// Start workers if running as worker or all node
if (NODE_TYPE === "worker" || NODE_TYPE === "all") {
  // Start the Fedify message queue
  const controller = new AbortController();
  federation
    .startQueue(undefined, { signal: controller.signal })
    .catch((error) => {
      console.error("Error starting Fedify queue:", error);
      process.exit(1);
    });

  // Start the import worker for background job processing
  startImportWorker();

  console.log("Worker started (Fedify queue + Import worker)");
}

// Graceful shutdown handling
const shutdown = () => {
  if (NODE_TYPE === "worker" || NODE_TYPE === "all") {
    console.log("Stopping workers...");
    stopImportWorker();
  }
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
