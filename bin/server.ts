import { isIP } from "node:net";

import "../src/logging";
import { checkHandleHostConsistency } from "../src/handle-host-check";
import { configureSentry } from "../src/sentry";
import { createServerLifecycle } from "../src/server-lifecycle";

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

const lifecycle = createServerLifecycle([
  async () => {
    // Warn if HANDLE_HOST disagrees with an existing account.
    await checkHandleHostConsistency();
  },
  async (registerStop) => {
    if (NODE_TYPE === "worker") return;
    // Initialize Sentry before loading the HTTP adapter and application.
    const { createHttpServer, enableFastResponse } =
      await import("../src/http-server");
    enableFastResponse();
    const { default: app } = await import("../src/index");
    if (lifecycle.stopping) return;
    const server = createHttpServer(app.fetch.bind(app), {
      port: PORT,
      hostname: BIND,
      behindProxy: BEHIND_PROXY,
    });
    registerStop(() => server.close());
    await server.ready();
    if (lifecycle.stopping) return;
    const url = new URL(server.url!);
    if (BIND === "localhost") url.hostname = "localhost";
    console.log(`Listening on ${url.href}`);
  },
  async (registerStop) => {
    if (NODE_TYPE === "web") return;
    const [
      { federation },
      { backgroundJobs, replyScrapes, pollNotifications },
      { itemLeases },
      { WEB_ORIGIN },
    ] = await Promise.all([
      import("../src/federation"),
      import("../src/federation/federation"),
      import("../src/background/lease"),
      import("../src/env"),
    ]);
    if (lifecycle.stopping) return;

    const controller = new AbortController();
    let queue: Promise<void> | undefined;
    let stopRecovery: (() => Promise<void>) | undefined;
    // Publish cleanup before any fallible worker initialization.
    registerStop(async () => {
      controller.abort();
      try {
        await stopRecovery?.();
        await queue;
      } finally {
        await itemLeases.close();
      }
    });
    backgroundJobs.setSignal(controller.signal);
    replyScrapes.setSignal(controller.signal);
    pollNotifications.setSignal(controller.signal);
    queue = federation
      .startQueue(undefined, { signal: controller.signal })
      .catch((error) => {
        console.error("Error starting Fedify queue:", error);
        void shutdown(1);
      });
    stopRecovery = backgroundJobs.startRecovery(
      federation.createContext(
        new URL(WEB_ORIGIN ?? "http://localhost"),
        undefined,
      ),
      controller.signal,
    );
    console.log("Worker started (Fedify activity/task queues + Job recovery)");
  },
]);

let exitCode = 0;
let shutdownPromise: Promise<void> | undefined;
/** Stop acquired resources once, forcing exit if cleanup exceeds 30 seconds. */
function shutdown(code = 0): Promise<void> {
  exitCode = Math.max(exitCode, code);
  if (shutdownPromise) return shutdownPromise;
  // Forced termination releases DB locks; durable unfinished items recover on
  // restart. Do not reuse a slot while its external operation is still alive.
  const deadline = setTimeout(() => process.exit(exitCode), 30_000);
  deadline.unref();
  shutdownPromise = lifecycle.stop().then(
    () => {
      // The legacy federation queue does not drain its handlers. Keep the main
      // client available until process exit rather than rejecting their queries.
      process.exit(exitCode);
    },
    (error) => {
      console.error("Error stopping server:", error);
      process.exit(1);
    },
  );
  return shutdownPromise;
}

// Handle signals even during asynchronous startup.
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
try {
  await lifecycle.start();
} catch (error) {
  console.error("Error starting server:", error);
  await shutdown(1);
}
