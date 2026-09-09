import { describe, expect, it, vi } from "vitest";

import { createRepliesQueryCache } from "./replies-cache";

describe("replies query cache", () => {
  it("shares pending root reads without retaining results or missing roots", async () => {
    const cache = createRepliesQueryCache<number | null>();
    const gate = Promise.withResolvers<number | null>();
    const load = vi.fn(() => gate.promise);
    const first = cache.loadRoot("a", load);
    const second = cache.loadRoot("a", load);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    gate.resolve(null);
    await expect(first).resolves.toBeNull();
    await expect(cache.loadRoot("a", async () => 1)).resolves.toBe(1);
    await expect(cache.loadRoot("a", async () => 2)).resolves.toBe(2);
  });

  it("bounds pending root keys without evicting an active read", async () => {
    const cache = createRepliesQueryCache<number>({ capacity: 1 });
    const gate = Promise.withResolvers<number>();
    const first = cache.loadRoot("a", () => gate.promise);
    await expect(cache.loadRoot("b", async () => 2)).resolves.toBe(2);
    await expect(cache.loadRoot("b", async () => 3)).resolves.toBe(3);
    expect(cache.loadRoot("a", async () => 4)).toBe(first);
    gate.resolve(1);
    await expect(first).resolves.toBe(1);
  });

  it("shares counts and expires zero results without extending their lifetime", async () => {
    let now = 0;
    const cache = createRepliesQueryCache({ now: () => now });
    const gate = Promise.withResolvers<number>();
    const first = cache.loadCount("a", () => gate.promise);
    expect(cache.loadCount("a", async () => 99)).toBe(first);
    gate.resolve(0);
    await expect(first).resolves.toBe(0);
    now = 4999;
    await expect(cache.loadCount("a", async () => 1)).resolves.toBe(0);
    now = 5000;
    await expect(cache.loadCount("a", async () => 2)).resolves.toBe(2);
    await expect(cache.loadCount("b", async () => 3)).resolves.toBe(3);
  });

  it("does not give a slow count a fresh TTL on completion", async () => {
    let now = 0;
    const cache = createRepliesQueryCache({ now: () => now });
    const gate = Promise.withResolvers<number>();
    const first = cache.loadCount("a", () => gate.promise);
    now = 6000;
    expect(cache.loadCount("a", async () => 99)).toBe(first);
    gate.resolve(1);
    await expect(first).resolves.toBe(1);
    await expect(cache.loadCount("a", async () => 2)).resolves.toBe(2);
  });

  it("evicts by count launch time even after replacing an expired key", async () => {
    let now = 0;
    const cache = createRepliesQueryCache({ capacity: 2, now: () => now });
    await expect(cache.loadCount("a", async () => 1)).resolves.toBe(1);
    now = 1000;
    await expect(cache.loadCount("b", async () => 2)).resolves.toBe(2);
    now = 5000;
    await expect(cache.loadCount("a", async () => 3)).resolves.toBe(3);
    await expect(cache.loadCount("c", async () => 4)).resolves.toBe(4);
    await expect(cache.loadCount("a", async () => 99)).resolves.toBe(3);
    await expect(cache.loadCount("b", async () => 5)).resolves.toBe(5);
  });

  it("bypasses new count keys when capacity is occupied by pending reads", async () => {
    const cache = createRepliesQueryCache({ capacity: 1 });
    const gate = Promise.withResolvers<number>();
    const first = cache.loadCount("a", () => gate.promise);
    await expect(cache.loadCount("b", async () => 2)).resolves.toBe(2);
    await expect(cache.loadCount("b", async () => 3)).resolves.toBe(3);
    expect(cache.loadCount("a", async () => 99)).toBe(first);
    gate.resolve(1);
    await expect(first).resolves.toBe(1);
    await expect(cache.loadCount("b", async () => 4)).resolves.toBe(4);
    await expect(cache.loadCount("b", async () => 99)).resolves.toBe(4);
  });

  it.each(["loadRoot", "loadCount"] as const)(
    "%s shares failures and permits a later retry",
    async (method) => {
      const cache = createRepliesQueryCache<number>();
      const error = new Error("database failure");
      const first = cache[method]("a", () => {
        throw error;
      });
      expect(cache[method]("a", async () => 99)).toBe(first);
      await expect(first).rejects.toBe(error);
      await expect(cache[method]("a", async () => 1)).resolves.toBe(1);
    },
  );

  it.each(["loadRoot", "loadCount"] as const)(
    "%s does not let a pre-clear completion overwrite a newer read",
    async (method) => {
      const cache = createRepliesQueryCache<number>();
      const old = Promise.withResolvers<number>();
      const fresh = Promise.withResolvers<number>();
      const first = cache[method]("a", () => old.promise);
      cache.clear();
      const second = cache[method]("a", () => fresh.promise);
      old.resolve(1);
      await expect(first).resolves.toBe(1);
      expect(cache[method]("a", async () => 99)).toBe(second);
      fresh.resolve(2);
      await expect(second).resolves.toBe(2);
    },
  );
});
