import { getLogger } from "@logtape/logtape";

import { materializeExpiredPollNotifications } from "./notification";

const logger = getLogger(["hollo", "poll-notification-worker"]);

const POLL_INTERVAL_MS = 60_000;
const BATCH_SIZE = 100;

let isRunning = false;
let isPolling = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startPollNotificationWorker(): void {
  if (isRunning) {
    logger.warn("Poll notification worker is already running");
    return;
  }

  isRunning = true;
  logger.info("Starting poll notification worker");

  pollAndProcess().catch((error) => {
    logger.error("Error in initial poll notification worker poll: {error}", {
      error,
    });
  });

  pollTimer = setInterval(() => {
    pollAndProcess().catch((error) => {
      logger.error("Error in poll notification worker poll: {error}", {
        error,
      });
    });
  }, POLL_INTERVAL_MS);
}

export function stopPollNotificationWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
  logger.info("Poll notification worker stopped");
}

async function pollAndProcess(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const count = await materializeExpiredPollNotifications({
      limit: BATCH_SIZE,
    });
    if (count > 0) {
      logger.info("Materialized {count} poll notifications", { count });
    }
  } finally {
    isPolling = false;
  }
}
