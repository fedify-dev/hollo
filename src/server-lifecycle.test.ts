import { describe, expect, it, vi } from "vitest";

import { createServerLifecycle } from "./server-lifecycle";

describe("server lifecycle", () => {
  it("starts sequentially and stops services concurrently exactly once", async () => {
    const draining = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const stopHttp = vi.fn(() => {
      closing.resolve();
      return draining.promise;
    });
    const stopWorkers = vi.fn();
    const lifecycle = createServerLifecycle([
      async (register) => register(stopHttp),
      async (register) => register(stopWorkers),
    ]);
    await lifecycle.start();
    const stop = lifecycle.stop();
    expect(lifecycle.stop()).toBe(stop);
    await closing.promise;
    expect(stopWorkers).toHaveBeenCalledOnce();
    draining.resolve();
    await stop;
    expect(stopHttp).toHaveBeenCalledOnce();
  });

  it("releases an acquired resource after stop interrupts startup", async () => {
    const entered = Promise.withResolvers<void>();
    const acquired = Promise.withResolvers<void>();
    const close = vi.fn();
    const startWorkers = vi.fn(async () => {});
    const lifecycle = createServerLifecycle([
      async (register) => {
        entered.resolve();
        await acquired.promise;
        register(close);
      },
      startWorkers,
    ]);
    const start = lifecycle.start();
    await entered.promise;
    const stop = lifecycle.stop();
    expect(lifecycle.stopping).toBe(true);
    acquired.resolve();
    await Promise.all([start, stop]);
    expect(close).toHaveBeenCalledOnce();
    expect(startWorkers).not.toHaveBeenCalled();
  });

  it("cleans up partial startup after a failure", async () => {
    const close = vi.fn();
    const lifecycle = createServerLifecycle([
      async (register) => {
        register(close);
        throw new Error("startup failed");
      },
    ]);
    await expect(lifecycle.start()).rejects.toThrow("startup failed");
    await lifecycle.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it("waits for other services even if a close callback throws", async () => {
    const drained = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    let stopped = false;
    const lifecycle = createServerLifecycle([
      async (register) => {
        register(() => {
          throw new Error("HTTP close failed");
        });
        register(async () => {
          closing.resolve();
          await drained.promise;
          stopped = true;
        });
      },
    ]);
    await lifecycle.start();
    const stop = lifecycle.stop();
    const failure = stop.catch((error: unknown) => error);
    await closing.promise;
    expect(stopped).toBe(false);
    drained.resolve();
    expect(await failure).toBeInstanceOf(AggregateError);
    expect(stopped).toBe(true);
  });

  it("does not start services after an early stop", async () => {
    const start = vi.fn(async () => {});
    const lifecycle = createServerLifecycle([start]);
    await lifecycle.stop();
    await lifecycle.start();
    expect(start).not.toHaveBeenCalled();
  });
});
