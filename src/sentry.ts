import { getLogger } from "@logtape/logtape";
import { getGlobalScope, setCurrentClient } from "@sentry/core";
import { init, initOpenTelemetry, type NodeClient } from "@sentry/node";

const logger = getLogger(["hollo", "sentry"]);

export function configureSentry(dsn?: string): NodeClient | undefined {
  if (dsn == null || dsn.trim() === "") {
    logger.debug("SENTRY_DSN is not provided. Sentry will not be initialized.");
    return;
  }

  const client = init({
    dsn,
    tracesSampleRate: 1.0,
  });
  if (client == null) {
    logger.error("Failed to initialize Sentry.");
    return;
  }
  getGlobalScope().setClient(client);
  setCurrentClient(client);
  logger.debug("Sentry initialized.");

  initOpenTelemetry(client);
  return client;
}
