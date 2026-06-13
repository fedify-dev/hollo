import { isIP } from "node:net";

import { serve } from "@hono/node-server";
import { behindProxy } from "x-forwarded-fetch";

import "../src/logging";
import { checkHandleHostConsistency } from "../src/handle-host-check";
import { configureSentry } from "../src/sentry";

// oxlint-disable-next-line typescript/dot-notation
configureSentry(process.env["SENTRY_DSN"]);

// oxlint-disable-next-line typescript/dot-notation
const NODE_TYPE = process.env["NODE_TYPE"] ?? "all";

// oxlint-disable-next-line typescript/dot-notation
const BEHIND_PROXY = process.env["BEHIND_PROXY"] === "true";

// oxlint-disable-next-line typescript/dot-notation
const BIND = process.env["BIND"];

// oxlint-disable-next-line typescript/dot-notation
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

// Warn if the configured HANDLE_HOST disagrees with an existing account.
await checkHandleHostConsistency();

// Start web server if running as web or all node
if (NODE_TYPE === "web" || NODE_TYPE === "all") {
  const { default: app } = await import("../src/index");
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
let stopWorkers: (() => void) | undefined;
if (NODE_TYPE === "worker" || NODE_TYPE === "all") {
  const [
    { federation },
    { startImportWorker, stopImportWorker },
    { startCleanupWorker, stopCleanupWorker },
    { startRemoteReplyScrapeWorker, stopRemoteReplyScrapeWorker },
    { startPollNotificationWorker, stopPollNotificationWorker },
  ] = await Promise.all([
    import("../src/federation"),
    import("../src/import/worker"),
    import("../src/cleanup/worker"),
    import("../src/federation/replies-worker"),
    import("../src/poll-notification-worker"),
  ]);
  stopWorkers = () => {
    stopImportWorker();
    stopCleanupWorker();
    stopRemoteReplyScrapeWorker();
    stopPollNotificationWorker();
  };

  // Start the Fedify message queue
  const controller = new AbortController();
  federation
    .startQueue(undefined, { signal: controller.signal })
    .catch((error) => {
      console.error("Error starting Fedify queue:", error);
      process.exit(1);
    });

  // Start the workers for background job processing
  startImportWorker();
  startCleanupWorker();
  startRemoteReplyScrapeWorker();
  startPollNotificationWorker();

  console.log(
    "Worker started (Fedify queue + Import worker + Cleanup worker + Remote reply scrape worker + Poll notification worker)",
  );
}

// Graceful shutdown handling
const shutdown = () => {
  if (NODE_TYPE === "worker" || NODE_TYPE === "all") {
    console.log("Stopping workers...");
    stopWorkers?.();
  }
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
