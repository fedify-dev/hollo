import type { MessageQueue, MessageQueueListenOptions } from "@fedify/fedify";
import { expect, it, vi } from "vitest";

import { TaskMessageQueue } from "./queue";

it("bounds actual handlers, survives errors and drains on abort", async () => {
  const controller = new AbortController();
  const messages = [1, 2, 3, 4];
  const source: MessageQueue = {
    async enqueue() {},
    async listen(handler, options: MessageQueueListenOptions = {}) {
      for (const value of messages) await handler(value);
      if (!options.signal?.aborted)
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
    },
  };
  const queue = new TaskMessageQueue(source, 2);
  let running = 0;
  let max = 0;
  const releases: Array<() => void> = [];
  let drained = false;
  const listen = queue
    .listen(
      async () => {
        running++;
        max = Math.max(max, running);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        running--;
        throw new Error("retry enqueue offline");
      },
      { signal: controller.signal },
    )
    .then(() => {
      drained = true;
    });
  await vi.waitFor(() => {
    expect(releases).toHaveLength(2);
  });
  releases[0]();
  await vi.waitFor(() => {
    expect(releases).toHaveLength(3);
  });
  controller.abort();
  expect(drained).toBe(false);
  releases[1]();
  releases[2]();
  await listen;
  expect(max).toBe(2);
  expect(running).toBe(0);
  expect(drained).toBe(true);
});
