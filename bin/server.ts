import { isIP } from "node:net";

import type { ServerType } from "@hono/node-server";
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

let webServer: ServerType | undefined;

// Start web server if running as web or all node
if (NODE_TYPE === "web" || NODE_TYPE === "all") {
  const { default: app } = await import("../src/index");
  webServer = serve(
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
let stopWorkers: (() => Promise<void>) | undefined;
if (NODE_TYPE === "worker" || NODE_TYPE === "all") {
  const [
    { federation },
    { backgroundJobs, replyScrapes, pollNotifications },
    { itemLeases },
  ] = await Promise.all([
    import("../src/federation"),
    import("../src/federation/federation"),
    import("../src/background/lease"),
  ]);

  // Start the Fedify message queue
  const controller = new AbortController();
  backgroundJobs.setSignal(controller.signal);
  replyScrapes.setSignal(controller.signal);
  pollNotifications.setSignal(controller.signal);
  const queue = federation
    .startQueue(undefined, { signal: controller.signal })
    .catch((error) => {
      console.error("Error starting Fedify queue:", error);
      process.exit(1);
    });

  // Start the workers for background job processing
  const { WEB_ORIGIN } = await import("../src/env");
  const stopRecovery = backgroundJobs.startRecovery(
    federation.createContext(
      new URL(WEB_ORIGIN ?? "http://localhost"),
      undefined,
    ),
    controller.signal,
  );

  stopWorkers = async () => {
    controller.abort();
    await stopRecovery();
    await queue;
    await itemLeases.close();
  };
  console.log("Worker started (Fedify activity/task queues + Job recovery)");
}

// Graceful shutdown handling
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Forced termination releases DB locks; durable unfinished items recover on
  // restart. Do not reuse a slot while its external operation is still alive.
  const deadline = setTimeout(() => process.exit(0), 30_000);
  deadline.unref();
  webServer?.close();
  await stopWorkers?.();
  // The legacy federation queue does not drain its handlers. Keep the main
  // client available until process exit rather than rejecting their queries.
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
