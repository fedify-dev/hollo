import type {
  MessageQueue,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["hollo", "tasks"]);

// Unlike ParallelMessageQueue, this keeps failed promises out of the capacity
// calculation and waits for actual handlers when the listener stops.
export class TaskMessageQueue implements MessageQueue {
  readonly atomicEnqueueMany = false;
  constructor(
    readonly queue: MessageQueue,
    readonly concurrency = 4,
  ) {}

  enqueue(message: unknown, options?: MessageQueueEnqueueOptions) {
    return this.queue.enqueue(message, options);
  }

  getDepth() {
    return this.queue.getDepth!();
  }

  async listen(
    handler: (message: unknown) => void | Promise<void>,
    options: MessageQueueListenOptions = {},
  ) {
    const running = new Set<Promise<void>>();
    try {
      await this.queue.listen(async (message: unknown) => {
        while (running.size >= this.concurrency) await Promise.race(running);
        if (options.signal?.aborted) return;
        const work = Promise.resolve()
          .then(() => handler(message))
          .catch((error: unknown) => {
            // PostgreSQL has already removed the message. Durable item state
            // recovers even a failed Fedify retry enqueue.
            logger.error("Task dispatch failed; recovery will retry: {error}", {
              error,
            });
          })
          .finally(() => {
            running.delete(work);
          });
        running.add(work);
      }, options);
    } finally {
      await Promise.all(running);
    }
  }
}
